/**
 * Two frames in flight at once.
 *
 * Node-RED does not await a node's input handler, so a second message
 * enters compareFrame while the first is still inside it. Everything here
 * is about that overlap, and none of it failed loudly before:
 *
 *  - A dispatch used to be settled by the *next* message from its worker,
 *    whichever dispatch that message actually answered: `once("message")`
 *    was registered per dispatch, and EventEmitter delivers one emit to
 *    every listener registered at the time. So with two dispatches queued
 *    on one worker, the first reply resolved both, and the second caller
 *    read an output buffer that was still being written. End to end that
 *    showed up as two concurrent frames both reporting
 *    transform.score = 0 - which is not an error value. It is a perfect
 *    match, it beats every other candidate, and the part passes.
 *  - The pool was rebuilt whenever a different worker count was requested,
 *    which `msg.workers` and a second differently-configured node both
 *    reach. The teardown terminated workers another frame was waiting on,
 *    failing that frame for no fault of its own.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { runRanges, shutdown, poolSize } = require("../lib/pool.js");
const { toShared, allocU8, HAS_SAB } = require("../lib/shared.js");

test.after(() => shutdown());

test("concurrent dispatches settle on their own replies, not each other's", {
	skip: !HAS_SAB,
}, async () => {
	// The order matters. A is *short* and B is *long*, both queued on the
	// same workers: A replies almost immediately, and it is that first reply
	// which used to settle B as well - at a point where B has provably
	// written almost none of its output. (Long-then-short does not
	// reproduce it: the short dispatch finishes for real in the microtask
	// gap and the assertion passes for the wrong reason.)
	const width = 100;
	const shortRows = 64;
	const longRows = 10_000_000;

	const srcA = toShared(new Uint8Array(width * shortRows));
	const tmpA = allocU8(width * shortRows);
	const srcB = toShared(new Uint8Array(width * 256));
	const tmpB = allocU8(width * 256);
	// a value the kernel propagates, so "was it actually written" is
	// observable rather than inferred from timing
	srcB.fill(200);

	const a = runRanges(
		"dilateRows",
		{ src: srcA.buffer, tmp: tmpA.buffer, width, height: shortRows, radius: 1 },
		shortRows,
		2,
	);
	const b = runRanges(
		"dilateRows",
		{ src: srcB.buffer, tmp: tmpB.buffer, width, height: longRows, radius: 1 },
		longRows,
		2,
	);
	assert.ok(a && b, "precondition: both dispatches should have reached the pool");

	await a;
	// B must still be running: it has 10M rows to go and A has just landed.
	// If B has already settled here, it settled on A's reply.
	let bSettled = false;
	b.then(
		() => {
			bSettled = true;
		},
		() => {
			bSettled = true;
		},
	);
	await new Promise((r) => setTimeout(r, 50));
	assert.strictEqual(
		bSettled,
		false,
		"B settled while it was still running - it took another dispatch's reply",
	);

	shutdown(); // B is enormous on purpose; do not wait for it
	await assert.rejects(b, /worker exited/);
});

test("a differently-sized request does not tear down a pool in use", {
	skip: !HAS_SAB,
}, async () => {
	// The first dispatch is far too big to finish before the second arrives
	// asking for a different worker count. That used to call shutdown(),
	// terminating the workers the first was still waiting on and rejecting
	// it with "worker exited".
	const width = 100;
	const hugeRows = 10_000_000;
	const src = toShared(new Uint8Array(width * 256));
	const tmp = allocU8(width * 256);

	const first = runRanges(
		"dilateRows",
		{ src: src.buffer, tmp: tmp.buffer, width, height: hugeRows, radius: 1 },
		hugeRows,
		2,
	);
	assert.ok(first, "precondition: the pool should have been created");
	let firstFailed = null;
	first.catch((err) => {
		firstFailed = err;
	});

	const src2 = toShared(new Uint8Array(width * 64));
	const tmp2 = allocU8(width * 64);
	const second = runRanges(
		"dilateRows",
		{ src: src2.buffer, tmp: tmp2.buffer, width, height: 64, radius: 1 },
		64,
		4,
	);
	assert.ok(second, "precondition: the second dispatch should have run");
	// deliberately not awaited: a worker takes its messages in order, so a
	// small dispatch queues behind a huge one on the same workers. That
	// head-of-line blocking is pre-existing and is not what this test is
	// about - the question is only whether `first` survived.
	second.catch(() => {});

	await new Promise((r) => setTimeout(r, 50));
	assert.strictEqual(
		firstFailed && firstFailed.message,
		null,
		"the in-flight dispatch was terminated by a request for a different size",
	);

	shutdown();
	await assert.rejects(first, /worker exited/);
});

test("a smaller request uses a prefix of a grown pool, keeping indices in range", {
	skip: !HAS_SAB,
}, async () => {
	// defectParallel sizes its per-worker counter slots from poolSize(size)
	// before dispatching, so a dispatch must never hand a kernel an index
	// past that. Grow the pool wide, then ask for fewer.
	const { defectParallel } = require("../lib/parallel.js");
	const width = 1000;
	const height = 500;
	const a = new Uint8Array(width * height);
	const b = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < 4; x++) a[y * width + x] = 1;
	}

	const wide = await defectParallel(a, b, null, null, width, height, 8);
	assert.ok(wide, "precondition: wide dispatch should have parallelised");
	assert.strictEqual(wide.count, height * 4);

	// now a narrower request against the same (already 8-wide) pool
	const narrow = await defectParallel(a, b, null, null, width, height, 3);
	assert.ok(narrow, "precondition: narrow dispatch should have parallelised");
	assert.strictEqual(
		narrow.count,
		height * 4,
		"a narrower dispatch on a grown pool dropped or double-counted rows",
	);
	assert.strictEqual(poolSize(3), 3);
});
