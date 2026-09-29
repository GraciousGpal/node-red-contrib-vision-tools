/**
 * The synthetic frame set as an in-memory sequence: the case plan, the
 * ground-truth rollup, and an async generator that yields one finished
 * frame at a time.
 *
 * This exists so the offline CLI (bench/synth/generate.js, which writes a
 * directory) and the `synthetic-defects` node (which emits Node-RED
 * messages) run the *same* set. Two implementations of "the plan" would
 * drift, and a benchmark whose frames differ from the ones a person
 * eyeballs in the editor is worse than no benchmark.
 *
 * The generator is lazy on purpose. A default 170-frame set is roughly
 * 300MB of PNG; building an array of it before anyone looks at the first
 * frame would be a quarter-gigabyte spike for no gain, and the node wants
 * to emit frame 1 while frame 2 is still being drawn anyway.
 *
 * One prng, consumed in plan order. That is the whole reproducibility
 * contract: `makeCases` must draw exactly the same values in exactly the
 * same sequence as the CLI did, or the same seed stops reproducing the
 * same set. So nothing here may sample out of order, skip a case's draws,
 * or generate cases concurrently.
 *
 * Deliberately not done: no file I/O, no manifest, no scoring. Writing a
 * set is generate.js's job and scoring one is run.js's; keeping them out
 * is what lets the node use this without a scratch directory.
 */

"use strict";

const sharp = require("sharp");
const { makePrng } = require("./prng.js");
const { syntheticLabelRaster } = require("./label.js");
const { applyDefect, FAMILIES, SEVERITIES } = require("./defects.js");
const { capture, capturePresets } = require("./capture.js");

// clean frames as a fraction of the defect frames. 0.15 of the defect
// count is a little over a tenth of the whole set, which is the floor the
// false-alarm measurement needs to mean anything.
const CLEAN_FRACTION = 0.15;
const CLEAN_PER_PRESET = 2;

const pad4 = (n) => String(n).padStart(4, "0");

/** A requested subset, or every name when nothing was asked for. */
function restrict(requested, all) {
	if (!Array.isArray(requested) || requested.length === 0) return all;
	const want = new Set(requested.map(String));
	const kept = all.filter((name) => want.has(name));
	return kept.length ? kept : all;
}

/**
 * The case list, in the order the prng will be consumed.
 *
 * `families` / `variants` / `severities` narrow the set - the node lets a
 * person watch one family go past without waiting for the other four.
 * A restriction that matches nothing falls back to everything rather than
 * yielding an empty set: an empty run would report "done - 0 frames" and
 * look like a bug in the node rather than a typo in a checkbox.
 */
function planCases({
	perVariant = 3,
	preset = "typical",
	families = null,
	variants = null,
	severities = null,
} = {}) {
	if (!capturePresets[preset]) {
		throw new Error(
			`unknown preset "${preset}" - have ${Object.keys(capturePresets).join(", ")}`,
		);
	}
	const perVariantN = Math.max(1, Math.floor(perVariant) || 1);
	const wantedFamilies = restrict(families, Object.keys(FAMILIES));
	const wantedSeverities = restrict(severities, SEVERITIES);

	const cases = [];
	let n = 0;
	for (const family of wantedFamilies) {
		const wantedVariants = restrict(variants, FAMILIES[family]);
		for (const variant of wantedVariants) {
			for (const severity of wantedSeverities) {
				for (let i = 0; i < perVariantN; i++) {
					cases.push({
						id: `${family}-${variant}-${severity}-${pad4(n++)}`,
						family,
						spec: { type: family, variant, severity },
						preset,
					});
				}
			}
		}
	}
	const defectCount = cases.length;
	// the run preset's clean frames - the false-alarm rate under the same
	// capture conditions the defect frames were shot in
	const cleanMain = Math.max(3, Math.ceil(defectCount * CLEAN_FRACTION));
	for (let i = 0; i < cleanMain; i++) {
		cases.push({
			id: `clean-${preset}-none-${pad4(n++)}`,
			family: "clean",
			spec: null,
			preset,
		});
	}
	// plus a few at every preset, so a false alarm can be attributed to the
	// capture quality rather than to the defect library
	for (const name of Object.keys(capturePresets)) {
		if (name === preset) continue;
		for (let i = 0; i < CLEAN_PER_PRESET; i++) {
			cases.push({
				id: `clean-${name}-none-${pad4(n++)}`,
				family: "clean",
				spec: null,
				preset: name,
			});
		}
	}
	return cases;
}

/** The union of the non-"none" channels a frame's defects actually hit. */
function expectedFrom(defects) {
	const channels = new Set();
	for (const d of defects) {
		if (d.channel === "none") continue;
		if (d.channel === "both") {
			channels.add("print");
			channels.add("background");
		} else {
			channels.add(d.channel);
		}
	}
	return {
		pass: channels.size === 0,
		channels: [...channels].sort(),
	};
}

/**
 * The golden raster, from whatever a caller has: encoded image bytes, a
 * raw { data, width, height, channels } descriptor, or nothing at all -
 * in which case the label is drawn from scratch at `width` x `height`.
 * Always grey, always { data: Uint8Array, width, height }, which is the
 * space defects.js and capture.js work in.
 */
async function goldenRaster(source = null, { width = 1500, height = 2100, seed = 1 } = {}) {
	if (source == null) return syntheticLabelRaster(width, height, seed);
	const raw =
		source && source.data != null && source.width > 0 && source.height > 0;
	const pipeline = raw
		? sharp(Buffer.from(source.data), {
				raw: {
					width: source.width,
					height: source.height,
					channels: source.channels || 1,
				},
			})
		: sharp(Buffer.isBuffer(source) ? source : Buffer.from(source));
	const { data, info } = await pipeline
		.removeAlpha()
		.grayscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
	};
}

/**
 * Yield one finished case at a time: the frame bytes, the capture
 * parameters, the measured ground truth and what a detector is expected
 * to say about it. `plan` is a planCases() list; `seed` seeds the single
 * prng every draw comes from.
 */
async function* makeCases({ raster, seed = 1, plan }) {
	const prng = makePrng(seed);
	const total = plan.length;
	for (let index = 0; index < total; index++) {
		const c = plan[index];
		const defected = c.spec ? applyDefect(raster, c.spec, prng) : raster;
		const shot = await capture(defected, c.preset, prng);
		const defects = c.spec ? [defected.gt] : [];
		yield {
			id: c.id,
			family: c.family,
			variant: c.spec ? c.spec.variant : null,
			severity: c.spec ? c.spec.severity : null,
			preset: c.preset,
			buffer: shot.buffer,
			format: shot.format,
			capture: shot.params,
			defects,
			expected: expectedFrom(defects),
			index,
			total,
		};
	}
}

module.exports = {
	planCases,
	expectedFrom,
	makeCases,
	goldenRaster,
	CLEAN_FRACTION,
	CLEAN_PER_PRESET,
};
