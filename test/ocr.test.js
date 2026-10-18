/**
 * PP-OCR line recognition (lib/ocr.js): the dictionary, the greedy CTC
 * decode and the preprocessing on their own, then one whole read of a
 * rendered line through the shipped model, and the packaging that ships it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const ocr = require("../lib/ocr.js");

test("loadDict: class 0 is the CTC blank, the last class a space", () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-")), "d.txt");
	fs.writeFileSync(file, "a\r\nb\nc\n");
	const dict = ocr.loadDict(file);
	assert.deepEqual(dict.chars, ["a", "b", "c", " "]);
	assert.equal(dict.classes, 5);
	// class c reads dict.chars[c - 1]: nothing for 0, the space for the last
	assert.equal(dict.index.get("a"), 1);
	assert.equal(dict.index.get(" "), dict.classes - 1);
	assert.equal([...dict.index.values()].includes(0), false);
});

test("greedy collapses repeats and blanks, one confidence per character", () => {
	const dict = { chars: ["a", "b", " "], classes: 4 };
	const C = 4; // blank, a, b, space
	const row = (c, p) => {
		const r = new Array(C).fill((1 - p) / (C - 1));
		r[c] = p;
		return r;
	};
	// a a _ a b b _ _ space b : "aa" split by a blank stays two a's
	const rows = [row(1, 0.9), row(1, 0.8), row(0, 0.7), row(1, 0.6), row(2, 0.5), row(2, 0.95), row(0, 0.9), row(0, 0.9), row(3, 0.4), row(2, 0.85)];
	const probs = Float32Array.from(rows.flat());
	const { text, conf } = ocr.greedy(probs, rows.length, C, dict);
	assert.equal(text, "aab b");
	assert.equal(conf.length, text.length);
	// the first step of each run gives the confidence
	assert.deepEqual(conf.map((v) => Math.round(v * 100) / 100), [0.9, 0.6, 0.5, 0.4, 0.85]);
	assert.deepEqual(ocr.greedy(new Float32Array(C * 3).fill(0).map((_, i) => (i % C === 0 ? 1 : 0)), 3, C, dict), { text: "", conf: [] });
});

test("greedy refuses a model whose class count is not the dictionary's", () => {
	const dict = { chars: ["a", "b", " "], classes: 4 };
	const C = dict.classes + 1;
	assert.throws(() => ocr.greedy(new Float32Array(C * 2), 2, C, dict), { message: "the model has 5 classes, the dictionary gives 4" });
});

test("prepare: [1,3,48,W] with W >= 320, BGR planes, values in [-1,1]", async () => {
	// a pure-red patch in the middle of a grey frame, cropped exactly
	const width = 100;
	const height = 60;
	const data = Buffer.alloc(width * height * 3, 128);
	const roi = { x: 30, y: 20, width: 40, height: 20 };
	for (let y = roi.y; y < roi.y + roi.height; y++) {
		for (let x = roi.x; x < roi.x + roi.width; x++) {
			const p = (y * width + x) * 3;
			data[p] = 255;
			data[p + 1] = 0;
			data[p + 2] = 0;
		}
	}
	const t = await ocr.prepare({ data, width, height, channels: 3 }, roi);
	const W = t.dims[3];
	assert.deepEqual(t.dims, [1, 3, 48, W]);
	assert.ok(W >= 320);
	assert.equal(t.data.length, 3 * 48 * W);
	assert.ok(t.data.every((v) => v >= -1 && v <= 1));
	const plane = 48 * W;
	const scaled = Math.ceil((48 * roi.width) / roi.height); // 96, the rest is padding
	for (const [x, y] of [[0, 0], [scaled - 1, 47], [scaled >> 1, 24]]) {
		const o = y * W + x;
		assert.equal(t.data[o], -1, "plane 0 is blue");
		assert.equal(t.data[plane + o], -1, "plane 1 is green");
		assert.equal(t.data[2 * plane + o], 1, "plane 2 is red");
	}
	assert.equal(t.data[10 * W + scaled + 5], 0, "right padding is zero");
});

test("recognise reads a rendered line exactly, with one confidence per character", async () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="64">
		<rect width="360" height="64" fill="white"/>
		<text x="20" y="47" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="black">TX4829</text>
	</svg>`;
	const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const raw = { data, width: info.width, height: info.height, channels: info.channels };
	const { text, confidences, cropMs, inferMs } = await ocr.recognise(raw, { x: 0, y: 0, width: 360, height: 64 });
	assert.equal(text, "TX4829");
	for (const v of [cropMs, inferMs]) {
		assert.equal(typeof v, "number");
		assert.ok(v >= 0);
		assert.equal(v, Math.round(v * 10) / 10, "one decimal");
	}
	// a model run costs several times a crop: catches the two swapped
	assert.ok(inferMs > 0 && inferMs > cropMs, `cropMs ${cropMs}, inferMs ${inferMs}`);
	assert.equal(confidences.length, 6);
	for (const c of confidences) {
		assert.ok(c >= 0 && c <= 1);
		assert.equal(c, Math.round(c * 1000) / 1000, "rounded to 3 decimals");
	}
	// measured 2026-10-16: [1, 1, 1, 0.99, 1, 1]; the floor leaves room for
	// font and resampling differences between machines
	assert.ok(Math.min(...confidences) > 0.8, `confidences ${confidences}`);
});

// what was read, without the timings, which differ run to run
const reading = ({ text, confidences }) => ({ text, confidences });

async function renderedLine() {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="64">
		<rect width="360" height="64" fill="white"/>
		<text x="20" y="47" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="black">TX4829</text>
	</svg>`;
	const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

test("a fractional roi reads as the rounded one", async () => {
	const raw = await renderedLine();
	const rounded = await ocr.recognise(raw, { x: 1, y: 0, width: 358, height: 64 });
	const fractional = await ocr.recognise(raw, { x: 0.5, y: 0.2, width: 358.4, height: 63.6 });
	assert.deepEqual(reading(fractional), reading(rounded));
	assert.equal(fractional.text, "TX4829");
});

test("a fractional roi ending on the frame edge is inside it", async () => {
	const raw = await renderedLine();
	for (const roi of [{ x: 0.5, y: 0, width: 359.5, height: 64 }, { x: 0, y: 0.5, width: 360, height: 63.5 }]) {
		assert.equal((await ocr.recognise(raw, roi)).text, "TX4829", JSON.stringify(roi));
	}
});

test("a roi given as strings reads as the numeric one", async () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
		<rect width="400" height="100" fill="white"/>
		<text x="200" y="86" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="black">TX4829</text>
	</svg>`;
	const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const raw = { data, width: info.width, height: info.height, channels: info.channels };
	const numeric = await ocr.recognise(raw, { x: 180, y: 40, width: 220, height: 60 });
	assert.equal(numeric.text, "TX4829");
	assert.deepEqual(reading(await ocr.recognise(raw, { x: "180", y: "40", width: "220", height: "60" })), reading(numeric));
});

test("a roi outside the frame or empty throws one clear error", async () => {
	const raw = await renderedLine();
	for (const roi of [{ x: 1, y: 0, width: 360, height: 64 }, { x: 0, y: 0, width: 0, height: 64 }, { x: -1, y: 0, width: 10, height: 10 }]) {
		await assert.rejects(ocr.recognise(raw, roi), (e) => /roi/.test(e.message) && /360x64/.test(e.message), JSON.stringify(roi));
	}
	await assert.rejects(ocr.recognise(raw, { x: NaN, y: 0, width: 10, height: 10 }), (e) => /roi/.test(e.message) && /NaN/.test(e.message));
});

test("package.json ships the runtime, the models and the NOTICE", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.ok(pkg.dependencies["onnxruntime-web"], "onnxruntime-web is a dependency");
	assert.equal((pkg.devDependencies || {})["onnxruntime-web"], undefined, "and not a devDependency");
	assert.ok(pkg.files.includes("models/"));
	assert.ok(pkg.files.includes("NOTICE"));
	assert.ok(fs.existsSync(path.join(__dirname, "..", "NOTICE")));
});

test("the model and the dictionary are where lib/ocr.js looks", () => {
	for (const file of [ocr.MODEL_PATH, ocr.DICT_PATH]) {
		assert.ok(fs.statSync(file).size > 0, file);
	}
	assert.equal(path.dirname(ocr.MODEL_PATH), path.resolve(__dirname, "..", "models"));
	assert.equal(path.dirname(ocr.DICT_PATH), path.resolve(__dirname, "..", "models"));
});
