/**
 * The JS transform search's tail - the frames OpenCV could not align -
 * moved off the inspector's thread. None of it may move a result:
 *
 *  - the density sweeps score on the pool, and the search has to come out
 *    identical to scoring every candidate in place, pinned or not;
 *  - stage 2 sweeps angle only for the hypotheses stage 3 will refine;
 *  - the polish scores its start in its first batch, not a batch of one;
 *  - the final warp splits across the pool when it is not magnifying.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
	buildGoldenSignature,
	findTransform,
	polish,
	neighbourhood,
	scoreCandidate,
	POLISH_MAX_ROUNDS,
} = require("../lib/align.js");
const { densityBatchParallel } = require("../lib/parallel.js");
const { buildIntegral } = require("../lib/integral.js");
const { warpGray, buildGrayTable } = require("../lib/warp.js");
const { shutdown } = require("../lib/pool.js");
const { HAS_SAB } = require("../lib/shared.js");

test.after(() => shutdown());

const GW = 600;
const GH = 800;
const TW = 700;
const TH = 900;

// A label of random ink blocks, and a frame showing it stretched, turned
// and displaced - something for every stage of the search to find.
function fixture() {
	const golden = new Uint8Array(GW * GH);
	let seed = 4242;
	const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let b = 0; b < 260; b++) {
		const x0 = (rnd() * (GW - 60)) | 0;
		const y0 = (rnd() * (GH - 30)) | 0;
		const w = 4 + ((rnd() * 56) | 0);
		const h = 2 + ((rnd() * 26) | 0);
		for (let y = y0; y < y0 + h; y++) golden.fill(1, y * GW + x0, y * GW + x0 + w);
	}
	const t = { mx: 1.04, my: 0.99, theta: 0.006, ox: 31.5, oy: 24.25 };
	const cos = Math.cos(t.theta);
	const sin = Math.sin(t.theta);
	const frame = new Uint8Array(TW * TH);
	for (let y = 0; y < TH; y++) {
		for (let x = 0; x < TW; x++) {
			// invert target = o + R * diag(m) * g
			const dx = x - t.ox;
			const dy = y - t.oy;
			const gx = Math.round((cos * dx + sin * dy) / t.mx);
			const gy = Math.round((-sin * dx + cos * dy) / t.my);
			if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) frame[y * TW + x] = golden[gy * GW + gx];
		}
	}
	const signatures = {
		coarse: buildGoldenSignature(golden, GW, GH, 18, 24),
		medium: buildGoldenSignature(golden, GW, GH, 48, 64),
		fine: buildGoldenSignature(golden, GW, GH, 72, 96),
	};
	return { golden, frame, signatures };
}

const OPTS = {
	scaleMin: 0.8,
	scaleMax: 1.25,
	scaleSteps: 7,
	maxAspect: 0.06,
	aspectSteps: 7,
	rankedCandidates: 3,
	maxAngleDeg: 2,
	angleSteps: 5,
	slackPx: 16,
};

test("density batches score exactly as scoreCandidate", { skip: !HAS_SAB }, async () => {
	const { frame, signatures } = fixture();
	const table = buildIntegral(frame, TW, TH);
	const sig = signatures.medium;
	const n = 120;
	const params = new Float64Array(n * 5);
	for (let i = 0; i < n; i++) {
		params.set([1 + (i % 7) * 0.01, 0.98 + (i % 5) * 0.01, (i % 3) * 0.004, 20 + (i % 11), 15 + (i % 13)], i * 5);
	}
	const got = await densityBatchParallel(sig, table, TW, TH, params, n, 4);
	assert.ok(got, "precondition: the batch should have gone to the pool");
	for (let i = 0; i < n; i++) {
		const k = i * 5;
		const want = scoreCandidate(sig, table, TW, TH, params[k], params[k + 1], params[k + 2], params[k + 3], params[k + 4]);
		assert.strictEqual(got[i], want, `candidate ${i}`);
	}
});

for (const pinned of [false, true]) {
	test(`the ${pinned ? "pinned" : "unpinned"} search is the same on the pool as in place`, { skip: !HAS_SAB }, async () => {
		const { frame, signatures } = fixture();
		let pooled = 0;
		const opts = { ...OPTS, pinnedScale: pinned ? { mx: 1.04, my: 0.99 } : null };
		const serial = await findTransform(GW, GH, frame, TW, TH, signatures, opts);
		const parallel = await findTransform(GW, GH, frame, TW, TH, signatures, {
			...opts,
			scoreDensity: async (...args) => {
				const scores = await densityBatchParallel(...args, 4);
				if (scores) pooled++;
				return scores;
			},
		});
		assert.ok(pooled > 0, "precondition: some sweep should have gone to the pool");
		assert.deepStrictEqual(parallel, serial);
	});
}

// A fractional count, a library caller's, refines the whole number above
// it, as the `i < keep` loop the slice replaced did.
for (const rankedCandidates of [OPTS.rankedCandidates, 2.5]) {
	test(`stage 2 sweeps angle only for the hypotheses stage 3 refines (${rankedCandidates})`, async () => {
		const { frame, signatures } = fixture();
		const batches = [];
		await findTransform(GW, GH, frame, TW, TH, signatures, {
			...OPTS,
			rankedCandidates,
			// decline every batch, so this only watches what is asked for
			scoreDensity: async (sig, table, w, h, params, n) => {
				const angles = new Set();
				for (let i = 0; i < n; i++) angles.add(params[i * 5 + 2]);
				batches.push({ sig, n, angles: angles.size });
				return null;
			},
		});
		// stage 2 on the medium lattice: first every scale pair at angle 0,
		// then the angle sweep. Both use the same translation grid around each
		// hypothesis, so the first batch gives its size.
		const medium = batches.filter((b) => b.sig === signatures.medium);
		assert.strictEqual(medium.length, 2, "a scale batch and an angle batch");
		const pairs = OPTS.aspectSteps * 3;
		const grid = medium[0].n / pairs;
		assert.strictEqual(medium[1].angles, OPTS.angleSteps);
		assert.strictEqual(
			medium[1].n,
			Math.ceil(rankedCandidates) * OPTS.angleSteps * grid,
			"the angle sweep covered other than the hypotheses stage 3 refines",
		);
	});
}

// The polish as it was, scoring its start in a batch of its own - the
// reference the folded form has to reproduce.
async function polishSeparately(scoreBatch, start, gW, gH, maxAngleDeg, lockScale) {
	let best = { ...start };
	best.score = (await scoreBatch([best]))[0];
	for (const relStep of [0.02, 0.01, 0.005, 0.0025, 0.00125]) {
		for (let round = 0; round < POLISH_MAX_ROUNDS; round++) {
			const cands = neighbourhood(best, gW, gH, relStep, maxAngleDeg, lockScale);
			const scores = await scoreBatch(cands);
			let pick = -1;
			let pickScore = best.score;
			for (let i = 0; i < cands.length; i++) {
				if (scores[i] < pickScore) {
					pickScore = scores[i];
					pick = i;
				}
			}
			if (pick < 0) break;
			best = { ...cands[pick], score: pickScore };
		}
	}
	return best;
}

test("the polish scores its start with its first neighbourhood, to the same end", async () => {
	const { golden, frame } = fixture();
	const gray = new Uint8Array(frame.length);
	for (let i = 0; i < frame.length; i++) gray[i] = frame[i] ? 30 : 220;
	// scored on a quarter-size grid, as compare.js scores the polish
	const table = buildGrayTable(gray, TW, TH);
	const OW = GW / 4;
	const OH = GH / 4;
	const ink = new Uint8Array(OW * OH);
	for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) ink[y * OW + x] = golden[y * 4 * GW + x * 4];
	const score = (c) => {
		const w = warpGray(gray, TW, TH, c.mx * 4, c.my * 4, c.theta, c.ox, c.oy, OW, OH, 255, table);
		let m = 0;
		for (let i = 0; i < w.length; i++) if ((w[i] < 128 ? 1 : 0) !== ink[i]) m++;
		return m / w.length;
	};
	for (const lockScale of [false, true]) {
		const start = { mx: 1.045, my: 0.985, theta: 0.004, ox: 33, oy: 22, score: Infinity };
		const sizes = [];
		const folded = await polish(async (c) => {
			sizes.push(c.length);
			return c.map(score);
		}, start, GW, GH, 2, lockScale);
		const separate = await polishSeparately(async (c) => c.map(score), start, GW, GH, 2, lockScale);
		assert.deepStrictEqual(folded, separate);
		assert.ok(!sizes.includes(1), "no batch of one");
		assert.strictEqual(sizes[0], 1 + (lockScale ? 10 : 14), "the start rides in the first batch");
	}
});

test("a warp that is not magnifying splits across the pool", { skip: !HAS_SAB }, async () => {
	// parallel.js takes runRanges at load, so the spy goes in before a
	// fresh copy of it is loaded
	const pool = require("../lib/pool.js");
	const real = pool.runRanges;
	const kernels = [];
	pool.runRanges = (kernel, ...rest) => {
		kernels.push(kernel);
		return real(kernel, ...rest);
	};
	const file = path.join(__dirname, "../lib/parallel.js");
	delete require.cache[file];
	try {
		const { warpParallel } = require(file);
		const srcW = 900;
		const srcH = 800;
		const src = new Uint8Array(srcW * srcH);
		for (let i = 0; i < src.length; i++) src[i] = (i * 2654435761) >>> 24;
		const args = [src, srcW, srcH, 0.99, 0.985, 0.01, 3.5, -2.25, 700, 600, 255];
		const par = await warpParallel(...args, null, 4);
		assert.deepStrictEqual(kernels, ["warp"], "the bilinear warp ran on one thread");
		assert.deepStrictEqual(Buffer.from(par), Buffer.from(warpGray(...args, null)));
	} finally {
		pool.runRanges = real;
		delete require.cache[file];
	}
});
