/**
 * Regression tests for the worker-pool hardening:
 *
 *  - a dispatch settled only on 'message' or 'error', so a worker
 *    terminated mid-dispatch (pool shutdown, a crashing sibling) emitted
 *    only 'exit' and the dispatch promise never settled - the frame hung
 *    silently. It must reject instead.
 *  - the defect counter slots were a fixed 64; a pool larger than that
 *    dropped the later workers' counts silently (a typed-array write past
 *    the end is a no-op, not a RangeError). They are now sized from the
 *    pool.
 *  - toShared returned a sliced view unchanged, so a worker rebuilding
 *    `new Uint8Array(buffer)` at offset 0 would read the wrong bytes.
 *  - toShared built Buffers with the deprecated `new Buffer(SAB)` form
 *    (DEP0005) on every parallel frame.
 */

const test = require("node:test");
const assert = require("node:assert");
const { runRanges, poolSize, shutdown } = require("../lib/pool.js");
const { defectParallel } = require("../lib/parallel.js");
const { toShared, allocU8, HAS_SAB } = require("../lib/shared.js");

test.after(() => shutdown());

test("a dispatch rejects when its worker is terminated mid-flight", {
	skip: !HAS_SAB,
}, async () => {
	// 10M rows of width-100 dilation is far more than any worker can
	// finish in the 150ms before the pool is torn down, so the workers are
	// still mid-range when terminated - and previously the dispatch never
	// settled, hanging the frame forever
	const width = 100;
	const total = 10_000_000;
	const src = toShared(new Uint8Array(width * 100)).buffer;
	const tmp = toShared(new Uint8Array(width * 100)).buffer;
	const p = runRanges(
		"dilateRows",
		{ src, tmp, width, height: total, radius: 1 },
		total,
		2,
	);
	assert.ok(p, "precondition: the pool should have been created");
	await new Promise((r) => setTimeout(r, 150));
	shutdown();
	await assert.rejects(p, /worker exited/);
});

test("defect counts stay exact with a pool larger than 64 workers", {
	skip: !HAS_SAB,
}, async () => {
	// width*height must clear the split threshold (400k px) and height
	// must exceed 64 so worker index 64 gets rows of its own; the fixed
	// 64-slot counter dropped that worker's count (a silent no-op write)
	const width = 1000;
	const height = 500;
	const a = new Uint8Array(width * height);
	const b = new Uint8Array(width * height);
	// rows 492..499 (8 rows x 10 px = 80) are worker index 64's share of
	// the 500 rows
	for (let y = 492; y < 500; y++) {
		for (let x = 0; x < 10; x++) a[y * width + x] = 1;
	}
	const par = await defectParallel(a, b, null, null, width, height, 65);
	assert.ok(par, "precondition: the image must be big enough to split");
	assert.strictEqual(par.count, 80, "the last worker's rows must be counted");
	assert.strictEqual(par.defect[492 * width], 1);
	assert.strictEqual(par.defect[499 * width + 9], 1);
	assert.strictEqual(par.defect[491 * width], 0);
});

test("poolSize reports the worker count getPool will create", () => {
	assert.strictEqual(poolSize(4), 4);
	assert.strictEqual(poolSize(65), 65);
	assert.strictEqual(poolSize(1), 0); // one worker means "no pool"
	// auto = cores-based, capped at 16. The cap was 8 until the alignment
	// polish was measured against it: unlike the defect scan it is a run of
	// short sequential batches, and it keeps improving to ~12 workers.
	const auto = poolSize(0);
	assert.ok(
		auto === 0 || (auto >= 1 && auto <= 16),
		`auto pool size ${auto} outside the expected range`,
	);
});

test("toShared copies a sliced view into a zero-offset SharedArrayBuffer", {
	skip: !HAS_SAB,
}, () => {
	const backing = new Uint8Array(64);
	for (let i = 0; i < backing.length; i++) backing[i] = i;
	const slice = backing.subarray(10, 20);
	const shared = toShared(slice);
	assert.ok(shared.buffer instanceof SharedArrayBuffer);
	assert.strictEqual(shared.byteOffset, 0);
	assert.strictEqual(shared.byteLength, 10);
	assert.deepStrictEqual(Array.from(shared), Array.from(slice));
});

test("toShared copies a slice of a SharedArrayBuffer view too", {
	skip: !HAS_SAB,
}, () => {
	const backing = allocU8(64);
	backing.fill(3);
	const shared = toShared(backing.subarray(8, 12));
	assert.ok(shared.buffer instanceof SharedArrayBuffer);
	assert.strictEqual(shared.byteOffset, 0);
	assert.strictEqual(shared.byteLength, 4);
	assert.deepStrictEqual(Array.from(shared), [3, 3, 3, 3]);
});

test("toShared copies a Buffer without the deprecated Buffer(SAB) form", {
	skip: !HAS_SAB,
}, () => {
	const buf = Buffer.from([1, 2, 3, 4, 5]);
	const shared = toShared(buf);
	assert.ok(shared.buffer instanceof SharedArrayBuffer);
	assert.strictEqual(shared.constructor, Uint8Array);
	assert.deepStrictEqual(Array.from(shared), [1, 2, 3, 4, 5]);
});

test("toShared returns an already-shared, zero-offset view unchanged", {
	skip: !HAS_SAB,
}, () => {
	const v = allocU8(16);
	assert.strictEqual(toShared(v), v);
});
