/**
 * The global threshold. One case here came out of the synthetic-defect
 * benchmark rather than a real part: pure two-level artwork - what a PDF
 * renders to without antialiasing, or a golden that was binarised before
 * it was saved - used at native working size, so no resample ever puts a
 * grey between its two levels. Otsu's between-class variance is then the
 * same at every level between the modes, and taking the first of them
 * made the ink level 0: nothing darker than black, an empty golden, and
 * a whole inspection reported against it with zero print defect.
 */

const test = require("node:test");
const assert = require("node:assert");
const { otsuThreshold, thresholdForeground } = require("../lib/threshold.js");

function twoLevel(width, height, dark, light, inkEvery) {
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < gray.length; i++) gray[i] = i % inkEvery === 0 ? dark : light;
	return gray;
}

test("two-level artwork thresholds between its levels, not at the dark one", () => {
	const gray = twoLevel(200, 300, 0, 255, 9);
	const level = otsuThreshold(gray);
	assert.ok(level > 0 && level < 255, `level ${level}`);
	const { fg } = thresholdForeground(gray, 200, 300, { thresholdMode: "otsu", inkMargin: 0 });
	let ink = 0;
	for (const v of fg) ink += v;
	assert.strictEqual(ink, Math.ceil(gray.length / 9), "every dark pixel is ink");
});

test("the level lands mid-gap whatever the two levels are", () => {
	const level = otsuThreshold(twoLevel(100, 100, 40, 200, 5));
	assert.ok(level >= 100 && level <= 140, `level ${level}`);
});

test("a photograph-like histogram is unchanged: one level, between the modes", () => {
	// two broad modes, no empty gap between them
	const gray = new Uint8Array(400 * 400);
	let seed = 7;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (let i = 0; i < gray.length; i++) {
		const ink = i % 7 === 0;
		const g = (ink ? 50 : 210) + Math.round((rnd() + rnd() + rnd() - 1.5) * 40);
		gray[i] = Math.max(0, Math.min(255, g));
	}
	const level = otsuThreshold(gray);
	assert.ok(level > 90 && level < 170, `level ${level}`);
});

test("a uniform image has no ink", () => {
	const gray = new Uint8Array(1000).fill(180);
	assert.strictEqual(otsuThreshold(gray), 0);
});
