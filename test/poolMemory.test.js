/**
 * The pool must not hold on to finished frames: lib/shared.js has the
 * why and the measurements. The first test drives frames through the
 * pool and asserts the shared buffers still in flight stay under one
 * collection interval plus a frame's working set; the second drives the
 * allocators on this thread directly. Both must fail with the collector
 * taken away - a `-r` preload that sets `globalThis.gc = Math.random`
 * gives every thread a native function that collects nothing - which the
 * first does by itself and the second only over enough intervals that
 * V8's own ~800 MB collection is not what passes it.
 *
 * Reads process.memoryUsage().arrayBuffers, which counts SharedArrayBuffer
 * backing stores owned by this process - every frame's intermediates.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const { HAS_SAB, GC_EVERY_BYTES, sharedAllocated, allocU8 } = require("../lib/shared.js");
const { shutdown, poolSize, gcPhase } = require("../lib/pool.js");
const { setTimeout: sleep } = require("node:timers/promises");

const W = 900;
const H = 1200;

function labelSvg() {
	const bars = [];
	for (let i = 0; i < 10; i++) {
		const y = 80 + i * 100 + (i % 3) * 7;
		bars.push(`<rect x="110" y="${y}" width="${i % 2 ? 420 : 640}" height="26" fill="#111"/>`);
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="#111" stroke-width="8"/>` +
			bars.join("") +
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
	workers: 0,
	mismatchScore: 0.15,
	minCoverage: 0.5,
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
	outputHeatmap: false,
	outputPrintHeatmap: false,
	outputBackgroundHeatmap: false,
	outputToneHeatmap: false,
	outputSpeckHeatmap: false,
	debugStages: false,
};

// On a host with too few cores for a pool this would pass without testing
// anything: the serial path allocates through the same allocators.
const NO_POOL = !HAS_SAB ? "no SharedArrayBuffer" : poolSize(0) < 2 ? "no worker pool on this host" : false;

test("shared buffers from finished frames are released while the pool runs", { skip: NO_POOL }, async (t) => {
	t.after(() => shutdown());
	const frame = await sharp(labelSvg()).png().toBuffer();
	const golden = await prepareGolden(frame, { ...CFG });
	const first = await compareFrame(frame, golden, { ...CFG });
	const cfg = { ...CFG, pinnedScale: { mx: first.transform.scaleX, my: first.transform.scaleY } };

	// how much one frame allocates, from the allocator's own count, so the
	// run is sized in collection intervals rather than in a frame count
	// that drifts with the image
	const before = sharedAllocated();
	await compareFrame(frame, golden, { ...cfg });
	const perFrame = sharedAllocated() - before;
	assert.ok(perFrame > 1e6, `a frame allocated only ${perFrame} shared bytes; is the pool in use?`);
	const frames = Math.ceil((GC_EVERY_BYTES * 3) / perFrame) + 2;
	assert.ok(frames < 400, `${frames} frames would take too long at ${perFrame} bytes a frame`);

	let peak = 0;
	for (let i = 0; i < frames; i++) {
		await compareFrame(frame, golden, { ...cfg });
		peak = Math.max(peak, process.memoryUsage().arrayBuffers);
	}
	// one interval of not-yet-collected buffers, plus two frames in flight
	const bound = GC_EVERY_BYTES + 2 * perFrame;
	assert.ok(
		peak < bound,
		`shared buffers peaked at ${(peak / 1e6).toFixed(0)} MB over ${frames} frames; bound ${(bound / 1e6).toFixed(0)} MB`,
	);
});

// Every worker is shown the same new buffers, so workers that start their
// collection intervals together collect in the same frame, and twelve
// collections at once stalled a frame in eight on the rig to twice its
// time. Each worker's count, as lib/poolWorker.js keeps it, over a run
// of frames that each bring every worker 9 MB of new buffers.
test("pool workers spread their collections over the frames", () => {
	const interval = GC_EVERY_BYTES / 2;
	const perFrame = 9 * 1024 * 1024;
	for (const workers of [4, 12, 15]) {
		const count = Array.from({ length: workers }, (_, i) => gcPhase(i) * interval);
		const collected = new Set();
		let most = 0;
		for (let frame = 0; frame < 200; frame++) {
			let now = 0;
			for (let i = 0; i < workers; i++) {
				count[i] += perFrame;
				if (count[i] < interval) continue;
				count[i] = 0;
				now++;
				collected.add(i);
			}
			most = Math.max(most, now);
		}
		assert.equal(collected.size, workers, `${workers} workers: one never collected`);
		assert.ok(most <= Math.ceil((workers * perFrame) / interval) + 1, `${workers} workers: ${most} collected in one frame`);
	}
});

// The allocating thread's half, on its own. At 1 MP a frame the pool
// workers' collections keep the test above under its bound by themselves,
// so this drives the allocators directly, holding each batch across two
// minor collections first, as a frame holds its buffers, because a batch
// dropped young is freed by the scavenger. Sixteen intervals, not three:
// with no collector V8 still collects promoted shared buffers at about
// 800 MB on its own, and a shorter run peaked under the bound without
// anyone's help.
test("the allocators collect by volume on their own thread", { skip: !HAS_SAB && "no SharedArrayBuffer" }, async () => {
	const chunk = 4 * 1024 * 1024;
	const perBatch = 16;
	const batches = Math.ceil((GC_EVERY_BYTES * 16) / (chunk * perBatch));
	let peak = 0;
	for (let b = 0; b < batches; b++) {
		const held = [];
		for (let i = 0; i < perBatch; i++) held.push(allocU8(chunk));
		for (let turn = 0; turn < 2; turn++) {
			// enough young garbage to make the scavenger run while the batch
			// is still referenced, which promotes it
			const junk = new Array(20000).fill(0).map((_, i) => ({ i }));
			if (junk.length < 0) throw new Error("unreachable");
			await sleep(1);
		}
		held.length = 0;
		peak = Math.max(peak, process.memoryUsage().arrayBuffers);
	}
	const bound = GC_EVERY_BYTES + 2 * chunk * perBatch;
	assert.ok(
		peak < bound,
		`shared buffers peaked at ${(peak / 1e6).toFixed(0)} MB over ${batches} batches; bound ${(bound / 1e6).toFixed(0)} MB`,
	);
});
