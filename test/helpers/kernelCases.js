/**
 * Synthetic dispatches for the five kernels lib/nativeKernels.js replaces,
 * as lib/parallel.js and lib/compare.js build them: every buffer a
 * SharedArrayBuffer, every scalar the pool would send. Seeded, so a
 * failing case can be named and run again.
 *
 * The inputs lean on what a native port gets wrong: Math.round's ties
 * (half-pixel displacements), offsets that push a tile off the frame,
 * flat images where every SSD ties, a 96 px tile (the 32-sample row the
 * SSD has its own loop for), a dilation wider than the image, fractional
 * levels, a span of 0 or NaN, masks left dirty by the last frame.
 */

"use strict";

function rng(seed) {
	let s = seed >>> 0 || 1;
	const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
	const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
	const pick = (list) => list[Math.floor(rnd() * list.length)];
	return { rnd, ri, pick };
}

const sab = (Ctor, n) => new Ctor(new SharedArrayBuffer(Math.max(1, n) * Ctor.BYTES_PER_ELEMENT));
const claim = (total, chunk) => ({ next: sab(Uint32Array, 1).buffer, total, chunk });

/** A textured grey: waves, ink bars and noise, or flat when `flat`. */
function texture(R, w, h, flat = false) {
	const g = sab(Uint8Array, w * h);
	if (flat) return g.fill(R.ri(0, 255)), g;
	const fx = R.ri(4, 15);
	const fy = R.ri(4, 15);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const v = 128 + 70 * Math.sin(x / fx) * Math.cos(y / fy) + R.ri(-12, 12);
			g[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
		}
	}
	for (let k = R.ri(0, 12); k > 0; k--) {
		const x0 = R.ri(0, w - 1);
		const y0 = R.ri(0, h - 1);
		const v = R.ri(0, 60);
		for (let y = y0; y < Math.min(h, y0 + R.ri(2, 30)); y++) g.fill(v, y * w + x0, y * w + Math.min(w, x0 + R.ri(2, 80)));
	}
	return g;
}

function shifted(R, src, w, h, dx, dy, noise) {
	const out = sab(Uint8Array, w * h);
	for (let y = 0; y < h; y++) {
		const sy = Math.min(h - 1, Math.max(0, y - dy));
		for (let x = 0; x < w; x++) {
			const sx = Math.min(w - 1, Math.max(0, x - dx));
			out[y * w + x] = Math.max(0, Math.min(255, src[sy * w + sx] + (noise ? R.ri(-noise, noise) : 0)));
		}
	}
	return out;
}

function bits(R, n, p, value = 1) {
	const a = sab(Uint8Array, n);
	for (let i = 0; i < n; i++) if (R.rnd() < p) a[i] = value;
	return a;
}

function junk(R, a) {
	for (let i = 0; i < a.length; i++) a[i] = R.ri(0, 1);
	return a;
}

const buffers = (o) => {
	const ctx = {};
	for (const [k, v] of Object.entries(o)) {
		ctx[k] = ArrayBuffer.isView(v) ? v.buffer : Array.isArray(v) && ArrayBuffer.isView(v[0]) ? v.map((a) => a.buffer) : v;
	}
	return ctx;
};

function localField(R) {
	// a pattern that repeats every p px both ways, so offsets p apart tie
	// exactly and the search must keep the first it met; on tiles of three
	// sample rows, which have the search to the end
	const periodic = R.rnd() < 0.15;
	const tile = periodic ? R.pick([8, 9]) : R.pick([8, 16, 24, 32, 48, 95, 96, 96]);
	const w = R.ri(Math.max(40, tile), tile * 5);
	const h = R.ri(Math.max(40, tile), tile * 5);
	const maxOffset = periodic ? R.pick([3, 5, 7]) : R.ri(1, 8);
	// mostly inside the search box, where a tile finds its minimum
	const reach = R.rnd() < 0.8 ? maxOffset - 1 : maxOffset + 2;
	let golden = texture(R, w, h, R.rnd() < 0.05);
	let target =
		R.rnd() < 0.05
			? texture(R, w, h, true)
			: shifted(R, golden, w, h, R.ri(-reach, reach), R.ri(-reach, reach), R.ri(0, 40));
	if (periodic) {
		const p = R.ri(2, 3);
		golden = sab(Uint8Array, w * h);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) golden[y * w + x] = 30 + (x % p) * 50 + (y % p) * 20;
		target = golden;
	}
	const gridW = Math.max(1, Math.ceil(w / tile));
	const cells = gridW * Math.max(1, Math.ceil(h / tile));
	return buffers({
		golden,
		target,
		fx: sab(Float32Array, cells),
		fy: sab(Float32Array, cells),
		valid: sab(Uint8Array, cells),
		width: w,
		height: h,
		gridW,
		tile,
		maxOffset,
		minStdDev: 12,
		searchable: R.rnd() < 0.5 ? sab(Uint8Array, cells).fill(1) : bits(R, cells, 0.8),
		...claim(cells, R.ri(1, 3)),
	});
}

function localApply(R) {
	const w = R.ri(20, 400);
	const h = R.ri(20, 400);
	const tile = R.pick([8, 16, 32, 96]);
	const gridW = Math.max(1, Math.ceil(w / tile));
	const gridH = Math.max(1, Math.ceil(h / tile));
	const fx = sab(Float32Array, gridW * gridH);
	const fy = sab(Float32Array, gridW * gridH);
	const wide = R.rnd() < 0.2 ? 40 : 7;
	for (let i = 0; i < fx.length; i++) {
		// half-pixels, so Math.round's ties come up
		fx[i] = R.rnd() < 0.5 ? R.ri(-12, 12) / 2 : (R.rnd() - 0.5) * 2 * wide;
		fy[i] = R.rnd() < 0.5 ? R.ri(-12, 12) / 2 : (R.rnd() - 0.5) * 2 * wide;
	}
	const cell = R.pick([16, 32, 64, 128]);
	const cellsW = Math.ceil(w / cell);
	const cells = cellsW * Math.ceil(h / cell);
	const variant = R.ri(0, 3);
	const grey = variant & 1 ? sab(Uint32Array, 4 * 256) : null;
	const toned = variant & 2;
	const classes = toned ? sab(Uint8Array, w * h) : null;
	if (classes) for (let i = 0; i < classes.length; i++) classes[i] = R.ri(0, 15);
	return buffers({
		target: texture(R, w, h),
		out: junk(R, sab(Uint8Array, w * h)),
		fx,
		fy,
		width: w,
		height: h,
		gridW,
		gridH,
		tile,
		cell,
		cellsW,
		grey,
		classes,
		histP: toned ? sab(Uint32Array, cells * 256) : null,
		histK: toned ? sab(Uint32Array, cells * 256) : null,
		paperBit: toned ? 4 : 0,
		inkBit: toned ? 8 : 0,
		...claim(cells, R.ri(1, 3)),
	});
}

// The tone comparison's buffers (lib/compare.js tonePrepare), dirty masks
// and all.
function toneTables(R, w, h) {
	const tile = R.pick([8, 16, 32, 64]);
	const slackGridW = Math.ceil(w / tile);
	const levels = R.ri(1, 4);
	const tileLevel = sab(Uint8Array, slackGridW * Math.ceil(h / tile));
	for (let i = 0; i < tileLevel.length; i++) tileLevel[i] = R.ri(0, levels - 1);
	const cell = R.pick([16, 32, 64, 128]);
	const cellsW = Math.ceil(w / cell);
	const cells = cellsW * Math.ceil(h / cell);
	const spans = sab(Float32Array, cells);
	for (let i = 0; i < cells; i++) {
		const p = R.rnd();
		spans[i] = p < 0.2 ? 0 : p < 0.25 ? NaN : 1 + R.rnd() * 60;
	}
	const table = (lo) => {
		const t = sab(Int16Array, cells * 256);
		for (let i = 0; i < t.length; i++) {
			const p = R.rnd();
			t[i] = p < 0.05 ? (lo ? -32768 : 32767) : lo ? R.ri(-1, 140) : R.ri(110, 256);
		}
		return t;
	};
	const own = R.rnd() < 0.4;
	const wantMap = R.rnd() < 0.4;
	const speck = R.rnd() < 0.8 ? junk(R, sab(Uint8Array, w * h)) : null;
	const expected = wantMap ? sab(Float32Array, cells * 256) : null;
	if (expected) for (let i = 0; i < expected.length; i++) expected[i] = R.rnd() * 255;
	const blockSize = R.rnd() < 0.5 ? R.pick([4, 8, 16, 32]) : 0;
	const blocksW = blockSize ? Math.ceil(w / blockSize) : 0;
	const classes = sab(Uint8Array, w * h);
	for (let i = 0; i < classes.length; i++) classes[i] = R.rnd() < 0.85 ? 1 : 0;
	const darkest = [];
	const lightest = [];
	for (let l = 0; l < levels; l++) {
		darkest.push(texture(R, w, h));
		lightest.push(texture(R, w, h));
	}
	return {
		t: {
			classes,
			gray: texture(R, w, h),
			width: w,
			height: h,
			cell,
			cellsW,
			paperBit: 4,
			inkBit: 8,
			measuredBit: 1,
			darkest,
			lightest,
			tileLevel,
			tile,
			slackGridW,
			spans,
			lo: table(true),
			hi: table(false),
			speckLo: own ? table(true) : null,
			speckHi: own ? table(false) : null,
			expected,
			defect: junk(R, sab(Uint8Array, w * h)),
			speck,
			map: wantMap ? sab(Uint8Array, w * h) : null,
			rowSpecks: speck ? junk(R, sab(Uint32Array, h)) : null,
			blocks: blockSize ? sab(Uint32Array, blocksW * Math.ceil(h / blockSize)) : null,
			blockSize: blockSize || 16,
			blocksW,
			toneCounts: sab(Uint32Array, 4 * 2),
		},
		// whole rows of blocks a chunk, as lib/compare.js rowChunk
		chunk: blockSize ? blockSize * R.ri(1, 3) : R.ri(1, 40),
	};
}

function toneCompare(R) {
	const w = R.ri(20, 300);
	const h = R.ri(20, 300);
	const { t, chunk } = toneTables(R, w, h);
	return buffers({ ...t, ...claim(h, chunk) });
}

function binarize(R) {
	const w = R.ri(20, 300);
	const h = R.ri(20, 300);
	const gray = texture(R, w, h);
	const margin = R.rnd() < 0.3 ? 0 : R.ri(0, 80);
	const golden = R.rnd() < 0.7 ? bits(R, w * h, 0.3) : null;
	const tone = R.rnd() < 0.5 ? toneTables(R, w, h) : null;
	return buffers({
		...(tone ? { ...tone.t, gray } : {}),
		gray,
		fg: junk(R, sab(Uint8Array, w * h)),
		ambiguous: R.rnd() < 0.7 ? junk(R, sab(Uint8Array, w * h)) : null,
		level: R.rnd() < 0.5 ? R.ri(40, 220) : R.ri(40, 220) + 0.5,
		margin,
		width: w,
		golden,
		counts: golden ? sab(Uint32Array, 4 * 3) : null,
		...claim(h, tone ? tone.chunk : R.ri(1, 40)),
	});
}

function diff(R) {
	const tiny = R.rnd() < 0.15;
	const w = tiny ? R.ri(1, 9) : R.ri(20, 300);
	const h = tiny ? R.ri(1, 9) : R.ri(20, 300);
	const n = w * h;
	const blockSize = R.pick([1, 3, 8, 16, 16, 32]);
	const gridW = Math.ceil(w / blockSize);
	const gridH = Math.ceil(h / blockSize);
	return buffers({
		targetFg: bits(R, n, R.pick([0.02, 0.1, 0.4])),
		goldenFg: bits(R, n, R.pick([0.02, 0.1, 0.4])),
		goldenFgDilatedBackground: bits(R, n, R.pick([0.1, 0.5])),
		goldenAmbiguous: R.rnd() < 0.6 ? bits(R, n, 0.1) : null,
		targetAmbiguous: R.rnd() < 0.6 ? bits(R, n, 0.1) : null,
		dilated: R.rnd() < 0.5 ? junk(R, sab(Uint8Array, n)) : null,
		printDefect: junk(R, sab(Uint8Array, n)),
		backgroundDefect: junk(R, sab(Uint8Array, n)),
		printBlocks: sab(Uint32Array, gridW * gridH),
		backgroundBlocks: sab(Uint32Array, gridW * gridH),
		counts: sab(Uint32Array, 4 * 2),
		width: w,
		height: h,
		radius: R.rnd() < 0.1 ? R.ri(10, 40) : R.ri(0, 6),
		margin: R.ri(0, 30),
		blockSize,
		...claim(gridH, R.ri(1, 4)),
	});
}

const CASES = { localField, localApply, binarize, toneCompare, diff };

/** Kernel `name`'s dispatch for `seed`. */
function kernelCase(name, seed) {
	return CASES[name](rng(seed));
}

/** A deep copy: the same bytes in new shared buffers, `next` reset. */
function copyCtx(ctx) {
	const out = {};
	const copy = (b) => {
		const c = new SharedArrayBuffer(b.byteLength);
		new Uint8Array(c).set(new Uint8Array(b));
		return c;
	};
	for (const [k, v] of Object.entries(ctx)) {
		out[k] = v instanceof SharedArrayBuffer ? copy(v) : Array.isArray(v) ? v.map(copy) : v;
	}
	return out;
}

/** Every buffer of a ctx but the claim counter, as Buffers by key. */
function snapshot(ctx) {
	const out = {};
	for (const [k, v] of Object.entries(ctx)) {
		if (k === "next") continue;
		if (v instanceof SharedArrayBuffer) out[k] = Buffer.from(new Uint8Array(v).slice());
		else if (Array.isArray(v)) v.forEach((b, i) => (out[`${k}.${i}`] = Buffer.from(new Uint8Array(b).slice())));
	}
	return out;
}

module.exports = { kernelCase, copyCtx, snapshot, rng, KERNELS: Object.keys(CASES) };
