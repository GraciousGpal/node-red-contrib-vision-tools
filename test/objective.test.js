/**
 * The batched polish must find what the serial one finds.
 *
 * Two separate claims live here, and they fail in different ways:
 *
 *   1. The `objective` kernel scores a candidate exactly as the serial
 *      scorer does. Not "closely" - exactly. These scores are compared
 *      against each other to pick an alignment, so a last-bit difference
 *      that depended on how the batch happened to be split across workers
 *      would make the chosen transform a function of the machine's core
 *      count. That is the same class of bug test/parallel.test.js exists
 *      to prevent, and it would look like a flaky camera.
 *
 *   2. The pattern search converges at least as well as the
 *      first-improvement walk it replaced. Speed is not worth a worse
 *      alignment: a polish that stops a pixel early traces a defect
 *      outline along every printed stroke.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const sharp = require("sharp");
const {
	neighbourhood,
	polish,
	reanchor,
	findTransform,
	buildGoldenSignature,
} = require("../lib/align.js");
const { objectiveBatchParallel } = require("../lib/parallel.js");
const { warpGray, buildGrayTable } = require("../lib/warp.js");
const { shutdown } = require("../lib/pool.js");
const { HAS_SAB, allocU8, toShared } = require("../lib/shared.js");

test.after(() => shutdown());

// Big enough that a batch clears the pool's minimum split size, so these
// exercise the workers rather than quietly falling back.
const FW = 1400;
const FH = 1000;
const OW = 320;
const OH = 240;

function frameFixture() {
	const gray = allocU8(FW * FH);
	let seed = 99991;
	for (let y = 0; y < FH; y++) {
		for (let x = 0; x < FW; x++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			// structured, not pure noise: bars plus a little grain, so a
			// displaced transform genuinely scores worse than the true one
			const bar = ((x >> 5) + (y >> 6)) % 3 === 0 ? 40 : 210;
			gray[y * FW + x] = Math.max(0, Math.min(255, bar + ((seed >> 20) & 7) - 3));
		}
	}
	const table = buildGrayTable(gray, FW, FH);
	const level = 128;
	// The golden's ink on the objective grid is this frame resampled under
	// a known transform, which makes that transform the true optimum.
	const truth = { mx: 3.5, my: 3.6, theta: 0.004, ox: 60, oy: 40 };
	const ref = warpGray(
		gray, FW, FH,
		truth.mx, truth.my, truth.theta, truth.ox, truth.oy,
		OW, OH, 255, table,
	);
	const fgObj = allocU8(OW * OH);
	for (let i = 0; i < ref.length; i++) fgObj[i] = ref[i] < level ? 1 : 0;
	return {
		gray: toShared(gray),
		width: FW,
		height: FH,
		table,
		outW: OW,
		outH: OH,
		level,
		fgObj,
		truth,
	};
}

// The reference scorer: precisely what lib/compare.js runs when the pool
// is unavailable.
function serialScore(frame, c) {
	const g = warpGray(
		frame.gray, frame.width, frame.height,
		c.mx, c.my, c.theta, c.ox, c.oy,
		frame.outW, frame.outH, 255, frame.table,
	);
	let mismatch = 0;
	for (let i = 0; i < g.length; i++) {
		if ((g[i] < frame.level ? 1 : 0) !== frame.fgObj[i]) mismatch++;
	}
	return mismatch / g.length;
}

function spread(truth, n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push({
			mx: truth.mx * (1 + (i % 5) * 0.004 - 0.008),
			my: truth.my * (1 + (i % 3) * 0.005 - 0.005),
			theta: truth.theta + (i % 7) * 0.0008 - 0.002,
			ox: truth.ox + (i % 4) - 2,
			oy: truth.oy + (i % 6) - 3,
		});
	}
	return out;
}

test("the objective kernel scores exactly as the serial scorer", { skip: !HAS_SAB }, async () => {
	const frame = frameFixture();
	const cands = spread(frame.truth, 14);
	const batched = await objectiveBatchParallel(cands, frame, 4);
	assert.ok(batched !== null, "precondition: the batch should have run in parallel");
	for (let i = 0; i < cands.length; i++) {
		// strictEqual, not a tolerance: these numbers are compared with each
		// other to choose a transform
		assert.strictEqual(batched[i], serialScore(frame, cands[i]), `candidate ${i} diverged`);
	}
});

test("scores do not depend on how the batch was split", { skip: !HAS_SAB }, async () => {
	const frame = frameFixture();
	const cands = spread(frame.truth, 11);
	const a = await objectiveBatchParallel(cands, frame, 2);
	const b = await objectiveBatchParallel(cands, frame, 8);
	assert.ok(a !== null && b !== null, "precondition: both should have run in parallel");
	assert.deepStrictEqual(a, b, "two worker counts, two answers");
});

test("a batch is scored in the order it was given", { skip: !HAS_SAB }, async () => {
	const frame = frameFixture();
	// deliberately unequal at the ends so a transposition cannot hide
	const cands = spread(frame.truth, 9);
	cands[0].ox += 25;
	cands[8].oy -= 25;
	const got = await objectiveBatchParallel(cands, frame, 4);
	assert.ok(got !== null, "precondition: the batch should have run in parallel");
	for (let i = 0; i < cands.length; i++) {
		assert.strictEqual(got[i], serialScore(frame, cands[i]), `slot ${i} holds the wrong candidate`);
	}
});

test("a single candidate falls back rather than paying a dispatch", async () => {
	const frame = frameFixture();
	const got = await objectiveBatchParallel([{ ...frame.truth }], frame, 8);
	assert.strictEqual(got, null, "a one-candidate batch should not be split");
});

// ---------------------------------------------------------------------
// The search itself.

// The walk this replaced: first improvement, each candidate regenerated
// from whatever was last adopted. Kept here as the bar the pattern search
// has to clear - it is the only honest way to claim the change is not a
// regression in alignment quality.
function greedyWalk(score, start, gW, gH, maxAngleDeg, lockScale) {
	const at = (c) => {
		c.score = score(c);
		return c;
	};
	let best = at({ ...start });
	for (const relStep of [0.02, 0.01, 0.005, 0.0025, 0.00125]) {
		const before = best.score;
		if (!lockScale) {
			for (const factor of [1 - relStep, 1 + relStep]) {
				for (const cand of [
					reanchor(best, gW, gH, best.mx * factor, best.my, best.theta),
					reanchor(best, gW, gH, best.mx, best.my * factor, best.theta),
				]) {
					at(cand);
					if (cand.score < best.score) best = cand;
				}
			}
		}
		if (maxAngleDeg > 0) {
			const angleStep = relStep * 25 * (Math.PI / 180);
			for (const delta of [-angleStep, angleStep]) {
				const cand = at(reanchor(best, gW, gH, best.mx, best.my, best.theta + delta));
				if (cand.score < best.score) best = cand;
			}
		}
		const step = Math.max(1, Math.round(relStep * 100));
		for (const dy of [-step, 0, step]) {
			for (const dx of [-step, 0, step]) {
				if (dx === 0 && dy === 0) continue;
				const cand = at({ ...best, ox: best.ox + dx, oy: best.oy + dy });
				if (cand.score < best.score) best = cand;
			}
		}
		if (best.score >= before && step === 1) break;
	}
	return best;
}

test("the pattern search converges at least as well as the walk it replaced", async () => {
	const frame = frameFixture();
	const gW = OW * 4;
	const gH = OH * 4;
	const score = (c) => serialScore(frame, c);

	// displaced from the truth by roughly what the staged search leaves
	// behind: a few pixels and a fraction of a percent of scale
	const start = {
		mx: frame.truth.mx * 1.006,
		my: frame.truth.my * 0.995,
		theta: frame.truth.theta - 0.003,
		ox: frame.truth.ox + 5,
		oy: frame.truth.oy - 4,
		score: Infinity,
	};

	const walked = greedyWalk(score, start, gW, gH, 2, false);
	const polled = await polish(async (cands) => cands.map(score), start, gW, gH, 2, false);

	assert.ok(
		polled.score <= walked.score,
		`pattern search ${polled.score} is worse than the walk ${walked.score}`,
	);
	assert.ok(polled.score < score(start), "the polish should improve on its start");
});

test("the polish is deterministic", async () => {
	const frame = frameFixture();
	const score = (c) => serialScore(frame, c);
	const start = {
		mx: frame.truth.mx * 1.004,
		my: frame.truth.my * 0.997,
		theta: frame.truth.theta,
		ox: frame.truth.ox + 3,
		oy: frame.truth.oy - 3,
		score: Infinity,
	};
	const a = await polish(async (c) => c.map(score), start, OW * 4, OH * 4, 2, false);
	const b = await polish(async (c) => c.map(score), start, OW * 4, OH * 4, 2, false);
	assert.deepStrictEqual(a, b, "the same start gave two different answers");
});

test("polling stops when nothing improves", async () => {
	const frame = frameFixture();
	let calls = 0;
	const score = (c) => {
		calls++;
		return serialScore(frame, c);
	};
	// starting exactly at the optimum, no neighbour can beat the centre, so
	// each step size should poll once and the ladder should break out early
	const start = { ...frame.truth, score: Infinity };
	await polish(async (cands) => cands.map(score), start, OW * 4, OH * 4, 2, false);
	assert.ok(calls <= 1 + 5 * 14, `polished ${calls} times without ever improving`);
});

test("a neighbourhood is built from one centre only", () => {
	const centre = { mx: 2, my: 2.1, theta: 0.01, ox: 10, oy: 20, score: 0.5 };
	const frozen = { ...centre };
	const set = neighbourhood(centre, 800, 600, 0.01, 2, false);
	// nothing in the set may have disturbed the point it came from - that
	// independence is what makes the batch safe to evaluate out of order
	assert.deepStrictEqual(centre, frozen, "neighbourhood mutated its centre");
	assert.strictEqual(set.length, 4 + 2 + 8, "unexpected neighbourhood size");
});

test("a locked scale polls translation and angle only", () => {
	const centre = { mx: 2, my: 2.1, theta: 0.01, ox: 10, oy: 20, score: 0.5 };
	const set = neighbourhood(centre, 800, 600, 0.01, 2, true);
	assert.strictEqual(set.length, 2 + 8);
	for (const c of set) {
		assert.strictEqual(c.mx, centre.mx, "a pinned magnification must not move");
		assert.strictEqual(c.my, centre.my, "a pinned magnification must not move");
	}
});

test("findTransform still accepts a plain scalar objective", async () => {
	// the batch form is preferred, but the scalar one stays documented and
	// is what any caller outside this package would have been written to
	const W = 800;
	const H = 600;
	const svg = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="120" y="80" width="300" height="180" fill="#111"/>` +
			`<circle cx="600" cy="400" r="90" fill="#111"/></svg>`,
	);
	const png = await sharp(svg).greyscale().raw().toBuffer({ resolveWithObject: true });
	const gray = new Uint8Array(png.data);
	const fg = new Uint8Array(gray.length);
	for (let i = 0; i < gray.length; i++) fg[i] = gray[i] < 128 ? 1 : 0;

	// the three lattices lib/compare.js builds, at their own long edges
	const lattice = (longEdge) => {
		const scale = longEdge / Math.max(W, H);
		return buildGoldenSignature(
			fg, W, H,
			Math.max(2, Math.round(W * scale)),
			Math.max(2, Math.round(H * scale)),
		);
	};
	const signatures = { coarse: lattice(24), medium: lattice(48), fine: lattice(96) };

	let calls = 0;
	const out = await findTransform(W, H, fg, W, H, signatures, {
		scaleMin: 0.9,
		scaleMax: 1.1,
		scaleSteps: 3,
		maxAspect: 0,
		aspectSteps: 1,
		rankedCandidates: 2,
		maxAngleDeg: 0,
		angleSteps: 1,
		slackPx: 8,
		objective: () => {
			calls++;
			return 0.5;
		},
	});
	assert.ok(calls > 0, "the scalar objective was never called");
	assert.ok(Number.isFinite(out.mx) && Number.isFinite(out.ox));
});
