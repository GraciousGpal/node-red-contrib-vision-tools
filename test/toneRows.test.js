/**
 * The tone check's per-frame work against a plain restatement of it.
 *
 * toneDefect caches what depends only on the golden, splits its two
 * passes over the pool by cells and rows, lets a speck threshold equal to
 * the tone one share the tone tables and finds the speck seeds from
 * per-row counts. None of that may change a bit of what it returns, so
 * every output here is held to `reference` below - the same arithmetic
 * written the slow, obvious way, one pixel and one table entry at a time
 * - serially and on the pool, with the map on and off, and for each way
 * the two thresholds can relate.
 */

const test = require("node:test");
const assert = require("node:assert");
const { toneDefect, toneCounts } = require("../lib/compare.js");
const { toneHistCells, toneCompareRows } = require("../lib/toneRows.js");
const { shutdown } = require("../lib/pool.js");
const { HAS_SAB } = require("../lib/shared.js");

test.after(() => shutdown());

// odd sizes, so neither the 128 px cells nor the slack tiles divide the
// frame, and big enough (over 400K px) for the pool to split it
const W = 1037;
const H = 659;

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** Cream paper, near-black bars and text-like strokes, one grey panel. */
function makeGolden() {
	const gray = new Uint8Array(W * H).fill(228);
	const fill = (x0, y0, w, h, v) => {
		for (let y = y0; y < Math.min(H, y0 + h); y++) gray.fill(v, y * W + x0, y * W + Math.min(W, x0 + w));
	};
	fill(60, 50, 700, 40, 28);
	fill(820, 40, 150, 560, 150);
	for (let k = 0; k < 40; k++) fill(70 + (k % 10) * 70, 140 + Math.floor(k / 10) * 110, 9, 70, 35);
	for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 97) if ((y >> 5) % 2) gray[y * W + x] = 60;
	const fg = new Uint8Array(W * H);
	for (let i = 0; i < fg.length; i++) fg[i] = gray[i] < 128 ? 1 : 0;
	return { width: W, height: H, gray, fg };
}

/** The golden under other lighting, with noise, a smudge and specks. */
function makeFrame(golden, seed) {
	const r = rng(seed);
	const out = new Uint8Array(W * H);
	for (let i = 0; i < out.length; i++) {
		const v = 12 + golden.gray[i] * 0.9 + (r() - 0.5) * 18;
		out[i] = Math.max(0, Math.min(255, Math.round(v)));
	}
	for (let y = 300; y < 360; y++) for (let x = 200; x < 290; x++) out[y * W + x] = Math.max(0, out[y * W + x] - 70);
	for (let k = 0; k < 300; k++) {
		const i = Math.floor(r() * out.length);
		out[i] = r() < 0.5 ? 20 : 250;
		if (k % 3 === 0 && i + 1 < out.length) out[i + 1] = out[i];
	}
	return out;
}

/**
 * toneDefect, restated: one histogram per cell from every sampled pixel,
 * the levels and tables per cell, then every measured pixel against its
 * window's darkest and lightest golden grey. It takes toneDefect's own
 * golden-only classes and windows, which this test is not about.
 */
function reference(golden, gray, cfg, wantMap) {
	const { width, height } = golden;
	const { classes, levels, tileLevel, tile, gridW } = golden.toneClasses;
	const cell = 128;
	const cellsW = Math.ceil(width / cell);
	const cells = cellsW * Math.ceil(height / cell);
	const cellOf = (i) => Math.floor(Math.floor(i / width) / cell) * cellsW + Math.floor((i % width) / cell);
	const histP = Array.from({ length: cells }, () => new Array(256).fill(0));
	const histK = Array.from({ length: cells }, () => new Array(256).fill(0));
	const totalP = new Array(256).fill(0);
	const totalK = new Array(256).fill(0);
	for (let i = 0; i < width * height; i++) {
		if (classes[i] & 4) {
			histP[cellOf(i)][gray[i]]++;
			totalP[gray[i]]++;
		} else if (classes[i] & 8) {
			histK[cellOf(i)][gray[i]]++;
			totalK[gray[i]]++;
		}
	}
	const pct = (h, fraction) => {
		const n = h.reduce((a, b) => a + b, 0);
		if (n < 32) return -1;
		const target = Math.max(1, Math.ceil(n * fraction));
		for (let v = 0, acc = 0; v < 256; v++) if ((acc += h[v]) >= target) return v;
		return 255;
	};
	// the golden's own levels: medians of its ink mask and of its paper
	const med = (ink) => {
		const h = new Array(256).fill(0);
		for (let i = 0; i < width * height; i++) if (!!golden.fg[i] === ink) h[golden.gray[i]]++;
		return pct(h, 0.5);
	};
	const refPaper = med(false);
	const refInk = med(true);
	const paperLevel = pct(totalP, 0.8);
	const inkLevel = pct(totalK, 0.2);
	const threshold = cfg.toneThreshold > 0 ? cfg.toneThreshold : 0;
	const speckThreshold = cfg.speckThreshold > 0 ? cfg.speckThreshold : 0;
	const clamp = (v) => Math.max(-32768, Math.min(32767, v));
	const table = Array.from({ length: cells }, (_, c) => {
		let p = pct(histP[c], 0.8);
		let k = pct(histK[c], 0.2);
		if (p < 0) p = paperLevel;
		if (k < 0) k = inkLevel;
		const span = p - k;
		if (!(span >= 24)) return null;
		const e = (g) => k + Math.min(1, Math.max(0, (g - refInk) / (refPaper - refInk))) * span;
		const lo = (t, g) => (t ? clamp(Math.floor(Math.fround(e(g) - t * span))) : -32768);
		const hi = (t, g) => (t ? clamp(Math.ceil(Math.fround(e(g) + t * span))) : 32767);
		return { span, e, lo, hi };
	});
	const defect = new Uint8Array(width * height);
	const speck = speckThreshold ? new Uint8Array(width * height) : null;
	const map = wantMap ? new Uint8Array(width * height) : null;
	let count = 0;
	for (let i = 0; i < width * height; i++) {
		const t = table[cellOf(i)];
		if (!t || !(classes[i] & 1)) continue;
		const y = Math.floor(i / width);
		const x = i % width;
		const level = tileLevel[Math.floor(y / tile) * gridW + Math.floor(x / tile)];
		const dk = levels[level].darkest[i];
		const lt = levels[level].lightest[i];
		const v = gray[i];
		if (v <= t.lo(threshold, dk) || v >= t.hi(threshold, lt)) {
			defect[i] = 1;
			count++;
		}
		if (speck && (v <= t.lo(speckThreshold, dk) || v >= t.hi(speckThreshold, lt))) speck[i] = 1;
		if (map) {
			const eLo = Math.fround(t.e(dk));
			const eHi = Math.fround(t.e(lt));
			if (v < eLo || v > eHi) {
				const dev = (v < eLo ? eLo - v : v - eHi) / t.span;
				map[i] = dev >= 1 ? 255 : Math.round(dev * 255);
			}
		}
	}
	let seeds = null;
	if (speck) {
		const list = [];
		for (let i = 0; i < speck.length; i++) if (speck[i]) list.push(i);
		seeds = Int32Array.from(list);
	}
	return { count, defect, speck, seeds, map, paperLevel, inkLevel };
}

const same = (a, b, what) => {
	if (a === null || b === null) return assert.strictEqual(a, b, what);
	assert.strictEqual(a.length, b.length, `${what} length`);
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) assert.fail(`${what} differs at ${i}: ${a[i]} vs ${b[i]}`);
	}
};

const golden = makeGolden();
const frame = makeFrame(golden, 7);
const tile = 96;
const slackMap = {
	tile,
	gridW: Math.ceil(W / tile),
	gridH: Math.ceil(H / tile),
	slackPx: Array.from({ length: Math.ceil(W / tile) * Math.ceil(H / tile) }, (_, k) => [2, 3, 4, 6][k % 4]),
};

const cases = [
	["the default: one threshold for both", { toneThreshold: 0.3, speckThreshold: 0.3 }],
	["a speck threshold of its own", { toneThreshold: 0.3, speckThreshold: 0.18 }],
	["specks only", { toneThreshold: 0, speckThreshold: 0.25 }],
	["tone only", { toneThreshold: 0.25, speckThreshold: 0 }],
	["a per-tile slack map", { toneThreshold: 0.2, speckThreshold: 0.2, toneSlackMap: slackMap }],
];

for (const [name, thresholds] of cases) {
	for (const wantMap of [false, true]) {
		test(`toneDefect matches the reference: ${name}, map ${wantMap ? "on" : "off"}`, async () => {
			const cfg = { toneMargin: 3, ...thresholds };
			const serial = await toneDefect(golden, frame, { ...cfg, workers: 1 }, wantMap);
			assert.strictEqual(serial.enabled, true);
			const want = reference(golden, frame, cfg, wantMap);
			assert.ok(want.count > 0 || want.seeds.length > 0, "the frame should hold defects or specks");
			const runs = [["serial", serial]];
			if (HAS_SAB) runs.push(["pooled", await toneDefect(golden, frame, { ...cfg, workers: 5 }, wantMap)]);
			for (const [how, got] of runs) {
				assert.strictEqual(got.count, want.count, `${how} count`);
				assert.strictEqual(got.paperLevel, want.paperLevel, `${how} paper level`);
				assert.strictEqual(got.inkLevel, want.inkLevel, `${how} ink level`);
				same(got.defect, want.defect, `${how} defect`);
				same(got.speck, want.speck, `${how} speck`);
				same(got.seeds, want.seeds, `${how} seeds`);
				same(got.map, want.map, `${how} map`);
			}
		});
	}
}

test("on the pool the masks come from the frame's scratch, reused buffers and all", { skip: !HAS_SAB }, async () => {
	const cfg = { toneMargin: 3, toneThreshold: 0.3, speckThreshold: 0.3, workers: 5 };
	let want = null;
	// the scratch hands back the same two buffers every frame, as
	// takeShared does once a frame has given them back
	const { takeShared, giveShared } = require("../lib/shared.js");
	for (let round = 0; round < 3; round++) {
		const taken = [];
		const take = (Ctor, length, zero) => {
			const a = takeShared(Ctor, length, zero);
			taken.push(a);
			return a;
		};
		const got = await toneDefect(golden, frame, cfg, false, take);
		// after the first call, which builds the golden's classes for this margin
		want = want || reference(golden, frame, cfg, false);
		assert.deepStrictEqual(taken, [got.defect, got.speck]);
		same(got.defect, want.defect, `round ${round} defect`);
		same(got.speck, want.speck, `round ${round} speck`);
		same(got.seeds, want.seeds, `round ${round} seeds`);
		// what the speck fill leaves behind: visited pixels marked 2
		for (const i of got.seeds) got.speck[i] = 2;
		for (const a of taken) giveShared(a);
	}
});

test("the histogram pass gives the same cells however the cells are split", () => {
	const classes = golden.toneClasses.classes;
	const cellsW = Math.ceil(W / 128);
	const cells = cellsW * Math.ceil(H / 128);
	const t = (histP, histK) => ({ classes, gray: frame, histP, histK, width: W, height: H, cell: 128, cellsW, paperBit: 4, inkBit: 8 });
	const whole = t(new Uint32Array(cells * 256), new Uint32Array(cells * 256));
	toneHistCells(whole, 0, cells);
	// splits that start and end part-way along a row of cells, and empty ones
	for (const n of [2, 3, 5, 7, 11, cells + 3]) {
		const split = t(new Uint32Array(cells * 256), new Uint32Array(cells * 256));
		for (let k = 0; k < n; k++) toneHistCells(split, Math.floor((k * cells) / n), Math.floor(((k + 1) * cells) / n));
		same(split.histP, whole.histP, `${n} ranges, paper`);
		same(split.histK, whole.histK, `${n} ranges, ink`);
	}
	let sampled = 0;
	for (let i = 0; i < classes.length; i++) if (classes[i] & 12) sampled++;
	assert.strictEqual(whole.histP.reduce((a, b) => a + b, 0) + whole.histK.reduce((a, b) => a + b, 0), sampled);
});

// The local alignment's resampling counts the grey it writes - Otsu's
// histogram and the tone check's per-cell ones - so neither needs a pass
// of its own. What it counts has to be what those passes count over its
// output, split however the cells are, and the tone check given those
// counts has to be the reference's.
test("the local alignment's resampling counts what the histogram passes count", async () => {
	const { applyCells, buildDisplacementField, smoothField } = require("../lib/localAlign.js");
	const { refineLocallyParallel } = require("../lib/parallel.js");
	const cfg = { toneMargin: 3, toneThreshold: 0.3, speckThreshold: 0.3, localAlignTile: 96, localAlignMax: 3 };
	const counts = toneCounts(golden, cfg);
	assert.ok(counts, "precondition: the tone check has something to count");
	const { cell, cellsW, cells } = counts;
	const field = smoothField(buildDisplacementField(golden.gray, frame, W, H, { tile: 96, maxOffset: 3, minStdDev: 12 }));
	assert.ok(field.valid.some((v) => v), "precondition: the field localises");
	const expect = (gray) => {
		const hist = { classes: counts.classes, gray, histP: new Uint32Array(cells * 256), histK: new Uint32Array(cells * 256), width: W, height: H, cell, cellsW, paperBit: 4, inkBit: 8 };
		toneHistCells(hist, 0, cells);
		const grey = new Uint32Array(256);
		for (const v of gray) grey[v]++;
		return { grey, histP: hist.histP, histK: hist.histK };
	};
	// serially, over ranges that start and end part-way along a row of cells
	for (const n of [1, 3, 7, cells + 2]) {
		const t = {
			out: new Uint8Array(W * H),
			target: frame,
			width: W,
			height: H,
			field,
			tile: 96,
			cell,
			cellsW,
			counts: { ...counts, grey: new Uint32Array(256), histP: new Uint32Array(cells * 256), histK: new Uint32Array(cells * 256) },
		};
		for (let k = 0; k < n; k++) applyCells(t, Math.floor((k * cells) / n), Math.floor(((k + 1) * cells) / n));
		const want = expect(t.out);
		same(t.counts.grey, want.grey, `${n} ranges, grey`);
		same(t.counts.histP, want.histP, `${n} ranges, paper`);
		same(t.counts.histK, want.histK, `${n} ranges, ink`);
	}
	if (!HAS_SAB) return;
	// on the pool, and the tone check run on what it counted
	const refined = await refineLocallyParallel(golden.gray, frame, W, H, { ...cfg, workers: 5 }, undefined, { grey: true, tone: counts });
	assert.ok(refined && refined.tone && refined.grey, "precondition: the pool refined and counted");
	const want = expect(refined.gray);
	same(refined.grey, want.grey, "pooled grey");
	same(refined.tone.histP, want.histP, "pooled paper");
	same(refined.tone.histK, want.histK, "pooled ink");
	const got = await toneDefect(golden, refined.gray, { ...cfg, workers: 5 }, true, null, refined.tone);
	const ref = reference(golden, refined.gray, cfg, true);
	assert.ok(ref.count > 0, "precondition: the frame holds defects");
	assert.strictEqual(got.count, ref.count, "count");
	assert.strictEqual(got.paperLevel, ref.paperLevel, "paper level");
	assert.strictEqual(got.inkLevel, ref.inkLevel, "ink level");
	same(got.defect, ref.defect, "defect");
	same(got.seeds, ref.seeds, "seeds");
	same(got.map, ref.map, "map");
});

test("a speck sharing the defect's tables is the defect mask, counted per row", () => {
	// one cell, one tile, a window of the pixel itself, a band of 100-150
	const w = 40;
	const h = 30;
	const r = rng(3);
	const gray = new Uint8Array(w * h).map(() => Math.floor(r() * 256));
	const lo = new Int16Array(256).fill(99);
	const hi = new Int16Array(256).fill(151);
	const self = new Uint8Array(w * h);
	const t = (speck, rowSpecks) => ({
		classes: new Uint8Array(w * h).fill(1),
		gray,
		darkest: [self],
		lightest: [self],
		tileLevel: new Uint8Array(1),
		tile: 64,
		slackGridW: 1,
		spans: new Float32Array([100]),
		lo,
		hi,
		speckLo: null,
		speckHi: null,
		expected: null,
		defect: new Uint8Array(w * h),
		speck,
		map: null,
		rowSpecks,
		width: w,
		cell: 64,
		cellsW: 1,
		measuredBit: 1,
	});
	const rows = new Uint32Array(h);
	const both = t(new Uint8Array(w * h), rows);
	const tally = [0, 0];
	toneCompareRows(both, 0, h, tally);
	same(both.speck, both.defect, "speck");
	assert.strictEqual(tally[1], tally[0]);
	for (let y = 0; y < h; y++) {
		let n = 0;
		for (let x = 0; x < w; x++) n += both.defect[y * w + x];
		assert.strictEqual(rows[y], n, `row ${y}`);
	}
	let expect = 0;
	for (const v of gray) if (v <= 99 || v >= 151) expect++;
	assert.strictEqual(tally[0], expect);
	// and with no speck at all, only the defect
	const none = t(null, null);
	const alone = [0, 0];
	toneCompareRows(none, 0, h, alone);
	same(none.defect, both.defect, "defect without a speck");
	assert.deepStrictEqual(alone, [expect, 0]);
});
