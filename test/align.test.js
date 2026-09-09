/**
 * Regression tests for the transform-search helpers.
 *
 * Two bugs live here:
 *
 *  - scaleLadder(min, max, steps) returned [1] whenever min === max, so
 *    pinning magnification to mx=my=2.0 silently searched at 1.0;
 *  - a corrupted trained transform with a huge-but-finite scale overflows
 *    centerX/halfRange to Infinity, and offsetsAround's walk
 *    `for (d = step; d <= halfRange; d += step)` with both Infinity is
 *    true forever - a synchronous infinite loop that freezes the whole
 *    Node-RED process.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
	buildGoldenSignature,
	scaleLadder,
	offsetsAround,
	findTransform,
} = require("../lib/align.js");

test("a pinned ladder (min === max) returns the pinned value, not 1", () => {
	assert.deepStrictEqual(scaleLadder(2, 2, 19), [2]);
	assert.deepStrictEqual(scaleLadder(2, 2, 1), [2]);
	assert.deepStrictEqual(scaleLadder(2, 2, 0), [2]);
});

test("an inverted ladder degrades to the single min rung", () => {
	assert.deepStrictEqual(scaleLadder(2.5, 0.6, 19), [2.5]);
});

test("scaleLadder rejects a non-positive min cleanly", () => {
	// previously this grew an unbounded array and died with a RangeError
	// from deep inside the loop; a named RangeError with a message is the
	// whole point of the guard
	assert.throws(() => scaleLadder(0, 2, 19), RangeError);
	assert.throws(() => scaleLadder(-1, 2, 19), RangeError);
});

test("scaleLadder spans min..max, increasing, and always includes exactly 1.0", () => {
	const ladder = scaleLadder(0.6, 2.5, 19);
	assert.ok(ladder.includes(1), "1.0 must be one of the hypotheses");
	assert.ok(
		ladder[0] >= 0.6 && ladder[0] <= 0.6 * 1.1,
		`first rung ${ladder[0]}`,
	);
	assert.ok(
		ladder[ladder.length - 1] <= 2.5 * 1.0001 &&
			ladder[ladder.length - 1] >= 2.5 / 1.1,
		`last rung ${ladder[ladder.length - 1]}`,
	);
	for (let i = 1; i < ladder.length; i++) {
		assert.ok(ladder[i] > ladder[i - 1], "rungs must be strictly increasing");
	}
});

test("offsetsAround walks outward from the center, center always included", () => {
	assert.deepStrictEqual(offsetsAround(5, 10, 4), [5, 1, 9, -3, 13]);
	assert.deepStrictEqual(offsetsAround(5, 0, 4), [5]);
});

test("offsetsAround with a degenerate range searches only the center", () => {
	// the hang guard: Infinity <= Infinity is true forever
	assert.deepStrictEqual(offsetsAround(5, Infinity, Infinity), [5]);
	assert.deepStrictEqual(offsetsAround(5, 10, 0), [5]);
	assert.deepStrictEqual(offsetsAround(5, 10, -2), [5]);
	assert.deepStrictEqual(offsetsAround(5, -1, 2), [5]);
	assert.deepStrictEqual(offsetsAround(5, Infinity, 2), [5]);
	assert.deepStrictEqual(offsetsAround(5, 10, Infinity), [5]);
});

test("a pinned transform with absurd scales completes instead of hanging", async () => {
	// a corrupted trained transform (mx = 1e300, finite but absurd) makes
	// centerX = (tW - mx*gW)/2 = -Infinity and halfRange = Infinity. The
	// sweep must degrade to the exact center rather than spin forever.
	const gW = 100;
	const gH = 100;
	const tW = 400;
	const tH = 400;
	const goldenFg = new Uint8Array(gW * gH);
	const sig = buildGoldenSignature(goldenFg, gW, gH, 24, 24);
	const signatures = { coarse: sig, medium: sig, fine: sig };
	const result = await findTransform(
		gW,
		gH,
		new Uint8Array(tW * tH),
		tW,
		tH,
		signatures,
		{
			pinnedScale: { mx: 1e300, my: 1e300 },
			slackPx: 16,
			maxAngleDeg: 2,
			angleSteps: 5,
		},
	);
	assert.strictEqual(result.pinned, true);
	assert.strictEqual(result.mx, 1e300);
	// nothing on-frame is matchable from -Infinity, so the sweep must
	// report no score rather than a bogus finite one
	assert.strictEqual(result.score, Infinity);
});
