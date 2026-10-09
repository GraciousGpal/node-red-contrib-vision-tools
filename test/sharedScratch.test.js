/**
 * A frame's full-size scratch goes back to lib/shared.js when the frame
 * is done and the next frame takes it again, so the pool workers - which
 * collect by the volume of shared memory they have not seen before - stop
 * collecting inside frames. Reuse must never show in a result: a spare
 * holds the last frame's bytes, and every taker either writes all of it
 * or asks for it zeroed.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const { HAS_SAB, takeShared, giveShared, sharedAllocated } = require("../lib/shared.js");
const { shutdown, poolSize } = require("../lib/pool.js");

test.after(() => shutdown());

test("a spare is handed out again, zeroed when asked, and bounded", { skip: !HAS_SAB }, () => {
	const a = takeShared(Uint8Array, 4099);
	a.fill(7);
	giveShared(a);
	giveShared(a);
	const before = sharedAllocated();
	const b = takeShared(Uint8Array, 4099, false);
	assert.strictEqual(b.buffer, a.buffer, "the spare, not a new buffer");
	assert.strictEqual(sharedAllocated(), before, "nothing allocated");
	assert.strictEqual(b[0], 7, "unzeroed when not asked");
	giveShared(b);
	const c = takeShared(Uint8Array, 4099);
	assert.ok(c.every((v) => v === 0), "zeroed when asked");
	const d = takeShared(Uint8Array, 4099);
	assert.notStrictEqual(d.buffer, c.buffer, "given back twice, handed out once");
	// by byte length, whatever the element type
	const e = takeShared(Uint8Array, 4096);
	giveShared(e);
	assert.strictEqual(takeShared(Uint32Array, 1024).buffer, e.buffer);
	// only so many kept per size
	const many = Array.from({ length: 40 }, () => takeShared(Uint8Array, 333));
	for (const m of many) giveShared(m);
	const buffers = new Set(many.map((m) => m.buffer));
	let reused = 0;
	for (let i = 0; i < 40; i++) if (buffers.has(takeShared(Uint8Array, 333).buffer)) reused++;
	assert.ok(reused > 0 && reused < 40, `${reused} of 40 kept`);
});

const W = 900;
const H = 1200;
function labelSvg(extra = "") {
	const bars = [];
	for (let i = 0; i < 10; i++) {
		bars.push(`<rect x="110" y="${80 + i * 100 + (i % 3) * 7}" width="${i % 2 ? 420 : 640}" height="26" fill="#111"/>`);
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="#111" stroke-width="8"/>` +
			bars.join("") +
			extra +
			`</svg>`,
	);
}

const CFG = {
	workingSize: H,
	threshold: 128,
	thresholdMode: "otsu",
	sauvolaRadius: 24,
	sauvolaK: 0.2,
	inkMargin: 8,
	scaleSearchMin: 0.6,
	scaleSearchMax: 2.5,
	scaleSearchSteps: 37,
	alignCandidates: 5,
	workers: 4,
	localAlign: true,
	localAlignTile: 96,
	localAlignMax: 3,
	maxAspect: 0.06,
	aspectSteps: 7,
	maxAngleDeg: 2,
	angleSteps: 5,
	positionToleranceAngleDeg: 1,
	printTolerance: 2,
	backgroundTolerance: 1,
	edgeMargin: 0,
	alignSearch: 16,
	positionToleranceXPx: 16,
	positionToleranceYPx: 16,
	blockSize: 16,
	blockThreshold: 0.15,
	failThreshold: 0.3,
	failRatio: 0.002,
	printMissingFraction: 0.5,
	toneThreshold: 0.3,
	toneMargin: 6,
	speckThreshold: 0.3,
	speckMinArea: 3,
	speckMaxCount: 8,
	speckMaxArea: 48,
	outputHeatmap: true,
	heatmapFormat: "raw",
	debugStages: false,
};

const NO_POOL = !HAS_SAB ? "no SharedArrayBuffer" : poolSize(4) < 2 ? "no worker pool on this host" : false;

test("a frame hands its scratch back, and a dirty spare changes nothing", { skip: NO_POOL }, async () => {
	const golden = await prepareGolden(await sharp(labelSvg()).png().toBuffer(), CFG);
	const frames = [
		await sharp(labelSvg('<rect x="300" y="500" width="90" height="60" fill="#000"/>')).png().toBuffer(),
		await sharp(labelSvg('<circle cx="600" cy="900" r="40" fill="#000"/>')).png().toBuffer(),
	];
	const strip = (r) => JSON.stringify({ ...r, timings: null, heatmap: r.heatmap && Buffer.from(r.heatmap.data).toString("base64") });
	// each frame first on fresh buffers only: every spare of the frame's
	// size taken and held, so the frame allocates its own
	const clean = [];
	for (const f of frames) {
		for (let i = 0; i < 16; i++) takeShared(Uint8Array, golden.width * golden.height);
		clean.push(strip(await compareFrame(f, golden, CFG)));
	}
	// what one frame gave back is there to take, without allocating
	const n = golden.width * golden.height;
	const before = sharedAllocated();
	const spare = takeShared(Uint8Array, n, false);
	assert.strictEqual(sharedAllocated(), before, "the frame gave its full-size scratch back");
	giveShared(spare);
	// now every spare of the frame's size full of junk, and the frames in
	// turn, twice: the results must not move
	const junk = Array.from({ length: 16 }, () => takeShared(Uint8Array, n, false));
	for (const j of junk) {
		for (let i = 0; i < j.length; i++) j[i] = (i * 31 + 7) & 255;
		giveShared(j);
	}
	for (let round = 0; round < 2; round++) {
		for (let k = 0; k < frames.length; k++) {
			assert.strictEqual(strip(await compareFrame(frames[k], golden, CFG)), clean[k], `frame ${k}, round ${round}`);
		}
	}
});

test("a raw stage that is the frame's own grey is not handed out again", { skip: NO_POOL }, async () => {
	const cfg = { ...CFG, debugStages: true };
	const golden = await prepareGolden(await sharp(labelSvg()).png().toBuffer(), cfg);
	const a = await compareFrame(await sharp(labelSvg('<rect x="300" y="500" width="90" height="60" fill="#000"/>')).png().toBuffer(), golden, cfg);
	const kept = Buffer.from(a.stages.targetGrayAligned.data);
	await compareFrame(await sharp(labelSvg('<circle cx="600" cy="900" r="40" fill="#000"/>')).png().toBuffer(), golden, cfg);
	assert.ok(Buffer.from(a.stages.targetGrayAligned.data).equals(kept), "the next frame wrote over a stage still held");
});
