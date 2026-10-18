/**
 * Reads one printed text line with PaddleOCR's PP-OCRv6 rec tiny model
 * (models/, Apache-2.0, see NOTICE) on onnxruntime-web (WASM).
 *
 * Recognition only: the caller gives the line's box. The box is cropped,
 * resized to the model's 48 px height (bilinear, aspect kept), turned into
 * BGR planes normalised to v / 127.5 - 1 and zero padded on the right to at
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
// the model input: normalised BGR planes (CHW), dims [1, 3, 48, W]. The roi
// is rounded to whole pixels by its two ends, so a box ending on the frame
// edge stays inside, and must lie inside the frame.
async function prepare(raw, roi) {
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
	roi = box;
	const scaledW = Math.max(1, Math.ceil((HEIGHT * roi.width) / roi.height));
	// the crop is its own pipeline: chained with resize, sharp does not keep
	// extract first
	const cut = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
		.extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const { data, info } = await sharp(cut.data, { raw: cut.info })
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

// { text, confidences, cropMs, inferMs }: one confidence in 0..1 (3
// decimals) per character; cropMs is prepare, inferMs the model run and
// the decode, ms with one decimal (waiting for the model to load is in
// neither)
async function recognise(raw, roi) {
	const { ort, session, dict } = await loadModel();
	const ms = (from) => Math.round((performance.now() - from) * 10) / 10;
	let started = performance.now();
	const input = await prepare(raw, roi);
	const cropMs = ms(started);
	started = performance.now();
	const out = await session.run({
		[session.inputNames[0]]: new ort.Tensor("float32", input.data, input.dims),
	});
	const t = out[session.outputNames[0]];
	const { text, conf } = greedy(t.data, t.dims[1], t.dims[2], dict);
	const inferMs = ms(started);
	return { text, confidences: conf.map((p) => Math.round(p * 1000) / 1000), cropMs, inferMs };
}

module.exports = { loadModel, recognise, loadDict, greedy, prepare, MODEL_PATH, DICT_PATH };
