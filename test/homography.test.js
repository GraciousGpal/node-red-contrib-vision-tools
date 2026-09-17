/**
 * lib/homography.js and lib/rectify.js: the numeric pieces behind the
 * perspective calibration, checked against transforms with known answers.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
	fitSimilarity,
	applySimilarity,
	fitHomography,
	applyHomography,
	invertHomography,
	rescaleHomography,
	reprojection,
	isIdentityLike,
	validateHomography,
} = require("../lib/homography.js");
const { warpPerspective } = require("../lib/rectify.js");

const grid = (n, step, x0 = 100, y0 = 100) => {
	const pts = [];
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) pts.push({ x: x0 + c * step, y: y0 + r * step });
	}
	return pts;
};

const near = (a, b, eps, what) =>
	assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b} (eps ${eps})`);

test("fitSimilarity recovers scale, rotation and translation exactly", () => {
	const src = grid(4, 50);
	const truth = {
		s: 1.25,
		cos: Math.cos(0.3),
		sin: Math.sin(0.3),
		tx: -40,
		ty: 17,
	};
	const dst = src.map((p) => applySimilarity(truth, p));
	const sim = fitSimilarity(src, dst);
	near(sim.s, truth.s, 1e-12, "scale");
	near(sim.cos, truth.cos, 1e-12, "cos");
	near(sim.sin, truth.sin, 1e-12, "sin");
	near(sim.tx, truth.tx, 1e-9, "tx");
	near(sim.ty, truth.ty, 1e-9, "ty");
	near(sim.angleDeg, (0.3 * 180) / Math.PI, 1e-9, "angle");
});

test("fitHomography recovers a known keystone to floating-point precision", () => {
	// a trapezoid: the top edge pulled in by 8% either side
	const W = 4000;
	const H = 3000;
	const corners = [
		{ x: 0, y: 0 },
		{ x: W, y: 0 },
		{ x: W, y: H },
		{ x: 0, y: H },
	];
	const keystoned = [
		{ x: W * 0.08, y: 0 },
		{ x: W * 0.92, y: 0 },
		{ x: W, y: H },
		{ x: 0, y: H },
	];
	const truth = fitHomography(corners, keystoned);
	// four points determine it exactly
	for (let i = 0; i < 4; i++) {
		const q = applyHomography(truth, corners[i].x, corners[i].y);
		near(q.x, keystoned[i].x, 1e-9, `corner ${i} x`);
		near(q.y, keystoned[i].y, 1e-9, `corner ${i} y`);
	}
	// an over-determined fit on 36 interior points recovers the same map
	const src = grid(6, 400, 500, 300);
	const dst = src.map((p) => applyHomography(truth, p.x, p.y));
	const fitted = fitHomography(src, dst);
	fitted.forEach((v, i) => near(v, truth[i], 1e-9 * Math.max(1, Math.abs(truth[i])), `H[${i}]`));
	const { rms, max } = reprojection(fitted, src, dst);
	assert.ok(rms < 1e-8 && max < 1e-8, `reprojection ${rms}/${max}`);
});

test("fitHomography is least-squares on noisy points, not thrown by them", () => {
	const truth = [1.05, 0.02, -30, -0.01, 1.04, 12, 2e-6, 5e-6, 1];
	const src = grid(8, 300, 200, 200);
	let seed = 7;
	const noise = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return (seed / 0x7fffffff - 0.5) * 0.4; // +/- 0.2px
	};
	const dst = src.map((p) => {
		const q = applyHomography(truth, p.x, p.y);
		return { x: q.x + noise(), y: q.y + noise() };
	});
	const fitted = fitHomography(src, dst);
	const { rms, max } = reprojection(fitted, src, dst);
	assert.ok(rms < 0.2, `rms ${rms}`);
	assert.ok(max < 0.5, `max ${max}`);
});

test("fitHomography refuses degenerate input", () => {
	assert.throws(() => fitHomography(grid(1, 1), grid(1, 1)), /at least 4/);
	const line = [0, 1, 2, 3].map((i) => ({ x: i * 10, y: 5 }));
	assert.throws(() => fitHomography(line, line), /degenerate/);
});

test("invertHomography composes to the identity", () => {
	const H = [1.1, 0.05, -20, -0.02, 0.95, 30, 1e-5, -2e-5, 1];
	const inv = invertHomography(H);
	const p = applyHomography(inv, ...Object.values(applyHomography(H, 123, 456)));
	near(p.x, 123, 1e-9, "x");
	near(p.y, 456, 1e-9, "y");
	assert.strictEqual(inv[8], 1);
});

test("rescaleHomography follows the same field of view at another resolution", () => {
	const H = [1.1, 0.05, -20, -0.02, 0.95, 30, 1e-5, -2e-5, 1];
	const from = { width: 4000, height: 3000 };
	const to = { width: 2000, height: 1500 };
	const H2 = rescaleHomography(H, from, to);
	// a point at full res and its half-res twin must land on twins
	const a = applyHomography(H, 1000, 900);
	const b = applyHomography(H2, 500, 450);
	near(b.x * 2, a.x, 1e-9, "x");
	near(b.y * 2, a.y, 1e-9, "y");
	assert.deepStrictEqual(rescaleHomography(H, from, from), H);
	assert.throws(
		() => rescaleHomography(H, from, { width: 2000, height: 1000 }),
		/aspect ratio/,
	);
});

test("validateHomography accepts what fitHomography produces and refuses junk", () => {
	const H = fitHomography(grid(3, 10), grid(3, 11));
	assert.strictEqual(validateHomography(H), null);
	assert.match(validateHomography([1, 2, 3]), /9 numbers/);
	assert.match(validateHomography([1, 0, 0, 0, 1, 0, 0, 0, 2]), /normalised/);
	assert.match(validateHomography([1, 0, 0, 0, 1, 0, 0, 0, NaN]), /finite/);
	assert.match(validateHomography([0, 0, 0, 0, 0, 0, 0, 0, 1]), /singular/);
	assert.match(validateHomography("nope"), /array/);
});

test("warpPerspective returns the input untouched for the identity", () => {
	const src = { data: new Uint8Array(12), width: 2, height: 2, channels: 3 };
	assert.strictEqual(warpPerspective(src, [1, 0, 0, 0, 1, 0, 0, 0, 1]), src);
});

test("warpPerspective: a pure translation moves pixels by exactly that much", () => {
	const W = 16;
	const H = 12;
	const src = { data: new Uint8Array(W * H), width: W, height: H, channels: 1 };
	src.data[5 * W + 7] = 200;
	// H maps source -> rectified: shift right 3, down 2
	const out = warpPerspective(src, [1, 0, 3, 0, 1, 2, 0, 0, 1]);
	assert.notStrictEqual(out, src);
	assert.strictEqual(out.data[7 * W + 10], 200);
	assert.strictEqual(out.data[5 * W + 7], 0);
});

test("warpPerspective replicates the border instead of filling it", () => {
	const W = 8;
	const H = 8;
	const data = new Uint8Array(W * H * 3).fill(90);
	// a bright left column
	for (let y = 0; y < H; y++) data.set([250, 240, 230], y * W * 3);
	const src = { data, width: W, height: H, channels: 3 };
	// shift right by 4: the left half of the output samples off the left
	// edge and must carry the edge column's colour, not black
	const out = warpPerspective(src, [1, 0, 4, 0, 1, 0, 0, 0, 1]);
	for (let x = 0; x < 4; x++) {
		assert.deepStrictEqual([...out.data.subarray(x * 3, x * 3 + 3)], [250, 240, 230]);
	}
	assert.deepStrictEqual([...out.data.subarray(15, 18)], [90, 90, 90]);
});

test("warpPerspective's bilinear step lands on the interpolated value", () => {
	const W = 4;
	const H = 1;
	const src = { data: new Uint8Array([0, 100, 200, 250]), width: W, height: H, channels: 1 };
	// output x samples source x - 0.5
	const out = warpPerspective(src, [1, 0, 0.5, 0, 1, 0, 0, 0, 1]);
	assert.deepStrictEqual([...out.data], [0, 50, 150, 225]);
});

test("isIdentityLike tolerates float noise and nothing else", () => {
	assert.ok(isIdentityLike([1 + 1e-15, 0, 1e-13, 0, 1, 0, 0, 0, 1], 1e-9));
	assert.ok(!isIdentityLike([1, 0, 0.5, 0, 1, 0, 0, 0, 1], 1e-9));
});
