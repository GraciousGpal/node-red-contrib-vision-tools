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
	// read in a band cut to the line; the floor leaves room for font and
	// resampling differences between machines
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

// renderedLine turned by sharp: 90 is clockwise, so 270 reads it upright
async function turnedLine(degrees) {
	const line = await renderedLine();
	const { data, info } = await sharp(line.data, { raw: { width: line.width, height: line.height, channels: line.channels } })
		.rotate(degrees)
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

test("rotate turns the crop upright before reading: a line turned 90 reads with rotate 270", async () => {
	const raw = await turnedLine(90);
	assert.deepEqual([raw.width, raw.height], [64, 360]);
	const roi = { x: 0, y: 0, width: 64, height: 360 };
	const turned = await ocr.recognise(raw, roi, { rotate: 270 });
	assert.equal(turned.text, "TX4829");
	assert.equal(turned.confidences.length, 6);
	assert.notEqual((await ocr.recognise(raw, roi, { rotate: 0 })).text, "TX4829");
	assert.notEqual((await ocr.recognise(raw, roi)).text, "TX4829", "no rotate is 0");
});

test("rotate as a numeric string reads as the number; null options are rotate 0", async () => {
	const raw = await turnedLine(90);
	const roi = { x: 0, y: 0, width: 64, height: 360 };
	assert.equal((await ocr.recognise(raw, roi, { rotate: "270" })).text, "TX4829");
	const upright = await renderedLine();
	const whole = { x: 0, y: 0, width: 360, height: 64 };
	assert.deepEqual(reading(await ocr.recognise(upright, whole, null)), reading(await ocr.recognise(upright, whole, { rotate: 0 })));
	assert.equal((await ocr.recognise(upright, whole, null)).text, "TX4829");
	await assert.rejects(ocr.recognise(upright, whole, { rotate: 45 }), /rotate/);
});

test("an upside-down line reads with rotate 180", async () => {
	const raw = await turnedLine(180);
	const roi = { x: 0, y: 0, width: 360, height: 64 };
	const turned = await ocr.recognise(raw, roi, { rotate: 180 });
	assert.equal(turned.text, "TX4829");
	assert.equal(turned.confidences.length, 6);
	assert.notEqual((await ocr.recognise(raw, roi, { rotate: 0 })).text, "TX4829");
});

test("a roi outside the frame or empty throws one clear error", async () => {
	const raw = await renderedLine();
	for (const roi of [{ x: 1, y: 0, width: 360, height: 64 }, { x: 0, y: 0, width: 0, height: 64 }, { x: -1, y: 0, width: 10, height: 10 }]) {
		await assert.rejects(ocr.recognise(raw, roi), (e) => /roi/.test(e.message) && /360x64/.test(e.message), JSON.stringify(roi));
	}
	await assert.rejects(ocr.recognise(raw, { x: NaN, y: 0, width: 10, height: 10 }), (e) => /roi/.test(e.message) && /NaN/.test(e.message));
});

// 360x200, three 36 px lines with baselines at y 30, 95 and 160; ink and
// paper as given
async function threeLines(ink = "black", paper = "white") {
	const line = (y, t) => `<text x="20" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" fill="${ink}">${t}</text>`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200">
		<rect width="360" height="200" fill="${paper}"/>
		${line(30, "TX4829")}${line(95, "KM73")}${line(160, "AB12CD")}
	</svg>`;
	const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

const THREE = ["TX4829", "KM73", "AB12CD"];

function assertThreeLines(r) {
	assert.equal(r.text, THREE.join("\n"));
	assert.deepEqual(r.lines.map((l) => l.text), THREE);
	for (let i = 0; i < r.lines.length; i++) {
		const l = r.lines[i];
		assert.ok(l.y0 < l.y1, `line ${i} y0 ${l.y0} y1 ${l.y1}`);
		if (i) assert.ok(l.y0 >= r.lines[i - 1].y1, `line ${i} starts below line ${i - 1}`);
		assert.equal(l.confidences.length, l.text.length);
	}
	assert.equal(r.confidences.length, r.text.length);
	[...r.text].forEach((c, i) => {
		if (c === "\n") assert.equal(r.confidences[i], 1, `the newline at ${i} carries 1`);
	});
	assert.deepEqual(r.confidences, r.lines.flatMap((l, i) => (i ? [1, ...l.confidences] : l.confidences)));
}

test("one box over three printed lines reads every line, top to bottom", async () => {
	const raw = await threeLines();
	const r = await ocr.recognise(raw, { x: 0, y: 0, width: 360, height: 200 });
	assertThreeLines(r);
	assert.ok(Math.min(...r.confidences) > 0.8, `confidences ${r.confidences}`);
});

test("three lines turned 90 read with rotate 270, y in the upright crop", async () => {
	const upright = await threeLines();
	const { data, info } = await sharp(upright.data, { raw: { width: 360, height: 200, channels: upright.channels } })
		.rotate(90)
		.raw()
		.toBuffer({ resolveWithObject: true });
	const raw = { data, width: info.width, height: info.height, channels: info.channels };
	assert.deepEqual([raw.width, raw.height], [200, 360]);
	const r = await ocr.recognise(raw, { x: 0, y: 0, width: 200, height: 360 }, { rotate: 270 });
	assertThreeLines(r);
	const straight = await ocr.recognise(upright, { x: 0, y: 0, width: 360, height: 200 });
	assert.deepEqual(r.lines.map((l) => [l.y0, l.y1]), straight.lines.map((l) => [l.y0, l.y1]));
});

test("light text on a dark ground splits the same", async () => {
	const r = await ocr.recognise(await threeLines("white", "black"), { x: 0, y: 0, width: 360, height: 200 });
	assertThreeLines(r);
});

test("a single line reads as one line, cropped to its band", async () => {
	const raw = await renderedLine();
	const r = await ocr.recognise(raw, { x: 0, y: 0, width: 360, height: 64 });
	assert.equal(r.text, "TX4829");
	assert.equal(r.confidences.length, 6);
	// the band's padding (see lineBands) moves the X's confidence most; a
	// floor, not exact values: fonts differ between machines
	assert.ok(Math.min(...r.confidences) > 0.8, `confidences ${r.confidences}`);
	assert.equal(r.lines.length, 1);
	assert.equal(r.lines[0].text, "TX4829");
	assert.deepEqual(r.lines[0].confidences, r.confidences);
});

// lines on white, [baseline y, text] each, 36 px unless size is given;
// extra is more svg drawn over them
async function linesOn(width, height, lines, size = 36, extra = "") {
	const t = lines.map(([y, s]) => `<text x="20" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" fill="black">${s}</text>`).join("");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/>${t}${extra}</svg>`;
	const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

test("one line in a tall box is cropped to its band before reading", async () => {
	const r = await ocr.recognise(await linesOn(400, 200, [[110, "TX4829"]]), { x: 0, y: 0, width: 400, height: 200 });
	assert.equal(r.text, "TX4829");
	assert.equal(r.lines.length, 1);
	assert.ok(r.lines[0].y0 > 0 && r.lines[0].y1 < 200, `band ${r.lines[0].y0}..${r.lines[0].y1}`);
});

test("short lines in a wide box split and read: rows by the ink's width, bands cut to their ink columns", async () => {
	// tops at about y 10 and 65; read at the box's 5000 px width a band is
	// almost all paper and misreads (measured: AB as two odd signs, CD as D)
	const r = await ocr.recognise(await linesOn(5000, 120, [[37, "AB"], [92, "CD"]]), { x: 0, y: 0, width: 5000, height: 120 });
	assert.equal(r.text, "AB\nCD");
	assert.equal(r.lines.length, 2);
});

test("tight leading: descenders over ascenders 7 px apart stay two lines", async () => {
	// 36 px at 1.15 leading: "gypsy jig" descends to y 38, "Tiled fig" rises from y 45
	const raw = await linesOn(400, 100, [[30, "gypsy jig"], [71, "Tiled fig"]]);
	const r = await ocr.recognise(raw, { x: 0, y: 0, width: 400, height: 100 });
	assert.deepEqual(r.lines.map((l) => l.text), ["gypsy jig", "Tiled fig"]);
});

test("i and j dots join their line, not a line of their own", async () => {
	const r = await ocr.recognise(await linesOn(300, 60, [[45, "iiii jiji"]]), { x: 0, y: 0, width: 300, height: 60 });
	assert.equal(r.lines.length, 1);
	// the same line without dots starts lower: the dots are in the band
	const plain = await ocr.recognise(await linesOn(300, 60, [[45, "uuuu nunu"]]), { x: 0, y: 0, width: 300, height: 60 });
	assert.equal(plain.lines.length, 1);
	assert.ok(r.lines[0].y0 < plain.lines[0].y0, `dotted from ${r.lines[0].y0}, plain from ${plain.lines[0].y0}`);
});

const OUTLINE = (w, h) => `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="black" stroke-width="2"/>`;

test("a 2 px box outline at the crop edge is not text: both lines inside read", async () => {
	const r = await ocr.recognise(await linesOn(240, 140, [[50, "TX4829"], [110, "KM73"]], 36, OUTLINE(240, 140)), { x: 0, y: 0, width: 240, height: 140 });
	assert.deepEqual(r.lines.map((l) => l.text), ["TX4829", "KM73"]);
});

test("an outline with an 8 px rule along its top: both lines inside read", async () => {
	const extra = OUTLINE(240, 140) + `<rect x="0" y="0" width="240" height="8" fill="black"/>`;
	const r = await ocr.recognise(await linesOn(240, 140, [[50, "TX4829"], [110, "KM73"]], 36, extra), { x: 0, y: 0, width: 240, height: 140 });
	assert.deepEqual(r.lines.map((l) => l.text), ["TX4829", "KM73"]);
});

test("an outline over only 85% of the crop's height is still not text", async () => {
	// 2 px edges on rows 12..134 of 140: under 90% of the rows
	const extra = `<rect x="1" y="13" width="238" height="120" fill="none" stroke="black" stroke-width="2"/>`;
	const r = await ocr.recognise(await linesOn(240, 140, [[50, "TX4829"], [110, "KM73"]], 36, extra), { x: 0, y: 0, width: 240, height: 140 });
	assert.equal(r.text, "TX4829\nKM73");
});

// text rendered at 36 px and trimmed to its ink: a box drawn tight
async function tight(text) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect width="300" height="80" fill="white"/><text x="20" y="55" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" fill="black">${text}</text></svg>`;
	const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().trim().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

test("an outline over only 55% of the crop's height is still not text", async () => {
	// 2 px edges on rows 50..170 of 220 around both lines
	const extra = `<rect x="1" y="51" width="398" height="118" fill="none" stroke="black" stroke-width="2"/>`;
	const r = await ocr.recognise(await linesOn(400, 220, [[95, "TX4829"], [150, "KM73"]], 36, extra), { x: 0, y: 0, width: 400, height: 220 });
	assert.equal(r.text, "TX4829\nKM73");
});

test("the stems of a tight crop of 1111 are text, not rules", async () => {
	const raw = await tight("1111");
	assert.deepEqual([raw.width, raw.height], [63, 26]);
	const r = await ocr.recognise(raw, { x: 0, y: 0, width: raw.width, height: raw.height });
	assert.equal(r.text, "1111");
});

test("a leading or trailing I in a tight box is text, not a box edge", async () => {
	for (const text of ["IL42", "TAXI"]) {
		const raw = await tight(text);
		const r = await ocr.recognise(raw, { x: 0, y: 0, width: raw.width, height: raw.height });
		assert.equal(r.text, text, `${raw.width}x${raw.height}`);
	}
	// after digits the model reads the I as a 1 (measured "TX4821"): the stem
	// is kept, which letter it is stays the model's call
	const raw = await tight("TX482I");
	const r = await ocr.recognise(raw, { x: 0, y: 0, width: raw.width, height: raw.height });
	assert.equal(r.text.length, 6, r.text);
	assert.match(r.text, /^TX482[I1l]$/);
});

test("a lone 1 under a long line is a line of its own", async () => {
	const long = "ABCDEFGHJKLMNPQRSTUVWXYZ012345";
	assert.equal(long.length, 30);
	const r = await ocr.recognise(await linesOn(1000, 140, [[50, long], [120, "1"]], 44), { x: 0, y: 0, width: 1000, height: 140 });
	assert.equal(r.lines.length, 2, JSON.stringify(r.lines.map((l) => [l.text, l.y0, l.y1])));
	assert.equal(r.lines[1].text, "1");
});

test("18 px lines at 1.1 leading: padded bands never overlap", async () => {
	// 1.1 leading: 19.8 px from baseline to baseline
	const lines = [[20, "gypsy jig"], [40, "Tiled fig"], [60, "Hello 42"]];
	const r = await ocr.recognise(await linesOn(300, 80, lines, 18), { x: 0, y: 0, width: 300, height: 80 });
	assert.ok(r.lines.length >= 2, JSON.stringify(r.lines.map((l) => [l.text, l.y0, l.y1])));
	for (let i = 1; i < r.lines.length; i++) {
		assert.ok(r.lines[i - 1].y1 <= r.lines[i].y0, `line ${i - 1} ends at ${r.lines[i - 1].y1}, line ${i} starts at ${r.lines[i].y0}`);
	}
});

test("lineBands: one band per bar, padded without overlap; null when the crop has no contrast", () => {
	// 1-channel 100x60 white, black bars over columns 10..90 on rows 10..20
	// and 26..36
	const width = 100;
	const height = 60;
	const data = Buffer.alloc(width * height, 255);
	for (const [a, b] of [[10, 20], [26, 36]]) for (let y = a; y < b; y++) data.fill(0, y * width + 10, y * width + 90);
	const bands = ocr.lineBands({ data, info: { width, height, channels: 1 } });
	assert.equal(bands.length, 2, JSON.stringify(bands));
	const [top, bottom] = bands;
	assert.ok(top.y0 < 10 && top.y1 > 20 && bottom.y0 < 26 && bottom.y1 > 36, JSON.stringify(bands));
	assert.ok(top.y1 <= bottom.y0, "the 6 px gap is shared, not crossed");
	assert.ok(top.y0 >= 0 && bottom.y1 <= height);
	assert.equal(ocr.lineBands({ data: Buffer.alloc(width * height, 240), info: { width, height, channels: 1 } }), null);
});

// counts model runs while fn runs
async function modelRuns(fn) {
	const { session } = await ocr.loadModel();
	const run = session.run;
	let calls = 0;
	session.run = function (...args) {
		calls++;
		return run.apply(this, args);
	};
	try {
		return { result: await fn(), calls };
	} finally {
		session.run = run;
	}
}

test("a crop with under 32 grey levels of contrast reads nothing without running the model", async () => {
	const width = 200;
	const height = 100;
	const flat = Buffer.alloc(width * height * 3, 0xf0);
	const noise = Buffer.alloc(width * height * 3);
	for (let i = 0; i < noise.length; i++) noise[i] = 245 + ((i * 7919) % 11);
	for (const data of [flat, noise]) {
		const { result, calls } = await modelRuns(() => ocr.recognise({ data, width, height, channels: 3 }, { x: 0, y: 0, width, height }));
		assert.equal(calls, 0);
		assert.deepEqual({ text: result.text, confidences: result.confidences, lines: result.lines, inferMs: result.inferMs }, { text: "", confidences: [], lines: [], inferMs: 0 });
	}
	// the stub counts: a line runs it
	const { calls } = await modelRuns(async () => ocr.recognise(await renderedLine(), { x: 0, y: 0, width: 360, height: 64 }));
	assert.equal(calls, 1);
});

test("a blank crop reads nothing, no lines", async () => {
	const data = Buffer.alloc(200 * 100 * 3, 255);
	const r = await ocr.recognise({ data, width: 200, height: 100, channels: 3 }, { x: 0, y: 0, width: 200, height: 100 });
	assert.equal(r.text, "");
	assert.deepEqual(r.confidences, []);
	assert.deepEqual(r.lines, []);
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
