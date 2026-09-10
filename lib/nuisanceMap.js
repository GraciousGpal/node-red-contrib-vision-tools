/**
 * Trained nuisance map: what "clean" looks like at each place on the part.
 *
 * The blemish check asks whether a block of the frame carries more ink than
 * the golden says it should. That question has a floor it cannot see past.
 * Registration is never perfect, and wherever the golden has a hard ink
 * edge, a sub-pixel misalignment paints a thin line of "extra ink" that is
 * not a defect at all. Those artifacts are not noise in the statistical
 * sense - they are in the *same place on every frame*, because the thing
 * causing them is a printed feature that is always there.
 *
 * Measured on a 162-frame production run, an 8px-wide strip at (112, 168)
 * reached density 0.25 in 78 of 148 good frames, and one at (72, 2088) in
 * 143 of them. `failThreshold` has to clear that floor, which puts the bar
 * at 0.5 - and a real defect measured only 0.39. It was invisible not
 * because it was weak but because the floor was high.
 *
 * So the discriminator is not magnitude, it is *location*. Train a
 * per-block baseline from known-good frames and score each block by how
 * far it exceeds its own history:
 *
 *     excess[i] = max(0, density[i] - baseline[i])
 *
 * A recurring artifact scores ~0 no matter how dark it is, because its
 * baseline is just as dark. A blemish somewhere the part is normally clean
 * scores its full density.
 *
 * MEASURED, held out - every good frame below was scored against a map
 * trained without it, because a map validated on its own training frames
 * reports a gap it cannot reproduce in production:
 *
 *   training frames | worst good | the two frames that were slipping through
 *   ----------------|------------|------------------------------------------
 *        37         |   0.2655   |            0.3281, 0.3906
 *        74         |   0.2500   |            0.3281, 0.3906
 *
 * So the gate defaults to 0.30: clear of the worst good frame even on a
 * thin 37-frame training run, and still under the weaker of the two real
 * defects. The window is narrower than it looks - roughly 0.27 to 0.32 -
 * and its lower edge is set by how many frames trained the map. TRAIN ON
 * AS MANY GOOD FRAMES AS THE LINE WILL GIVE YOU; 100+ is comfortable, and
 * below ~40 the margin gets thin enough that a false reject is likely
 * before a miss is.
 *
 * If false rejects appear, the first move is more training frames, not a
 * higher threshold - the threshold trades directly against the defect it
 * was added to catch.
 *
 * WHAT THIS DOES NOT DO. It cannot see a defect that lands exactly on a
 * chronically dirty spot - there, the baseline it is measured against is
 * the artifact's own. That is the deliberate trade: this suppresses a known
 * false-accept mechanism at the cost of desensitising the few blocks that
 * were never trustworthy anyway. It is a second opinion layered on top of
 * the existing density and ratio gates, never a replacement for them.
 *
 * A map is meaningless against a different golden, a different working
 * size or a different block size - the grid would not even be the same
 * shape - so all four are recorded and checked on load, the same identity
 * discipline lib/transformFile.js uses, and for the same reason: silently
 * applying a stale record is worse than not having one.
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const VERSION = 1;

// How many of the largest values per cell the accumulator remembers. The
// baseline is taken from inside this window rather than at the very top so
// that one contaminated training frame cannot raise a cell for good; see
// DEFAULT_DROP.
const KEEP = 8;

// Which of those to use, counting from the largest. 0 would be the plain
// maximum, which one bad frame poisons permanently. 1 - the second largest
// - tolerates a single outlier per cell while still sitting at roughly the
// 99th percentile of a 148-frame set, so it stays conservative: the whole
// point is to suppress what good product does, and under-suppressing costs
// a false reject.
const DEFAULT_DROP = 1;

// Densities are fractions of a block's pixels, so a byte per cell is finer
// than the measurement: at the deployed blockSize of 8 a block holds 64
// pixels and density can only take 65 distinct values anyway.
const SCALE = 255;

function quantize(v) {
	if (!Number.isFinite(v) || v <= 0) return 0;
	return Math.min(SCALE, Math.round(v * SCALE));
}

/**
 * Somewhere to accumulate training frames. Holds the KEEP largest values
 * seen per cell, each quantized to a byte.
 *
 * @param {number} gridW
 * @param {number} gridH
 */
function createAccumulator(gridW, gridH) {
	if (!Number.isInteger(gridW) || gridW <= 0) {
		throw new Error("nuisance map: gridW must be a positive integer");
	}
	if (!Number.isInteger(gridH) || gridH <= 0) {
		throw new Error("nuisance map: gridH must be a positive integer");
	}
	return {
		gridW,
		gridH,
		frames: 0,
		// cell-major: top[i * KEEP + k] is the (k+1)-th largest seen at cell i
		top: new Uint8Array(gridW * gridH * KEEP),
	};
}

/**
 * Fold one training frame's density grid in. Insertion-sorts each cell's
 * value into that cell's descending top-KEEP window.
 *
 * @param {{gridW:number,gridH:number,frames:number,top:Uint8Array}} acc
 * @param {ArrayLike<number>} density gridW*gridH densities in 0..1
 */
function accumulate(acc, density) {
	const n = acc.gridW * acc.gridH;
	if (density.length < n) {
		throw new Error(
			`nuisance map: expected a ${acc.gridW}x${acc.gridH} density grid, got ${density.length} cells`,
		);
	}
	const { top } = acc;
	for (let i = 0; i < n; i++) {
		const v = quantize(density[i]);
		if (v === 0) continue;
		const base = i * KEEP;
		// smallest kept value for this cell; nothing to do if v cannot beat it
		if (v <= top[base + KEEP - 1]) continue;
		let k = KEEP - 1;
		while (k > 0 && top[base + k - 1] < v) {
			top[base + k] = top[base + k - 1];
			k--;
		}
		top[base + k] = v;
	}
	acc.frames++;
	return acc;
}

/**
 * Collapse the accumulator into the baseline grid a comparison uses.
 *
 * `drop` counts from the largest value kept, so 0 is the maximum and 1 -
 * the default - discards the single worst frame per cell.
 *
 * @returns {Float32Array} gridW*gridH baseline densities in 0..1
 */
function finalize(acc, { drop = DEFAULT_DROP } = {}) {
	const n = acc.gridW * acc.gridH;
	const k = Math.max(0, Math.min(KEEP - 1, Math.trunc(drop)));
	// With fewer frames than `drop`, every cell would read 0 from an unfilled
	// slot and the map would suppress nothing. Fall back to the deepest slot
	// the training run can actually support.
	const slot = acc.frames > k ? k : Math.max(0, acc.frames - 1);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = acc.top[i * KEEP + slot] / SCALE;
	return out;
}

/**
 * How far each block exceeds its own trained baseline. Cells with no
 * baseline (never dirty in training) pass their density through unchanged,
 * which is the case that catches a blemish on clean substrate.
 *
 * @param {ArrayLike<number>} density
 * @param {ArrayLike<number>|null} baseline
 * @returns {{excess: Float32Array, worst: number}}
 */
function excessOver(density, baseline) {
	const n = density.length;
	const excess = new Float32Array(n);
	let worst = 0;
	if (!baseline) {
		for (let i = 0; i < n; i++) {
			excess[i] = density[i];
			if (density[i] > worst) worst = density[i];
		}
		return { excess, worst };
	}
	for (let i = 0; i < n; i++) {
		const e = density[i] - (baseline[i] || 0);
		if (e > 0) {
			excess[i] = e;
			if (e > worst) worst = e;
		}
	}
	return { excess, worst };
}

/**
 * A density grid as one byte per cell, for shipping a training frame's
 * measurement out of the inspection worker.
 *
 * @param {ArrayLike<number>} density
 * @returns {Uint8Array}
 */
function quantizeDensity(density) {
	const out = new Uint8Array(density.length);
	for (let i = 0; i < density.length; i++) out[i] = quantize(density[i]);
	return out;
}

/** The inverse, for folding a shipped grid back into an accumulator. */
function dequantizeDensity(bytes) {
	const out = new Float32Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / SCALE;
	return out;
}

function encodeBaseline(baseline) {
	const bytes = new Uint8Array(baseline.length);
	for (let i = 0; i < baseline.length; i++) bytes[i] = quantize(baseline[i]);
	return Buffer.from(bytes).toString("base64");
}

function decodeBaseline(text, cells) {
	const bytes = Buffer.from(String(text), "base64");
	if (bytes.length !== cells) return null;
	const out = new Float32Array(cells);
	for (let i = 0; i < cells; i++) out[i] = bytes[i] / SCALE;
	return out;
}

/**
 * Build the on-disk record. `identity` carries the same golden/workingSize
 * fingerprint a trained transform does, plus the block geometry, because a
 * map trained at another blockSize is not merely stale - it is a different
 * grid.
 */
function buildRecord(baseline, acc, identity) {
	return {
		version: VERSION,
		trainedAt: new Date().toISOString(),
		frames: acc.frames,
		gridW: acc.gridW,
		gridH: acc.gridH,
		channel: identity.channel || "background",
		blockSize: identity.blockSize,
		workingSize: identity.workingSize,
		goldenKey: identity.goldenKey,
		goldenContentKey: identity.goldenContentKey,
		baseline: encodeBaseline(baseline),
	};
}

async function pathExists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Load a map, refusing anything that does not match the comparison it is
 * about to be used in.
 *
 * Returns null when there is simply no map (the ordinary untrained case),
 * `{ error }` when one exists but cannot be trusted, and
 * `{ baseline, record }` when it applies.
 */
async function readNuisanceMap(filePath, expect = {}) {
	if (!filePath || !(await pathExists(filePath))) return null;
	let parsed;
	try {
		parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
	} catch (err) {
		return { error: `nuisance map is not readable JSON: ${err.message}` };
	}
	if (parsed.version !== VERSION) {
		return {
			error: `nuisance map is version ${parsed.version}, this build reads ${VERSION} - retrain it`,
		};
	}
	for (const [field, want] of [
		["blockSize", expect.blockSize],
		["workingSize", expect.workingSize],
	]) {
		if (want && parsed[field] && parsed[field] !== want) {
			return {
				error: `nuisance map was trained at ${field} ${parsed[field]}, now running at ${want} - retrain it`,
			};
		}
	}
	if (expect.gridW && expect.gridH) {
		if (parsed.gridW !== expect.gridW || parsed.gridH !== expect.gridH) {
			return {
				error:
					`nuisance map grid is ${parsed.gridW}x${parsed.gridH}, this comparison needs ` +
					`${expect.gridW}x${expect.gridH} - retrain it`,
			};
		}
	}
	if (
		expect.goldenKey &&
		parsed.goldenKey &&
		parsed.goldenKey !== expect.goldenKey
	) {
		// Same reasoning as the trained transform: the cheap key records how
		// the golden was delivered, so it differs both when the golden really
		// changed and when the same image simply arrived another way. Only
		// content settles it, and resolving that costs a read.
		const mine = await resolveContentKey(expect);
		if (!parsed.goldenContentKey || !mine || parsed.goldenContentKey !== mine) {
			return {
				error:
					`nuisance map was trained against a different golden ` +
					`(${parsed.goldenKey} vs ${expect.goldenKey}) - retrain it`,
			};
		}
	}
	const cells = parsed.gridW * parsed.gridH;
	const baseline = decodeBaseline(parsed.baseline, cells);
	if (!baseline) {
		return { error: "nuisance map baseline is truncated or corrupt - retrain it" };
	}
	return { baseline, record: parsed };
}

async function resolveContentKey(expect) {
	const c = expect.goldenContentKey;
	if (typeof c === "string") return c || null;
	if (typeof c !== "function") return null;
	try {
		return (await c()) || null;
	} catch {
		return null;
	}
}

async function writeNuisanceMap(filePath, record) {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, JSON.stringify(record, null, 2));
}

module.exports = {
	VERSION,
	KEEP,
	DEFAULT_DROP,
	createAccumulator,
	quantizeDensity,
	dequantizeDensity,
	accumulate,
	finalize,
	excessOver,
	buildRecord,
	readNuisanceMap,
	writeNuisanceMap,
	// test seams
	encodeBaseline,
	decodeBaseline,
};
