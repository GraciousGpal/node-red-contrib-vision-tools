/**
 * Accuracy and stopwatch for reading printed text lines with a PP-OCR
 * recognition model, on the two runtimes a text-inspect node would use:
 *
 *   ort    onnxruntime-web (WASM), the fallback that runs everywhere
 *   cvjs   OpenCV 5's dnn module, through @techstark/opencv-js (WASM): the
 *          same dnn code the opencv5 addon would carry natively, so it
 *          shows whether OpenCV imports the model and agrees with ort
 *
 * Outside `test/` and not named `*.test.js` on purpose: its numbers move
 * with the machine, and the frames and models are not in the repo.
 *
 * Only recognition runs: each line's box is given, as a node's drawn or
 * profile region would be. Per region: crop, rotate upright, resize to the
 * model's 48 px height (bilinear, aspect kept, padded with zeros to at
 * least 320 wide, as PaddleOCR does), BGR, (v / 255 - 0.5) / 0.5, run, then
 * greedy CTC decode. Besides the free read it scores the expected text
 * directly: `nll` is -log P(expected | image) for the whole line, in nats,
 * from the CTC forward pass (not per character: averaged over a long line,
 * one wrong character would hardly move it). `mutNll` is the same for the expected text with one
 * character changed (the middle digit + 1, else the middle letter + 1); the
 * gap between the two is how well a verify check would separate a right
 * print from a one-character misprint.
 *
 * Regions file: a JSON array of
 *   { "label", "x", "y", "width", "height", "rotate": 0|90|180|270, "expected" }
 * in frame px, `rotate` turning the crop upright (clockwise).
 *
 * Models (Apache-2.0, from RapidOCR's ONNX exports of PaddleOCR):
 *   https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile.onnx
 *     dict: .../paddle/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile/ppocrv5_en_dict.txt
 *   .../onnx/PP-OCRv6/rec/PP-OCRv6_rec_tiny.onnx    dict: .../paddle/PP-OCRv6/rec/PP-OCRv6_rec_tiny/ppocrv6_tiny_dict.txt
 *   .../onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx   dict: .../paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt
 * The output has dict + 2 classes: 0 is the CTC blank, 1..n the dict's
 * lines, n + 1 a space.
 *
 * Usage:
 *   node bench/ocr-bench.js --dir frames/ --regions lines.json --model en_PP-OCRv5_rec_mobile.onnx --dict ppocrv5_en_dict.txt
 *   node bench/ocr-bench.js --image frame.jpg --regions lines.json --model m.onnx --dict d.txt --engines ort --threads 1 --repeat 10
 *   node bench/ocr-bench.js --dir frames/ --regions lines.json --model m.onnx --dict d.txt --dump crops/ --json out.json
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const sharp = require("sharp");

// an option's value is the next token unless that is another option
function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	const v = i >= 0 ? process.argv[i + 1] : undefined;
	return v !== undefined && !v.startsWith("--") ? v : fallback;
}

const IMAGE = arg("image", null);
const DIR = arg("dir", null);
const FRAMES = Number(arg("frames", 0));
const REPEAT = Number(arg("repeat", IMAGE ? 10 : 1));
const REGIONS = arg("regions", null);
const MODEL = arg("model", null);
const DICT = arg("dict", null);
const ENGINES = arg("engines", "ort,cvjs").split(",").map((e) => e.trim()).filter(Boolean);
// onnxruntime-web's WASM threads; 0 lets it choose
const THREADS = Number(arg("threads", 0));
const JSON_OUT = arg("json", null);
const DUMP = arg("dump", null);

const HEIGHT = 48;
const MIN_WIDTH = 320;

if (
	(!IMAGE && !DIR) || (IMAGE && DIR) || !REGIONS || !MODEL || !DICT || !(REPEAT >= 1) ||
	!ENGINES.length || ENGINES.some((e) => e !== "ort" && e !== "cvjs")
) {
	console.error("usage: node bench/ocr-bench.js (--image <file> | --dir <folder>) --regions <json> --model <onnx> --dict <txt> [--engines ort,cvjs] [--threads N] [--frames N] [--repeat N] [--dump <folder>] [--json out.json]");
	process.exit(2);
}

function frameFiles() {
	if (IMAGE) return [path.resolve(IMAGE)];
	const all = fs
		.readdirSync(DIR)
		.filter((f) => /\.(jpe?g|png)$/i.test(f))
		.sort()
		.map((f) => path.join(DIR, f));
	return FRAMES > 0 ? all.slice(0, FRAMES) : all;
}

// nearest-rank: the value at rank ceil(q x n)
function quantile(values, q) {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}

// ---- the dictionary and the expected text as class indices -------------

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

// null when a character is not in the dictionary
function encode(text, dict) {
	const out = [];
	for (const c of text) {
		const i = dict.index.get(c);
		if (i === undefined) return null;
		out.push(i);
	}
	return out;
}

// one character changed: the middle digit + 1, else the middle letter + 1
function mutate(text) {
	const at = (re) => [...text].map((c, i) => (re.test(c) ? i : -1)).filter((i) => i >= 0);
	const digits = at(/[0-9]/);
	const pick = digits.length ? digits : at(/[A-Za-z]/);
	if (!pick.length) return null;
	const i = pick[Math.floor(pick.length / 2)];
	const c = text[i];
	const next = /[0-9]/.test(c)
		? String((Number(c) + 1) % 10)
		: c === "z" ? "a" : c === "Z" ? "A" : String.fromCharCode(c.charCodeAt(0) + 1);
	return text.slice(0, i) + next + text.slice(i + 1);
}

// ---- CTC ----------------------------------------------------------------

// probs: T x C, row-major, already softmaxed by the model
function greedy(probs, T, C, dict) {
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

// -log P(labels | probs) by the CTC forward pass in log space; Infinity
// when the line has too few steps for the labels
function ctcNll(probs, T, C, labels) {
	const L = labels.length;
	if (!L) return Infinity;
	const S = 2 * L + 1;
	const ext = new Int32Array(S); // blank, l1, blank, l2, ..., blank
	for (let i = 0; i < L; i++) ext[2 * i + 1] = labels[i];
	const logp = (t, c) => Math.log(Math.max(probs[t * C + c], 1e-30));
	const lse = (a, b) => (a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b))));
	let alpha = new Float64Array(S).fill(-Infinity);
	alpha[0] = logp(0, ext[0]);
	if (S > 1) alpha[1] = logp(0, ext[1]);
	for (let t = 1; t < T; t++) {
		const next = new Float64Array(S).fill(-Infinity);
		for (let s = 0; s < S; s++) {
			let a = alpha[s];
			if (s > 0) a = lse(a, alpha[s - 1]);
			if (s > 1 && ext[s] !== 0 && ext[s] !== ext[s - 2]) a = lse(a, alpha[s - 2]);
			if (a !== -Infinity) next[s] = a + logp(t, ext[s]);
		}
		alpha = next;
	}
	const total = lse(alpha[S - 1], S > 1 ? alpha[S - 2] : -Infinity);
	return total === -Infinity ? Infinity : -total;
}

// Levenshtein distance, for the character error rate
function editDistance(a, b) {
	const A = [...a];
	const B = [...b];
	let row = Array.from({ length: B.length + 1 }, (_, j) => j);
	for (let i = 1; i <= A.length; i++) {
		const next = [i];
		for (let j = 1; j <= B.length; j++) {
			next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
		}
		row = next;
	}
	return row[B.length];
}

// ---- preprocessing ------------------------------------------------------

// the region upright at HEIGHT px, as normalised BGR planes (CHW), zero
// padded on the right to at least MIN_WIDTH
async function prepare(frame, region) {
	const turned = region.rotate === 90 || region.rotate === 270;
	const w = turned ? region.height : region.width;
	const h = turned ? region.width : region.height;
	const scaledW = Math.max(1, Math.ceil((HEIGHT * w) / h));
	// the crop is its own pipeline: chained with rotate and resize, sharp
	// does not keep extract first
	const cut = await sharp(frame.data, { raw: frame.info })
		.extract({ left: region.x, top: region.y, width: region.width, height: region.height })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const { data, info } = await sharp(cut.data, { raw: cut.info })
		.rotate(region.rotate || 0)
		.resize({ width: scaledW, height: HEIGHT, fit: "fill", kernel: "linear" })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const W = Math.max(scaledW, MIN_WIDTH);
	const plane = HEIGHT * W;
	const chw = new Float32Array(3 * plane);
	const ch = info.channels;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < info.width; x++) {
			const p = (y * info.width + x) * ch;
			const o = y * W + x;
			// BGR, as PaddleOCR reads with cv2
			chw[o] = data[p + 2] / 127.5 - 1;
			chw[plane + o] = data[p + 1] / 127.5 - 1;
			chw[2 * plane + o] = data[p] / 127.5 - 1;
		}
	}
	return { chw, W, crop: { data, info } };
}

// ---- engines ------------------------------------------------------------

async function ortEngine(modelBytes) {
	const ort = require("onnxruntime-web");
	if (THREADS > 0) ort.env.wasm.numThreads = THREADS;
	const session = await ort.InferenceSession.create(modelBytes);
	const input = session.inputNames[0];
	const output = session.outputNames[0];
	return {
		name: "ort",
		threads: ort.env.wasm.numThreads,
		async run(chw, W) {
			const out = await session.run({ [input]: new ort.Tensor("float32", chw, [1, 3, HEIGHT, W]) });
			const t = out[output];
			return { probs: t.data, T: t.dims[1], C: t.dims[2] };
		},
	};
}

async function cvjsEngine(modelBytes) {
	const cvjs = require("../lib/cvjs.js");
	const cv = await cvjs.ready();
	cv.FS_createDataFile("/", "ocr-bench.onnx", new Uint8Array(modelBytes), true, false, false);
	const net = cv.readNetFromONNX("/ocr-bench.onnx");
	return {
		name: "cvjs",
		threads: 1,
		async run(chw, W) {
			// blobFromImage of an HWC float Mat, scale 1 and mean 0, is the
			// NCHW tensor itself
			const plane = HEIGHT * W;
			const hwc = new Float32Array(3 * plane);
			for (let i = 0; i < plane; i++) {
				hwc[3 * i] = chw[i];
				hwc[3 * i + 1] = chw[plane + i];
				hwc[3 * i + 2] = chw[2 * plane + i];
			}
			const img = cv.matFromArray(HEIGHT, W, cv.CV_32FC3, hwc);
			const blob = cv.blobFromImage(img, 1, new cv.Size(W, HEIGHT), new cv.Scalar(0, 0, 0, 0), false, false);
			let out;
			try {
				net.setInput(blob);
				out = net.forward();
				const C = out.matSize[out.matSize.length - 1];
				const probs = Float32Array.from(out.data32F);
				return { probs, T: probs.length / C, C };
			} finally {
				img.delete();
				blob.delete();
				if (out) out.delete();
			}
		},
	};
}

// ---- main ---------------------------------------------------------------

async function main() {
	const regions = JSON.parse(fs.readFileSync(REGIONS, "utf8"));
	const dict = loadDict(DICT);
	const modelBytes = fs.readFileSync(MODEL);
	for (const r of regions) {
		r.labels = encode(r.expected, dict);
		r.mutant = mutate(r.expected);
		r.mutantLabels = r.mutant === null ? null : encode(r.mutant, dict);
		if (r.labels === null) console.warn(`${r.label}: expected text has characters outside the dictionary`);
	}
	if (DUMP) fs.mkdirSync(DUMP, { recursive: true });

	const engines = [];
	for (const name of ENGINES) {
		const t0 = performance.now();
		try {
			const e = await (name === "ort" ? ortEngine : cvjsEngine)(modelBytes);
			e.loadMs = performance.now() - t0;
			engines.push(e);
		} catch (err) {
			console.error(`${name}: could not load the model: ${err && err.message ? err.message : err}`);
		}
	}
	if (!engines.length) process.exit(1);

	const files = frameFiles();
	const rows = []; // one per frame x region x engine
	const prepMs = [];
	const agreement = []; // per frame x region, when two engines ran
	let warmed = false;

	for (const file of files) {
		const frame = await sharp(file).raw().toBuffer({ resolveWithObject: true });
		for (const r of regions) {
			let pre;
			for (let k = 0; k < REPEAT; k++) {
				const t0 = performance.now();
				pre = await prepare(frame, r);
				prepMs.push(performance.now() - t0);
			}
			if (DUMP) {
				await sharp(pre.crop.data, { raw: pre.crop.info })
					.png()
					.toFile(path.join(DUMP, `${path.parse(file).name}-${r.label}.png`));
			}
			const outs = [];
			for (const e of engines) {
				// one untimed run, so the first frame does not carry the warm-up
				if (!warmed) await e.run(pre.chw, pre.W);
				const ms = [];
				let res;
				for (let k = 0; k < REPEAT; k++) {
					const t0 = performance.now();
					res = await e.run(pre.chw, pre.W);
					ms.push(performance.now() - t0);
				}
				if (res.C !== dict.classes) throw new Error(`${MODEL} has ${res.C} classes, ${DICT} gives ${dict.classes}`);
				const read = greedy(res.probs, res.T, res.C, dict);
				const row = {
					frame: path.basename(file),
					region: r.label,
					engine: e.name,
					text: read.text,
					exact: read.text === r.expected,
					// spaces are what the model is least sure of; a verify step may ignore them
					exactNoSpace: read.text.replace(/\s+/g, "") === r.expected.replace(/\s+/g, ""),
					cer: editDistance(read.text, r.expected) / Math.max(1, [...r.expected].length),
					// PaddleOCR's confidence; CTC can split one character over two
					// steps, so this runs low where the read is certain
					minConf: read.conf.length ? Math.min(...read.conf) : 0,
					meanConf: read.conf.length ? read.conf.reduce((a, b) => a + b, 0) / read.conf.length : 0,
					nll: r.labels ? ctcNll(res.probs, res.T, res.C, r.labels) : null,
					mutNll: r.mutantLabels ? ctcNll(res.probs, res.T, res.C, r.mutantLabels) : null,
					inferMs: quantile(ms, 0.5),
					width: pre.W,
					steps: res.T,
				};
				rows.push(row);
				outs.push({ row, probs: res.probs });
			}
			warmed = true;
			if (outs.length === 2) {
				let maxDiff = 0;
				const a = outs[0].probs;
				const b = outs[1].probs;
				for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
				agreement.push({ sameText: outs[0].row.text === outs[1].row.text, maxProbDiff: maxDiff });
			}
		}
	}

	// ---- report -----------------------------------------------------------

	const fmt = (v, d = 1) => (v === null || v === undefined ? "-" : Number.isFinite(v) ? v.toFixed(d) : "inf");
	console.log(`${files.length} frame(s) x ${regions.length} region(s), model ${path.basename(MODEL)} (${dict.classes} classes), repeat ${REPEAT}`);
	for (const e of engines) console.log(`  ${e.name}: model load ${fmt(e.loadMs)} ms, threads ${e.threads || "default"}`);
	console.log(`prep (crop, rotate, resize, normalise): ${fmt(quantile(prepMs, 0.5))}/${fmt(quantile(prepMs, 0.95))} ms median/p95 per line`);
	console.log("");
	console.log("engine  region            exact  noSpace  meanCER  minConf  nll p50/max  mutNll min  gap min  inferMs p50/p95");
	const report = { frames: files.length, model: path.basename(MODEL), classes: dict.classes, repeat: REPEAT, engines: {}, agreement: null, misreads: [] };
	for (const e of engines) {
		report.engines[e.name] = { loadMs: e.loadMs, threads: e.threads, regions: {} };
		for (const r of regions) {
			const rs = rows.filter((x) => x.engine === e.name && x.region === r.label);
			const n = rs.length;
			const nll = rs.map((x) => x.nll).filter((v) => v !== null);
			const mut = rs.map((x) => x.mutNll).filter((v) => v !== null);
			const gaps = rs.filter((x) => x.nll !== null && x.mutNll !== null).map((x) => x.mutNll - x.nll);
			const s = {
				n,
				exact: rs.filter((x) => x.exact).length,
				exactNoSpace: rs.filter((x) => x.exactNoSpace).length,
				meanCer: rs.reduce((a, x) => a + x.cer, 0) / n,
				minConf: Math.min(...rs.map((x) => x.minConf)),
				nllP50: quantile(nll, 0.5),
				nllMax: nll.length ? Math.max(...nll) : null,
				mutNllMin: mut.length ? Math.min(...mut) : null,
				gapMin: gaps.length ? Math.min(...gaps) : null,
				inferP50: quantile(rs.map((x) => x.inferMs), 0.5),
				inferP95: quantile(rs.map((x) => x.inferMs), 0.95),
			};
			report.engines[e.name].regions[r.label] = s;
			console.log(
				`${e.name.padEnd(6)}  ${r.label.padEnd(16)}  ${`${s.exact}/${n}`.padStart(5)}  ${`${s.exactNoSpace}/${n}`.padStart(7)}  ${fmt(s.meanCer, 4).padStart(7)}  ${fmt(s.minConf, 3).padStart(7)}  ${`${fmt(s.nllP50, 3)}/${fmt(s.nllMax, 3)}`.padStart(11)}  ${fmt(s.mutNllMin, 3).padStart(10)}  ${fmt(s.gapMin, 3).padStart(7)}  ${`${fmt(s.inferP50)}/${fmt(s.inferP95)}`.padStart(15)}`,
			);
		}
	}
	if (agreement.length) {
		report.agreement = {
			pairs: agreement.length,
			sameText: agreement.filter((a) => a.sameText).length,
			maxProbDiff: Math.max(...agreement.map((a) => a.maxProbDiff)),
		};
		console.log(`\nengines agree on the text in ${report.agreement.sameText}/${report.agreement.pairs} lines; largest probability difference ${report.agreement.maxProbDiff.toExponential(2)}`);
	}
	const misreads = rows.filter((x) => !x.exact);
	report.misreads = misreads.map(({ frame, region, engine, text, minConf, nll }) => ({ frame, region, engine, text, minConf, nll }));
	if (misreads.length) {
		console.log(`\nmisreads (first 15 of ${misreads.length}):`);
		for (const m of misreads.slice(0, 15)) console.log(`  ${m.engine} ${m.region} ${m.frame}: "${m.text}" minConf ${fmt(m.minConf, 3)} nll ${fmt(m.nll, 3)}`);
	}
	console.log("\nnll: -log P(expected) for the line, nats, from the CTC forward pass; mutNll the same with one character changed; gap = mutNll - nll per line, its minimum is the worst-case margin a verify threshold has");
	if (JSON_OUT) {
		fs.writeFileSync(JSON_OUT, JSON.stringify({ ...report, rows }, null, 1));
		console.log(`wrote ${JSON_OUT}`);
	}
}

main().catch((err) => {
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
});
