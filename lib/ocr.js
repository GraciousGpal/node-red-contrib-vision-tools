/**
 * Reads printed text lines with PaddleOCR's PP-OCRv6 rec tiny model
 * (models/, Apache-2.0, see NOTICE) on onnxruntime-web (WASM).
 *
 * Recognition only: the caller gives the text's box. The model reads one
 * line per image, so a box over several lines is split into horizontal
 * bands by its row ink profile (see lineBands) and each band is read on
 * its own, so a single line is cut to its rows too; a box with no band is
 * read whole, and a box without contrast is not read. The box is cropped,
 * turned clockwise by rotate degrees (0, 90, 180 or 270: text running top
 * to bottom reads with 270, bottom to top with 90); each band is resized
 * to the model's 48 px height (bilinear, aspect kept), turned into BGR
 * planes normalised to v / 127.5 - 1 and zero padded on the right to at
 * least 320 wide, as PaddleOCR does; the output is greedy CTC decoded.
 *
 * The model's output has dict + 2 classes: 0 is the CTC blank, 1..n the
 * dictionary's lines, n + 1 a space.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const MODEL_PATH = path.join(__dirname, "..", "models", "PP-OCRv6_rec_tiny.onnx");
const DICT_PATH = path.join(__dirname, "..", "models", "ppocrv6_tiny_dict.txt");

const HEIGHT = 48;
const MIN_WIDTH = 320;

// chars[c - 1] is class c's character; the space is appended last
function loadDict(file) {
	const chars = fs.readFileSync(file, "utf8").split(/\r?\n/);
	if (chars[chars.length - 1] === "") chars.pop();
	chars.push(" ");
	const index = new Map();
	chars.forEach((c, i) => {
		if (!index.has(c)) index.set(c, i + 1);
	});
	return { chars, index, classes: chars.length + 1 };
}

// probs: T x C, row-major, already softmaxed by the model. A character is
// kept where the best class changes to a non-blank; its confidence is that
// step's probability.
function greedy(probs, T, C, dict) {
	if (C !== dict.classes) throw new Error(`the model has ${C} classes, the dictionary gives ${dict.classes}`);
	let text = "";
	const conf = [];
	let prev = 0;
	for (let t = 0; t < T; t++) {
		let best = 0;
		let p = probs[t * C];
		for (let c = 1; c < C; c++) {
			if (probs[t * C + c] > p) {
				p = probs[t * C + c];
				best = c;
			}
		}
		if (best !== 0 && best !== prev) {
			text += dict.chars[best - 1];
			conf.push(p);
		}
		prev = best;
	}
	return { text, conf };
}

// raw: { data, width, height, channels } uint8 HWC; roi in pixels. Returns
// the crop turned upright as { data, info } (sharp raw, channels as raw's).
// The roi is rounded to whole pixels by its two ends, so a box ending on
// the frame edge stays inside, and must lie inside the frame. rotate turns
// the crop clockwise.
async function orient(raw, roi, rotate = 0) {
	if (![0, 90, 180, 270].includes(rotate)) throw new Error(`rotate ${JSON.stringify(rotate)} is not 0, 90, 180 or 270`);
	// Number() first: strings from a message would concatenate in x + width
	const [rx, ry, rw, rh] = [roi.x, roi.y, roi.width, roi.height].map(Number);
	const x = Math.round(rx);
	const y = Math.round(ry);
	const box = { x, y, width: Math.round(rx + rw) - x, height: Math.round(ry + rh) - y };
	if (
		!(box.width >= 1 && box.height >= 1 && box.x >= 0 && box.y >= 0) ||
		box.x + box.width > raw.width || box.y + box.height > raw.height
	) {
		throw new Error(`roi x ${roi.x}, y ${roi.y}, width ${roi.width}, height ${roi.height} is empty or leaves the ${raw.width}x${raw.height} frame`);
	}
	// the crop is its own pipeline: chained with rotate, sharp does not
	// keep extract first
	const cut = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
		.extract({ left: box.x, top: box.y, width: box.width, height: box.height })
		.raw()
		.toBuffer({ resolveWithObject: true });
	return sharp(cut.data, { raw: cut.info }).rotate(rotate).raw().toBuffer({ resolveWithObject: true });
}

// { y0, y1, x0, x1 } (ends exclusive) of an upright crop, one per text
// line, top to bottom; null when the crop's grey spans under 32 levels
// (nothing printed there). Grey is the mean of the first three channels
// (the one channel of grey); ink is darker than the midpoint of the crop's
// darkest and lightest grey, or lighter when more than half the pixels are
// dark (light text on a dark ground).
//
// Bands are found counting every column. Only when that gives exactly one
// band are they found again without the columns in the outer 15% of the
// width on either side inked in over 25% of the rows (box edges, vertical
// rules, even a box around only part of the crop: their ink in every row
// joins the lines into one band; the threshold is low because this runs
// only after the lines did join, and counts only when they come apart); if that
// gives two or more bands they are used, those columns left out of the
// row counts and the ink-column trim, else the first band stands. So the
// stem of a leading or trailing I, 1 or l in a tight box stays text, and
// columns in the middle 70% always count. A row inked over 90% of the
// counted columns is a horizontal rule and is not text. Not handled: a
// vertical line in the middle 70% (a table rule between two lines) inks
// every row it crosses, so the lines it joins become one band and read as
// one line, usually wrongly; draw a box per cell instead. A row is text
// when its ink is at least 2 pixels and 0.25% of the ink's width
// (leftmost to rightmost inked column), so the stem of a lone "1" counts
// under a long line. Runs of text rows are bands; two bands closer than
// 15% of the median band height merge (an i dot 3 px over its stems joins
// them; descenders 7 px over the next line's ascenders at 1.15 leading do
// not), and bands under 6 px go. Each band then gains max(2, round(0.15
// x its height)) above and below (a band cut tight to its rows costs the
// model confidence; on a real label 30% broke a line where 1-4 px read
// every one), at most half the gap to the next band, so bands never
// overlap, and never past the crop. x0..x1 spans the band's inked columns
// and 2 px on each side (wider read lower on the test lines): a short
// line in a wide box is otherwise mostly paper at the model's input and
// can read nothing.
function lineBands({ data, info }) {
	const { width, height, channels: ch } = info;
	const grey = new Float32Array(width * height);
	let lo = 255;
	let hi = 0;
	for (let i = 0; i < grey.length; i++) {
		const p = i * ch;
		const g = ch >= 3 ? (data[p] + data[p + 1] + data[p + 2]) / 3 : data[p];
		grey[i] = g;
		if (g < lo) lo = g;
		if (g > hi) hi = g;
	}
	if (hi - lo < 32) return null;
	const mid = (lo + hi) / 2;
	let dark = 0;
	for (let i = 0; i < grey.length; i++) if (grey[i] < mid) dark++;
	const light = dark > grey.length / 2;
	const ink = new Uint8Array(grey.length);
	for (let i = 0; i < grey.length; i++) ink[i] = (light ? grey[i] > mid : grey[i] < mid) ? 1 : 0;
	const colInk = new Uint32Array(width);
	for (let i = 0; i < ink.length; i++) colInk[i % width] += ink[i];
	const all = Array.from({ length: width }, (_, x) => x);
	const bandsA = bandsOver(all);
	if (bandsA.length !== 1) return bandsA;
	const edgeRule = (x) => (x < 0.15 * width || x >= 0.85 * width) && colInk[x] > 0.25 * height;
	if (!all.some(edgeRule)) return bandsA;
	const bandsB = bandsOver(all.filter((x) => !edgeRule(x)));
	return bandsB.length >= 2 ? bandsB : bandsA;

	// the bands found counting only the columns cols
	function bandsOver(cols) {
		let left = width;
		let right = 0;
		for (const x of cols) {
			if (colInk[x]) {
				left = Math.min(left, x);
				right = x + 1;
			}
		}
		const minInk = Math.max(2, 0.0025 * (right - left));
		const runs = [];
		for (let y = 0; y < height; y++) {
			let n = 0;
			for (const x of cols) n += ink[y * width + x];
			if (n >= minInk && n <= 0.9 * cols.length) {
				const last = runs[runs.length - 1];
				if (last && last.y1 === y) last.y1 = y + 1;
				else runs.push({ y0: y, y1: y + 1 });
			}
		}
		if (!runs.length) return [];
		const sorted = runs.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
		const median = sorted[sorted.length >> 1];
		const merged = [{ ...runs[0] }];
		for (const b of runs.slice(1)) {
			const last = merged[merged.length - 1];
			if (b.y0 - last.y1 < 0.15 * median) last.y1 = b.y1;
			else merged.push({ ...b });
		}
		const bands = merged.filter((b) => b.y1 - b.y0 >= 6);
		return bands.map((b, i) => {
			let x0 = width;
			let x1 = 0;
			for (let y = b.y0; y < b.y1; y++) {
				for (const x of cols) {
					if (ink[y * width + x]) {
						if (x < x0) x0 = x;
						if (x >= x1) x1 = x + 1;
					}
				}
			}
			const pad = Math.max(2, Math.round(0.15 * (b.y1 - b.y0)));
			const above = i ? Math.floor((b.y0 - bands[i - 1].y1) / 2) : b.y0;
			const below = i < bands.length - 1 ? Math.floor((bands[i + 1].y0 - b.y1) / 2) : height - b.y1;
			return {
				y0: b.y0 - Math.min(pad, above),
				y1: b.y1 + Math.min(pad, below),
				x0: Math.max(0, x0 - 2),
				x1: Math.min(width, x1 + 2),
			};
		});
	}
}

// oriented: orient's result; band { y0, y1, x0, x1 } of it, or none for
// all of it. Returns the model input: the rows resized to 48 px high (bilinear,
// aspect kept), normalised BGR planes (CHW), dims [1, 3, 48, W].
async function toTensor(oriented, band) {
	const w = band ? band.x1 - band.x0 : oriented.info.width;
	const h = band ? band.y1 - band.y0 : oriented.info.height;
	const scaledW = Math.max(1, Math.ceil((HEIGHT * w) / h));
	let pipeline = sharp(oriented.data, { raw: oriented.info });
	if (band) pipeline = pipeline.extract({ left: band.x0, top: band.y0, width: w, height: h });
	const { data, info } = await pipeline
		.resize({ width: scaledW, height: HEIGHT, fit: "fill", kernel: "linear" })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const W = Math.max(info.width, MIN_WIDTH);
	const plane = HEIGHT * W;
	const chw = new Float32Array(3 * plane);
	const ch = info.channels;
	// grey repeats its one channel in all three planes
	const r = 0;
	const g = ch >= 3 ? 1 : 0;
	const b = ch >= 3 ? 2 : 0;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < info.width; x++) {
			const p = (y * info.width + x) * ch;
			const o = y * W + x;
			// BGR, as PaddleOCR reads with cv2
			chw[o] = data[p + b] / 127.5 - 1;
			chw[plane + o] = data[p + g] / 127.5 - 1;
			chw[2 * plane + o] = data[p + r] / 127.5 - 1;
		}
	}
	return { data: chw, dims: [1, 3, HEIGHT, W] };
}

// the model input for the whole roi read as one line
async function prepare(raw, roi, rotate = 0) {
	return toTensor(await orient(raw, roi, rotate));
}

let loading = null;

// once per process; one WASM thread so no worker outlives a test run
function loadModel() {
	if (!loading) {
		loading = (async () => {
			const ort = require("onnxruntime-web");
			ort.env.wasm.numThreads = 1;
			const session = await ort.InferenceSession.create(fs.readFileSync(MODEL_PATH));
			return { ort, session, dict: loadDict(DICT_PATH) };
		})();
		loading.catch(() => {
			loading = null;
		});
	}
	return loading;
}

// { text, confidences, lines, cropMs, inferMs }. lines: one { text,
// confidences, y0, y1 } per band that read something, top to bottom, y0..y1
// (end exclusive) in the upright crop's rows; a box with no band is read
// whole, as one line over all its rows; a crop without contrast (see
// lineBands) is not read: text "", no lines, inferMs 0. text is the
// lines' texts joined by "\n"; confidences has one entry in 0..1 (3
// decimals) per character of text, each "\n" carrying 1. cropMs is the
// crop, the turn and the ink profile, inferMs every band's resize, model
// run and decode, ms with one decimal (waiting for the model to load is
// in neither). opts.rotate: see orient.
async function recognise(raw, roi, opts) {
	// a numeric string from a message reads as its number
	const rotate = Number((opts && opts.rotate) ?? 0);
	const { ort, session, dict } = await loadModel();
	const ms = (from) => Math.round((performance.now() - from) * 10) / 10;
	let started = performance.now();
	const oriented = await orient(raw, roi, rotate);
	let bands = lineBands(oriented);
	if (bands === null) return { text: "", confidences: [], lines: [], cropMs: ms(started), inferMs: 0 };
	const whole = bands.length === 0;
	if (whole) bands = [{ y0: 0, y1: oriented.info.height }];
	const cropMs = ms(started);
	started = performance.now();
	const lines = [];
	for (const band of bands) {
		const input = await toTensor(oriented, whole ? null : band);
		const out = await session.run({
			[session.inputNames[0]]: new ort.Tensor("float32", input.data, input.dims),
		});
		const t = out[session.outputNames[0]];
		const { text, conf } = greedy(t.data, t.dims[1], t.dims[2], dict);
		if (text) lines.push({ text, confidences: conf.map((p) => Math.round(p * 1000) / 1000), y0: band.y0, y1: band.y1 });
	}
	const inferMs = ms(started);
	return {
		text: lines.map((l) => l.text).join("\n"),
		confidences: lines.flatMap((l, i) => (i ? [1, ...l.confidences] : l.confidences)),
		lines,
		cropMs,
		inferMs,
	};
}

module.exports = { loadModel, recognise, loadDict, greedy, prepare, lineBands, MODEL_PATH, DICT_PATH };
