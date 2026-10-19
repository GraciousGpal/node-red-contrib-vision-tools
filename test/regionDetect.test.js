/**
 * lib/regionDetect.js on a synthetic label rendered with sharp from SVG:
 * two text blocks (one upright, one running top to bottom), a reversed
 * block (white on a black ground), barcode-like stripes that do not
 * decode, a real Code128, and a logo (a circle with a triangle over it).
 * Where each element should be found is measured from the element
 * rendered alone, so font differences between machines do not matter.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const writer = require("./helpers/barcodeWriter.js");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
// lib/regionDetect.js takes recognise from lib/ocr.js when first required:
// the wrapper goes in first, and reads the model unless fakeRead is set
const ocr = require("../lib/ocr.js");
const recognise = ocr.recognise;
let fakeRead = null;
ocr.recognise = (raw, roi, opts) => (fakeRead ? fakeRead(raw, roi, opts) : recognise(raw, roi, opts));
const { detectRegions, mergeGraphicBoxes, meanConfidence, graphicBigEnough } = require("../lib/regionDetect.js");

const W = 1500;
const H = 1000;
const FONT = 'font-family="DejaVu Sans, Arial, sans-serif"';

const blockB = (ink) =>
	`<text x="60" y="80" ${FONT} font-size="28" fill="${ink}">LOT 48213 BATCH A7 LINE</text>` +
	`<text x="60" y="118" ${FONT} font-size="28" fill="${ink}">EXP 2027 11 30 REF 96</text>`;
// text running top to bottom: rotate 270 turns it upright
const blockA = (ink) =>
	["SERIAL 55102 BOX", "PACKED 04 OCT 26", "MADE IN IRELAND"]
		.map((t, i) => `<g transform="translate(${1360 + 38 * i},200) rotate(90)"><text x="0" y="0" ${FONT} font-size="28" fill="${ink}">${t}</text></g>`)
		.join("");
// "40 px text": over 40 px of ink (capitals and digits), font size 60
const reversedText = (ink) => `<text x="80" y="492" ${FONT} font-size="60" fill="${ink}">NET WT 500 G</text>`;
const reversed = () => `<rect x="60" y="420" width="560" height="100" fill="black"/>` + reversedText("white");

// 60 stripes, black first, 2..5 px wide
const STRIPES = { x: 700, y: 150, height: 200 };
function stripes() {
	let x = STRIPES.x;
	let out = "";
	for (let i = 0; i < 60; i++) {
		const w = 2 + ((i * 7 + 3) % 4);
		if (i % 2 === 0) out += `<rect x="${x}" y="${STRIPES.y}" width="${w}" height="${STRIPES.height}" fill="black"/>`;
		x += w;
	}
	STRIPES.width = x - STRIPES.x;
	return out;
}
const logo = () =>
	`<circle cx="1000" cy="780" r="60" fill="black"/><polygon points="1050,720 1050,840 1170,780" fill="black"/>`;
const LOGO = { x: 940, y: 720, width: 230, height: 120 };
// the solid ground of the reversed block: a panel, so a graphic too
const GROUND = { x: 60, y: 420, width: 560, height: 100 };

// exactly these graphics, each within 8 px per edge
function graphicsAre(g, boxes) {
	assert.equal(g.length, boxes.length, JSON.stringify(g));
	for (const b of boxes) near(at(g, b) || { x: -1e6, y: -1e6, width: 0, height: 0 }, b, 8, JSON.stringify(b));
}

const svg = (body, w = W, h = H) =>
	Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`);

async function render(body, channels = 3) {
	let p = sharp(svg(body)).removeAlpha();
	if (channels === 1) p = p.greyscale().extractChannel(0);
	if (channels === 4) p = p.ensureAlpha();
	const { data, info } = await p.raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

// the ink box (grey < 128) of an element rendered alone in black
async function inkBox(body) {
	const raw = await render(body, 1);
	let x0 = W;
	let y0 = H;
	let x1 = 0;
	let y1 = 0;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			if (raw.data[y * W + x] < 128) {
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				x1 = Math.max(x1, x + 1);
				y1 = Math.max(y1, y + 1);
			}
		}
	}
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function near(region, truth, tol, what) {
	const d = [
		region.x - truth.x,
		region.y - truth.y,
		region.x + region.width - (truth.x + truth.width),
		region.y + region.height - (truth.y + truth.height),
	];
	assert.ok(d.every((v) => Math.abs(v) <= tol), `${what}: region ${JSON.stringify(region)} vs truth ${JSON.stringify(truth)} (edges off by ${d})`);
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const byKind = (regions, kind) => regions.filter((r) => r.kind === kind);
const at = (regions, truth) => regions.find((r) => overlaps(r, truth));

let fixture = null;
function label() {
	if (!fixture) {
		fixture = (async () => {
			const body = blockB("black") + blockA("black") + reversed() + stripes() + logo();
			return {
				body,
				raw: await render(body),
				truth: { A: await inkBox(blockA("black")), B: await inkBox(blockB("black")), R: await inkBox(reversedText("black")) },
			};
		})();
	}
	return fixture;
}

test("detectRegions: three text blocks, their orientation and their boxes", async () => {
	const { raw, truth } = await label();
	const { regions } = await detectRegions(raw);
	const text = byKind(regions, "text");
	assert.equal(text.length, 3, JSON.stringify(text));
	const A = at(text, truth.A);
	const B = at(text, truth.B);
	const R = at(text, truth.R);
	assert.ok(A && B && R && new Set([A, B, R]).size === 3, JSON.stringify(text));
	near(A, truth.A, 6, "block A");
	near(B, truth.B, 6, "block B");
	near(R, truth.R, 6, "reversed block");
	assert.equal(A.rotate, 270);
	assert.equal(B.rotate, 0);
	assert.equal(R.rotate, 0);
	assert.ok(A.score > 0.5 && B.score > 0.5, `scores A ${A.score} B ${B.score}`);
});

test("detectRegions: undecodable stripes are one barcode by their periodicity", async () => {
	const { raw } = await label();
	const { regions } = await detectRegions(raw);
	const bars = byKind(regions, "barcode");
	assert.equal(bars.length, 1, JSON.stringify(bars));
	near(bars[0], STRIPES, 8, "stripes");
	assert.ok(bars[0].score > 0 && bars[0].score < 1, `periodicity score ${bars[0].score}`);
	assert.equal(bars[0].rotate, 0);
});

test("detectRegions: a real Code128 decodes, score 1, the box covers its bars", async () => {
	const r = await writer.writeBarcode("LOT48213", { format: "Code128", scale: 3, addQuietZones: false });
	if (r.error) throw new Error(`writeBarcode: ${r.error}`);
	const code = Buffer.from(await r.image.arrayBuffer());
	const meta = await sharp(code).metadata();
	const { body } = await label();
	const withoutStripes = body.replace(/<rect x="\d+" y="150"[^>]*\/>/g, "");
	const png = await sharp(svg(withoutStripes)).removeAlpha().composite([{ input: code, left: 700, top: 150 }]).raw().toBuffer({ resolveWithObject: true });
	const raw = { data: png.data, width: png.info.width, height: png.info.height, channels: png.info.channels };
	const { regions } = await detectRegions(raw);
	const bars = byKind(regions, "barcode");
	assert.equal(bars.length, 1, JSON.stringify(bars));
	assert.equal(bars[0].score, 1);
	near(bars[0], { x: 700, y: 150, width: meta.width, height: meta.height }, 8, "Code128");
});

test("detectRegions: the logo is one graphic; graphics:false gives none", async () => {
	const { raw } = await label();
	const { regions } = await detectRegions(raw);
	const g = byKind(regions, "graphic");
	graphicsAre(g, [LOGO, GROUND]);
	assert.ok(g[0].score > 0 && g[0].score <= 1);
	const off = await detectRegions(raw, { graphics: false });
	assert.equal(byKind(off.regions, "graphic").length, 0);
	assert.equal(byKind(off.regions, "text").length, 3);
});

test("detectRegions: names, labels, order, integers, frame, timings", async () => {
	const { raw } = await label();
	const { regions, timings } = await detectRegions(raw);
	const count = {};
	for (const r of regions) {
		count[r.kind] = (count[r.kind] || 0) + 1;
		assert.equal(r.name, `${r.kind}${count[r.kind]}`);
		assert.equal(r.label, r.name);
		for (const k of ["x", "y", "width", "height", "rotate"]) assert.ok(Number.isInteger(r[k]), `${r.name}.${k} ${r[k]}`);
		assert.ok(r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= W && r.y + r.height <= H, JSON.stringify(r));
		assert.ok(r.score >= 0 && r.score <= 1);
		if (r.kind !== "text") assert.equal(r.rotate, 0);
	}
	for (let i = 1; i < regions.length; i++) {
		const a = regions[i - 1];
		const b = regions[i];
		assert.ok(a.y < b.y || (a.y === b.y && a.x <= b.x), `order ${a.name} ${b.name}`);
	}
	for (const kind of ["text", "barcode", "graphic"]) {
		const k = byKind(regions, kind);
		for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) assert.ok(!overlaps(k[i], k[j]), `${k[i].name} overlaps ${k[j].name}`);
	}
	assert.deepEqual(Object.keys(timings), ["thresholdMs", "componentsMs", "barcodeMs", "textMs", "orientMs", "graphicsMs", "totalMs"]);
	for (const v of Object.values(timings)) assert.equal(Math.round(v * 10) / 10, v);
	assert.ok(timings.totalMs > 0);
	assertTimingsAddUp(timings);
});

test("detectRegions: a fixed orientation and minTextHeight", async () => {
	const { raw, truth } = await label();
	const fixed = await detectRegions(raw, { orientation: 270 });
	const text = byKind(fixed.regions, "text");
	assert.equal(text.length, 3);
	assert.ok(text.every((r) => r.rotate === 270 && r.score === 1), JSON.stringify(text));
	const tall = await detectRegions(raw, { minTextHeight: 40 });
	const kept = byKind(tall.regions, "text");
	assert.equal(kept.length, 1, JSON.stringify(kept));
	assert.ok(overlaps(kept[0], truth.R));
});

test("detectRegions: a blank frame gives no regions; 4- and 1-channel frames work", async () => {
	const blank = await detectRegions({ data: Buffer.alloc(W * H * 3, 255), width: W, height: H, channels: 3 });
	assert.deepEqual(blank.regions, []);
	const { body } = await label();
	for (const channels of [4, 1]) {
		const raw = await render(body, channels);
		assert.equal(raw.channels, channels);
		const { regions } = await detectRegions(raw);
		assert.equal(byKind(regions, "text").length, 3, `${channels} channels`);
		assert.equal(byKind(regions, "barcode").length, 1, `${channels} channels`);
		assert.equal(byKind(regions, "graphic").length, 2, `${channels} channels`);
	}
});

// the label with the stripes taken out and `extra` drawn over it
async function variant(extra) {
	const { body } = await label();
	return render(body.replace(/<rect x="\d+" y="150"[^>]*\/>/g, "") + extra);
}

test("detectRegions: bars with guard bars and truncated bars are a barcode, not a graphic", async () => {
	// 60 horizontal stripes (bars along the short axis) stacked from y 150,
	// black first, 2..5 px thick; the first, middle and last two black bars
	// are guard bars 20% longer, the others alternate full and 3/4 length
	let y = 150;
	let body = "";
	const lengths = [];
	const guards = new Set([0, 1, 14, 15, 28, 29]);
	for (let i = 0; i < 60; i++) {
		const t = 2 + ((i * 7 + 3) % 4);
		if (i % 2 === 0) {
			const k = i / 2;
			const len = guards.has(k) ? 192 : k % 2 ? 120 : 160;
			lengths.push(len);
			body += `<rect x="700" y="${y}" width="${len}" height="${t}" fill="black"/>`;
		}
		y += t;
	}
	const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length;
	const cv = Math.sqrt(lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / lengths.length) / mean;
	assert.ok(cv > 0.15 && cv <= 0.35, `precondition: length variation ${cv} is past the strict rule and within the guard-bar rule`);
	const { regions } = await detectRegions(await variant(body));
	const bars = byKind(regions, "barcode");
	assert.equal(bars.length, 1, JSON.stringify(regions));
	near(bars[0], { x: 700, y: 150, width: 192, height: y - 150 }, 8, "guard-bar code");
	assert.ok(bars[0].score > 0 && bars[0].score <= 0.95, `score ${bars[0].score}`);
	graphicsAre(byKind(regions, "graphic"), [LOGO, GROUND]);
});

test("detectRegions: a wordmark of separate thick glyphs in a row is one graphic", async () => {
	// four 75x130 blocks 12 px apart (their padded boxes 4 px apart, as the
	// real wordmark came out), each larger than a character
	const glyphs = [0, 1, 2, 3].map((i) => `<rect x="${150 + 87 * i}" y="600" width="75" height="130" fill="black"/>`).join("");
	const { regions } = await detectRegions(await variant(glyphs + stripes()));
	const g = byKind(regions, "graphic");
	assert.equal(g.length, 3, JSON.stringify(g));
	near(at(g, GROUND), GROUND, 8, "ground");
	near(at(g, { x: 150, y: 600, width: 336, height: 130 }), { x: 150, y: 600, width: 336, height: 130 }, 8, "wordmark");
	near(at(g, LOGO), LOGO, 8, "logo");
});

test("detectRegions: a strip along the frame edge is not a graphic", async () => {
	const { regions } = await detectRegions(await variant(`<rect x="0" y="0" width="10" height="${H}" fill="black"/>` + stripes()));
	const g = byKind(regions, "graphic");
	graphicsAre(g, [LOGO, GROUND]);
});

test("detectRegions: minScore drops text blocks read below it", async () => {
	const { raw } = await label();
	const all = byKind((await detectRegions(raw)).regions, "text");
	assert.equal(all.length, 3, "the default minScore 0.6 keeps the three blocks");
	console.log(`text scores at the default: ${all.map((r) => `${r.name} ${r.score}`).join(", ")}`);
	const strict = byKind((await detectRegions(raw, { minScore: 0.99 })).regions, "text");
	assert.equal(strict.length, all.filter((r) => r.score >= 0.99).length, JSON.stringify(strict));
	assert.ok(strict.every((r) => r.score >= 0.99));
});

// the real wordmark's three output boxes: the tall part, then two short
// bars below it, 0 and 1 px apart
const WORDMARK = [
	{ x: 1236, y: 76, width: 148, height: 369 },
	{ x: 1285, y: 445, width: 74, height: 22 },
	{ x: 1285, y: 468, width: 75, height: 43 },
];

test("mergeGraphicBoxes: the wordmark's three stacked boxes are one", () => {
	const merged = mergeGraphicBoxes(WORDMARK.map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height, ink: 1 })));
	assert.equal(merged.length, 1, JSON.stringify(merged));
	assert.deepEqual([merged[0].x0, merged[0].y0, merged[0].x1, merged[0].y1, merged[0].ink], [1236, 76, 1384, 511, 3]);
});

test("detectRegions: a tall part with two short bars under it, 8 and 9 px apart, is one graphic", async () => {
	// the real wordmark's shape: bars too thin to be a graphic alone
	const parts = [
		{ x: 940, y: 80, width: 140, height: 361 },
		{ x: 989, y: 449, width: 66, height: 14 },
		{ x: 989, y: 472, width: 67, height: 35 },
	];
	const body = parts.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="black"/>`).join("");
	const { regions } = await detectRegions(await variant(body + stripes()));
	const g = byKind(regions, "graphic");
	const truth = { x: 940, y: 80, width: 140, height: 427 };
	assert.equal(g.length, 3, JSON.stringify(g));
	near(at(g, GROUND), GROUND, 8, "ground");
	near(at(g, truth), truth, 8, "wordmark");
	near(at(g, LOGO), LOGO, 8, "logo");
});

// ---- review round ----

function assertTimingsAddUp(timings) {
	const parts = Object.entries(timings).filter(([k]) => k !== "totalMs").reduce((a, [, v]) => a + v, 0);
	assert.ok(timings.totalMs >= parts - 0.5, `totalMs ${timings.totalMs} under the parts' sum ${parts}: ${JSON.stringify(timings)}`);
}

// mulberry32: the same "random" layout on every run
function rng(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rect = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="black"/>`;
const tiny = (w = 20, h = 10) => ({ data: Buffer.alloc(w * h * 3, 255), width: w, height: h, channels: 3 });

test("detectRegions: arguments are checked with errors naming them", async () => {
	await assert.rejects(detectRegions(null), /raw/);
	await assert.rejects(detectRegions(undefined), /raw/);
	await assert.rejects(detectRegions(tiny(), null), /opts/);
	await assert.rejects(detectRegions({ ...tiny(), width: 10.5 }), /raw\.width/);
	await assert.rejects(detectRegions({ ...tiny(), height: 0 }), /raw\.height/);
	await assert.rejects(detectRegions({ ...tiny(), channels: 5 }), /raw\.channels/);
	await assert.rejects(detectRegions({ ...tiny(), data: new Float32Array(600) }), /raw\.data/);
	await assert.rejects(detectRegions({ ...tiny(), data: Buffer.alloc(599) }), /raw\.data/);
	await assert.rejects(detectRegions(tiny(), { pad: NaN }), /pad NaN/);
	await assert.rejects(detectRegions(tiny(), { minScore: 1.5 }), /minScore 1\.5/);
	assert.deepEqual((await detectRegions(tiny(), { minScore: 1 })).regions, []);
	await assert.rejects(detectRegions(tiny(), { pad: -1 }), /pad/);
	await assert.rejects(detectRegions(tiny(), { minTextHeight: "x" }), /minTextHeight/);
	await assert.rejects(detectRegions(tiny(), { minScore: Infinity }), /minScore/);
	for (const orientation of ["", NaN, 45, null, "up"]) await assert.rejects(detectRegions(tiny(), { orientation }), /orientation/, String(orientation));
	for (const orientation of ["auto", 90, "180", " 270 "]) assert.deepEqual((await detectRegions(tiny(), { orientation })).regions, []);
	const { raw } = await label();
	const a = await detectRegions(raw, { pad: "4", orientation: 0 });
	const b = await detectRegions(raw, { pad: 4, orientation: 0 });
	assert.deepEqual(a.regions, b.regions);
});

test("detectRegions: 3000 specks on 2048x1536 merge as graphics in under 500 ms, timings add up, no graphic under the size floor", async () => {
	const r = rng(7);
	let body = "";
	for (let i = 0; i < 3000; i++) {
		const s = 3 + Math.floor(r() * 10);
		body += rect(Math.floor(r() * 2030), Math.floor(r() * 1520), s, s);
	}
	const { data, info } = await sharp(svg(body, 2048, 1536)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	// orientation fixed: this times the masks, labelling and merging; with
	// "auto" a score of overlapping specks read as text (0.6-0.9) adds about
	// 80 ms of model reads each
	const started = performance.now();
	const { regions, timings, charHeight } = await detectRegions({ data, width: info.width, height: info.height, channels: 3 }, { orientation: 0 });
	const wall = performance.now() - started;
	console.log(`3000 specks: ${wall.toFixed(0)} ms, ${JSON.stringify(timings)}, ${regions.length} regions, charHeight ${charHeight}`);
	// the budget is the graphic merge's (passes of O(n^2), not restarts), not
	// the wall clock, which a loaded machine stretches
	assert.ok(timings.graphicsMs < 500, `graphicsMs ${timings.graphicsMs}`);
	assertTimingsAddUp(timings);
	const m = charHeight;
	for (const g of byKind(regions, "graphic")) assert.ok(g.width >= 2 * m && g.height >= 2 * m && g.width * g.height >= 6 * m * m, JSON.stringify(g));
});

test("detectRegions: a forced orientation reads nothing: no model loaded, score 1", () => {
	const code = `
		const sharp = require("sharp");
		const { detectRegions } = require("./lib/regionDetect.js");
		(async () => {
			const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="white"/><text x="40" y="100" font-family="DejaVu Sans, Arial, sans-serif" font-size="28">LOT 48213 BATCH A7</text></svg>');
			const { data, info } = await sharp(svg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
			const r = await detectRegions({ data, width: info.width, height: info.height, channels: info.channels }, { orientation: 270 });
			const ort = Object.keys(require.cache).some((k) => k.includes("onnxruntime-web"));
			console.log(JSON.stringify({ ort, text: r.regions.filter((x) => x.kind === "text").map((x) => [x.rotate, x.score]) }));
		})();`;
	const out = JSON.parse(execFileSync(process.execPath, ["-e", code], { cwd: path.join(__dirname, ".."), encoding: "utf8" }).trim().split("\n").pop());
	assert.equal(out.ort, false);
	assert.ok(out.text.length >= 1);
	assert.ok(out.text.every(([rotate, score]) => rotate === 270 && score === 1), JSON.stringify(out.text));
});

test("meanConfidence: the mean over characters, not the line breaks", async () => {
	const { raw, truth } = await label();
	const roi = { x: truth.A.x - 4, y: truth.A.y - 4, width: truth.A.width + 8, height: truth.A.height + 8 };
	const r = await recognise(raw, roi, { rotate: 270 });
	assert.equal(r.lines.length, 3, JSON.stringify(r.lines.map((l) => l.text)));
	const chars = r.lines.flatMap((l) => l.confidences);
	const mean = chars.reduce((a, b) => a + b, 0) / chars.length;
	assert.equal(meanConfidence(r), mean);
	assert.notEqual(meanConfidence(r), r.confidences.reduce((a, b) => a + b, 0) / r.confidences.length);
	assert.equal(meanConfidence({ text: "", confidences: [], lines: [] }), 0);
});

test("detectRegions: 80 3x3 specks do not change the three text blocks", async () => {
	const r = rng(3);
	let specks = "";
	for (let i = 0; i < 80; i++) specks += rect(20 + Math.floor(r() * 880), 560 + Math.floor(r() * 420), 3, 3);
	const { body, truth } = await label();
	const { regions } = await detectRegions(await render(body + specks));
	const text = byKind(regions, "text");
	assert.equal(text.length, 3, JSON.stringify(text));
	near(at(text, truth.A), truth.A, 6, "block A");
	near(at(text, truth.B), truth.B, 6, "block B");
	near(at(text, truth.R), truth.R, 6, "reversed block");
});

test("graphicBigEnough: both sides 2 m and the area 6 m^2", () => {
	// the real label's 26x16 and 33x20 output boxes, less the 4 px pad, at m 10 and 12
	for (const m of [10, 12]) {
		assert.equal(graphicBigEnough(26 - 8, 16 - 8, m), false);
		assert.equal(graphicBigEnough(33 - 8, 20 - 8, m), false);
	}
	assert.equal(graphicBigEnough(20, 30, 10), true);
	assert.equal(graphicBigEnough(20, 29, 10), false, "area 580 under 600");
	assert.equal(graphicBigEnough(19, 100, 10), false);
});

test("detectRegions: white 24 px text on a 34 px black band is text, the band no graphic (under 2 m high)", async () => {
	const words = (ink) => `<text x="160" y="645" ${FONT} font-size="24" fill="${ink}">BATCH 2210 LINE 4</text>`;
	const truth = await inkBox(words("black"));
	const { regions } = await detectRegions(await render((await label()).body + rect(150, 620, 500, 34) + words("white")));
	const t = at(byKind(regions, "text"), truth);
	assert.ok(t, JSON.stringify(regions));
	near(t, truth, 6, "band text");
	assert.equal(t.rotate, 0);
	graphicsAre(byKind(regions, "graphic"), [LOGO, GROUND]);
});

test("detectRegions: two-character fields are text", async () => {
	const ok = (ink) => `<text x="150" y="650" ${FONT} font-size="28" fill="${ink}">OK</text>`;
	const a7 = (ink) => `<text x="500" y="900" ${FONT} font-size="28" fill="${ink}">A7</text>`;
	const tOk = await inkBox(ok("black"));
	const tA7 = await inkBox(a7("black"));
	const { regions } = await detectRegions(await render((await label()).body + ok("black") + a7("black")));
	const text = byKind(regions, "text");
	assert.equal(text.length, 5, JSON.stringify(text));
	near(at(text, tOk), tOk, 6, "OK");
	near(at(text, tA7), tA7, 6, "A7");
});

test("detectRegions: a row of capital I's is text, not a barcode", async () => {
	const ii = (ink) => `<text x="150" y="650" ${FONT} font-size="28" fill="${ink}">IIIIIIIIIIIIIIIIIIII</text>`;
	const truth = await inkBox(ii("black"));
	const { regions } = await detectRegions(await render((await label()).body + ii("black")));
	const bars = byKind(regions, "barcode");
	assert.equal(bars.length, 1, JSON.stringify(bars));
	near(bars[0], STRIPES, 8, "stripes");
	assert.ok(at(byKind(regions, "text"), truth), JSON.stringify(regions));
});

test("mergeGraphicBoxes: four glyph boxes 12 px apart, padded by 4, are one", () => {
	const glyphs = [0, 1, 2, 3].map((i) => ({ x0: 150 + 87 * i - 4, y0: 596, x1: 150 + 87 * i + 75 + 4, y1: 734, ink: 75 * 130 }));
	const merged = mergeGraphicBoxes(glyphs);
	assert.equal(merged.length, 1, JSON.stringify(merged));
	assert.deepEqual([merged[0].x0, merged[0].y0, merged[0].x1, merged[0].y1, merged[0].ink], [146, 596, 490, 734, 4 * 75 * 130]);
	// not aligned: the same boxes staggered by more than half their height
	const staggered = glyphs.map((g, i) => ({ ...g, y0: g.y0 + i * 80, y1: g.y1 + i * 80 }));
	assert.equal(mergeGraphicBoxes(staggered).length, 4);
});

test("detectRegions: a solid black square is one graphic filled >= 0.9", async () => {
	const { regions } = await detectRegions(await variant(rect(150, 600, 150, 150) + stripes()));
	const g = byKind(regions, "graphic");
	assert.equal(g.length, 3, JSON.stringify(g));
	near(at(g, GROUND), GROUND, 8, "ground");
	const sq = at(g, { x: 150, y: 600, width: 150, height: 150 });
	near(sq, { x: 150, y: 600, width: 150, height: 150 }, 8, "square");
	assert.ok(sq.score >= 0.9, `fill ${sq.score}`);
});

test("detectRegions: a frame around block B is no graphic and B is still found", async () => {
	const frame = `<rect x="43" y="38" width="394" height="104" fill="none" stroke="black" stroke-width="6"/>`;
	const { body, truth } = await label();
	const { regions } = await detectRegions(await render(body + frame));
	const text = byKind(regions, "text");
	assert.equal(text.length, 3, JSON.stringify(text));
	near(at(text, truth.B), truth.B, 6, "block B");
	const g = byKind(regions, "graphic");
	graphicsAre(g, [LOGO, GROUND]);
});

test("detectRegions: an upside-down block reads 180", async () => {
	const flip = (ink) => `<g transform="translate(450,640) rotate(180)"><text x="0" y="0" ${FONT} font-size="28" fill="${ink}">BEST BEFORE 2027</text></g>`;
	const truth = await inkBox(flip("black"));
	const { regions } = await detectRegions(await render((await label()).body + flip("black")));
	const text = byKind(regions, "text");
	assert.equal(text.length, 4, JSON.stringify(text));
	const t = at(text, truth);
	near(t, truth, 6, "upside-down block");
	assert.equal(t.rotate, 180);
});

test("detectRegions: barcodes:false leaves the stripes a graphic", async () => {
	const { raw } = await label();
	const { regions } = await detectRegions(raw, { barcodes: false });
	assert.equal(byKind(regions, "barcode").length, 0);
	const g = byKind(regions, "graphic");
	assert.equal(g.length, 3, JSON.stringify(g));
	near(at(g, GROUND), GROUND, 8, "ground");
	near(at(g, STRIPES), STRIPES, 8, "stripes");
});

test("detectRegions: the default minScore keeps garbage reads of a random grid next to text out of the text", async () => {
	// 21x21 cells of 8 px, 26 px right of block B
	const r = rng(21);
	let grid = "";
	for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) if (r() < 0.5) grid += rect(440 + 8 * x, 30 + 8 * y, 8, 8);
	const box = { x: 440, y: 30, width: 168, height: 168 };
	const { regions } = await detectRegions(await render((await label()).body + grid));
	const g = byKind(regions, "graphic").find((x) => overlaps(x, box));
	assert.ok(g, JSON.stringify(regions));
	assert.ok(!byKind(regions, "text").some((t) => overlaps(t, g)), JSON.stringify(regions));
});

// ---- final round ----

test("detectRegions: a solid panel holding white text is a graphic beside its text", async () => {
	const lines = (ink) =>
		`<text x="320" y="670" ${FONT} font-size="28" fill="${ink}">LOT 77 B4</text>` + `<text x="320" y="712" ${FONT} font-size="28" fill="${ink}">QTY 300 PCS</text>`;
	const truth = await inkBox(lines("black"));
	const panel = { x: 300, y: 600, width: 300, height: 200 };
	const { regions } = await detectRegions(await variant(rect(panel.x, panel.y, panel.width, panel.height) + lines("white") + stripes()));
	const t = byKind(regions, "text").filter((x) => overlaps(x, truth));
	assert.ok(t.length >= 1, JSON.stringify(regions));
	assert.ok(t.every((x) => x.x >= truth.x - 6 && x.y >= truth.y - 6 && x.x + x.width <= truth.x + truth.width + 6 && x.y + x.height <= truth.y + truth.height + 6), JSON.stringify(t));
	graphicsAre(byKind(regions, "graphic"), [LOGO, GROUND, panel]);
});

test("detectRegions: an off-centre hollow frame around block B is no graphic", async () => {
	// 700x400, 6 px: its centre (360, 210) is outside block B, so only the
	// enclosure test can drop it
	const frame = `<rect x="13" y="13" width="694" height="394" fill="none" stroke="black" stroke-width="6"/>`;
	const { body, truth } = await label();
	const { regions } = await detectRegions(await render(body.replace(/<rect x="\d+" y="150"[^>]*\/>/g, "") + frame));
	const text = byKind(regions, "text");
	near(at(text, truth.B), truth.B, 6, "block B");
	graphicsAre(byKind(regions, "graphic"), [LOGO, GROUND]);
});

test("detectRegions: dust does not set the character height", async () => {
	// 100 specks of 4x4 outnumber the 40 characters of 48 px text
	const words = (ink) =>
		`<text x="100" y="200" ${FONT} font-size="48" fill="${ink}">LOT 48213 BATCH 77</text>` +
		`<text x="100" y="700" ${FONT} font-size="48" fill="${ink}">EXP 2027 11 REF 9904</text>`;
	const t1 = await inkBox(`<text x="100" y="200" ${FONT} font-size="48">LOT 48213 BATCH 77</text>`);
	const t2 = await inkBox(`<text x="100" y="700" ${FONT} font-size="48">EXP 2027 11 REF 9904</text>`);
	const r = rng(11);
	let dust = "";
	for (let i = 0; i < 100; i++) dust += rect(20 + Math.floor(r() * 1460), (i % 2 ? 300 : 800) + Math.floor(r() * 300), 4, 4);
	const { regions } = await detectRegions(await render(words("black") + dust));
	const text = byKind(regions, "text");
	assert.equal(text.length, 2, JSON.stringify(regions));
	near(at(text, t1), t1, 6, "line 1");
	near(at(text, t2), t2, 6, "line 2");
	assert.equal(byKind(regions, "graphic").length, 0, JSON.stringify(regions));
});

test("detectRegions: the orientation vote: an upright and an upside-down block", async () => {
	const up = (ink) => `<text x="150" y="650" ${FONT} font-size="28" fill="${ink}">BEST BEFORE 2027</text>`;
	const flip = (ink) => `<g transform="translate(600,900) rotate(180)"><text x="0" y="0" ${FONT} font-size="28" fill="${ink}">PACKED 04 OCT 26</text></g>`;
	const tUp = await inkBox(up("black"));
	const tFlip = await inkBox(flip("black"));
	const { regions } = await detectRegions(await variant(up("black") + flip("black")));
	const text = byKind(regions, "text");
	assert.equal(at(text, tUp).rotate, 0);
	assert.equal(at(text, tFlip).rotate, 180);
});

test("detectRegions: a solid panel with large reversed words and a rule touching it is one graphic", async () => {
	// the rule runs the frame's height along the panel's right edge, so the
	// panel's component is 608x1000 and mostly paper by its box. Alone on
	// the frame: beside the label's own graphics the tall box would join
	// them side by side
	const panel = { x: 700, y: 380, width: 600, height: 220 };
	const words =
		`<text x="730" y="460" ${FONT} font-size="60" fill="white">4.4 mm</text>` + `<text x="730" y="560" ${FONT} font-size="60" fill="white">30 mm</text>`;
	const body = rect(panel.x, panel.y, panel.width, panel.height) + words + rect(1300, 0, 8, H);
	const { regions } = await detectRegions(await render(body));
	const g = byKind(regions, "graphic");
	const p = g.filter((x) => overlaps(x, panel));
	assert.equal(p.length, 1, JSON.stringify(g));
	const [b] = p;
	assert.ok(b.x <= panel.x + 8 && b.y <= panel.y + 8 && b.x + b.width >= panel.x + panel.width - 8 && b.y + b.height >= panel.y + panel.height - 8, `the graphic ${JSON.stringify(b)} covers the panel`);
	assert.ok(b.x >= panel.x - 8 && b.x + b.width <= 1308 + 8, `the graphic ${JSON.stringify(b)} is the panel and the rule at most`);
	assert.equal(g.length, 1, JSON.stringify(g));
});

test("detectRegions: isolated 5x5 dust does not vote for the character height", async () => {
	const l1 = `<text x="100" y="200" ${FONT} font-size="48">LOT 48213 BATCH 77</text>`;
	const l2 = `<text x="100" y="700" ${FONT} font-size="48">EXP 2027 11 REF 9904</text>`;
	const t1 = await inkBox(l1);
	const t2 = await inkBox(l2);
	const r = rng(12);
	let dust = "";
	for (let i = 0; i < 100; i++) dust += rect(20 + Math.floor(r() * 1460), (i % 2 ? 300 : 800) + Math.floor(r() * 300), 5, 5);
	const { regions, charHeight } = await detectRegions(await render(l1 + l2 + dust));
	const text = byKind(regions, "text");
	assert.equal(text.length, 2, `charHeight ${charHeight}: ${JSON.stringify(regions)}`);
	near(at(text, t1), t1, 6, "line 1");
	near(at(text, t2), t2, 6, "line 2");
	assert.equal(byKind(regions, "graphic").length, 0, JSON.stringify(regions));
});

test("detectRegions: a low-margin vote follows the confident majority of its axis", async () => {
	// three blocks running top to bottom; reads are faked by the block's x:
	// the left one votes 90 by 0.05, the other two 270 by 0.7
	const col = (x) => `<g transform="translate(${x},100) rotate(90)"><text x="0" y="0" ${FONT} font-size="28">SERIAL 55102 BOX</text></g>`;
	const { data, info } = await sharp(svg(col(200) + col(700) + col(1200))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const read = (c) => ({ text: "X", confidences: [c], lines: [{ text: "X", confidences: [c], y0: 0, y1: 1 }] });
	fakeRead = async (raw, roi, opts) => {
		const weak = roi.x < 500;
		const conf = weak ? { 90: 0.8, 270: 0.75 } : { 90: 0.2, 270: 0.9 };
		return read(conf[opts.rotate]);
	};
	try {
		const { regions } = await detectRegions({ data, width: info.width, height: info.height, channels: 3 });
		const text = byKind(regions, "text");
		assert.equal(text.length, 3, JSON.stringify(text));
		assert.deepEqual(text.map((t) => t.rotate), [270, 270, 270], JSON.stringify(text));
		const weak = text.find((t) => t.x < 500);
		assert.equal(weak.score, 0.75);
	} finally {
		fakeRead = null;
	}
});

test("mergeGraphicBoxes: a small icon beside a much taller panel stays apart", () => {
	// side by side, 26 px apart, but under half the panel's height: two marks
	const panel = { x0: 286, y0: 40, x1: 896, y1: 318, ink: 1 };
	const icon = { x0: 922, y0: 71, x1: 1025, y1: 170, ink: 1 };
	assert.equal(mergeGraphicBoxes([panel, icon]).length, 2);
});

test("detectRegions: the caller's raw.data is left as it was (3, 1 and 4 channels)", async () => {
	const crypto = require("node:crypto");
	const hash = (d) => crypto.createHash("sha256").update(d).digest("hex");
	const { body } = await label();
	for (const channels of [3, 1, 4]) {
		const raw = await render(body, channels);
		const before = hash(raw.data);
		await detectRegions(raw);
		assert.equal(hash(raw.data), before, `${channels} channels`);
	}
});
