/**
 * Scoring for the synthetic-defect benchmark: does a `golden-compare`
 * result agree with the ground truth a generated frame carries?
 *
 * Pure functions, no I/O and no `sharp`, so the rules can be tested
 * against hand-built results in milliseconds rather than by generating
 * images. `run.js` owns every file read, the pipeline and the report;
 * this module owns only the arithmetic and the verdict.
 *
 * It deliberately does *not* decide anything the manifest already states.
 * `expected.pass` and each defect's `channel` are ground truth and are
 * taken at face value; nothing here re-derives them from the defect's
 * pixel counts, because a scorer that second-guesses its own ground truth
 * can be tuned into agreeing with the node.
 *
 * The one rule worth stating twice: a frame that fails for the wrong
 * reason is not a detection. If the node rejects a scratched label
 * because the position check tripped, or because a region appeared
 * somewhere the scratch is not, that is a `wrong-place` and counts
 * against recall exactly as a miss does.
 */

"use strict";

const VERDICTS = ["correct-pass", "false-fail", "detected", "missed", "wrong-place"];

/** The channels a defect may legitimately be reported in. */
function defectChannels(defect) {
	const ch = defect && defect.channel;
	if (ch === "both") return ["print", "background"];
	if (ch === "print" || ch === "background") return [ch];
	// "none" - the injection changed no pixel by enough to see - and any
	// value the generator may add later that this scorer does not know.
	return [];
}

/**
 * Defects that the node can fairly be asked to find. A "none" defect
 * changed nothing visible, so the case behaves like a clean one.
 */
function scoringDefects(caseDef) {
	return (caseDef.defects || []).filter((d) => defectChannels(d).length > 0);
}

/** True when the correct verdict for this case is a pass. */
function expectsPass(caseDef) {
	if (caseDef.expected && caseDef.expected.pass === true) return true;
	return scoringDefects(caseDef).length === 0;
}

/**
 * Ground-truth boxes are in the golden's NATIVE pixels; regions come back
 * in its WORKING pixels, and the two axes are rounded independently by
 * prepareGolden, so each gets its own factor.
 *
 * `pad` widens the box by one block on every side. Regions are quantised
 * to `blockSize`, so a defect that lands one pixel inside a block paints
 * the whole block, and a block-aligned region can legitimately sit up to
 * a block away from the pixels that caused it.
 */
function scaleBox(bbox, scaleX, scaleY, pad) {
	const p = pad || 0;
	const x0 = bbox.x * scaleX - p;
	const y0 = bbox.y * scaleY - p;
	const x1 = (bbox.x + bbox.w) * scaleX + p;
	const y1 = (bbox.y + bbox.h) * scaleY + p;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Axis-aligned overlap. Touching edges do not count as overlapping. */
function boxesOverlap(a, b) {
	return (
		a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
	);
}

function regionArea(r) {
	return r.w * r.h;
}

/**
 * The first region in `regions` that overlaps `box`, or null. Regions
 * arrive sorted by density, so "first" is also "dirtiest", which is the
 * one a tuning session wants to see.
 */
function findOverlap(regions, box) {
	for (const r of regions || []) {
		if (boxesOverlap(r, box)) return r;
	}
	return null;
}

function largestRegion(result) {
	let best = null;
	for (const channel of ["print", "background", "tone", "speck"]) {
		for (const r of (result[`${channel}Blemish`] || {}).regions || []) {
			if (!best || regionArea(r) > regionArea(best)) best = { channel, ...r };
		}
	}
	return best;
}

function failedParts(result) {
	const parts = [];
	if (result.position && result.position.pass === false) parts.push("position");
	if (result.printBlemish && result.printBlemish.pass === false) parts.push("print");
	if (result.backgroundBlemish && result.backgroundBlemish.pass === false) {
		parts.push("background");
	}
	if (result.toneBlemish && result.toneBlemish.pass === false) parts.push("tone");
	if (result.speckBlemish && result.speckBlemish.pass === false) parts.push("specks");
	return parts;
}

/**
 * Classify one case.
 *
 * `ctx` is `{ scaleX, scaleY, blockSize }` - the golden working/native
 * ratio per axis and the block quantisation the regions were built on.
 *
 * Returns a flat record; `run.js` adds timings and writes it straight
 * into the report, and the aggregator below reads only these fields.
 */
function classifyCase(caseDef, result, ctx) {
	const scaleX = ctx.scaleX;
	const scaleY = ctx.scaleY;
	const pad = ctx.blockSize || 0;
	const defects = scoringDefects(caseDef);
	const expectPass = expectsPass(caseDef);
	const regionsOf = (channel) =>
		((result[`${channel}Blemish`] || {}).regions) || [];

	// Every scoring defect, with its box already in working px so the
	// report can point a person at it without redoing the arithmetic.
	const located = defects.map((d) => ({
		type: d.type,
		variant: d.variant,
		severity: d.severity,
		channel: d.channel,
		bbox: d.bbox,
		box: d.bbox ? scaleBox(d.bbox, scaleX, scaleY, pad) : null,
		printPixels: d.printPixels || 0,
		backgroundPixels: d.backgroundPixels || 0,
	}));

	const record = {
		id: caseDef.id,
		family: caseDef.family,
		// One defect per case is the generator's normal shape; when there
		// are several, the buckets follow the first, which is the one the
		// case is named after.
		variant: defects.length ? defects[0].variant : null,
		severity: defects.length ? defects[0].severity : null,
		channel: defects.length ? defects[0].channel : "none",
		defectCount: defects.length,
		declaredDefects: (caseDef.defects || []).length,
		expectPass,
		pass: !!result.pass,
		positionPass: result.position ? !!result.position.pass : null,
		printPass: result.printBlemish ? !!result.printBlemish.pass : null,
		backgroundPass: result.backgroundBlemish
			? !!result.backgroundBlemish.pass
			: null,
		failedParts: failedParts(result),
		dxPx: result.position ? result.position.dxPx : null,
		dyPx: result.position ? result.position.dyPx : null,
		angleDeg: result.position ? result.position.angleDeg : null,
		matchGrade: result.match ? result.match.grade : null,
		matchScore: result.match ? result.match.score : null,
		mismatchSuspected: !!(result.match && result.match.mismatchSuspected),
		printRatio: result.printBlemish ? result.printBlemish.defectRatio : null,
		backgroundRatio: result.backgroundBlemish
			? result.backgroundBlemish.defectRatio
			: null,
		printRegions: regionsOf("print").length,
		backgroundRegions: regionsOf("background").length,
		toneRegions: regionsOf("tone").length,
		toneRatio: result.toneBlemish ? result.toneBlemish.defectRatio : null,
		speckCount: result.speckBlemish ? result.speckBlemish.count : null,
		defectPixels: located.reduce(
			(n, d) => n + d.printPixels + d.backgroundPixels,
			0,
		),
		defects: located,
		hit: null,
		largestRegion: largestRegion(result),
		verdict: null,
	};

	if (expectPass) {
		record.verdict = record.pass ? "correct-pass" : "false-fail";
		return record;
	}

	if (record.pass) {
		record.verdict = "missed";
		return record;
	}

	// Failed, as it should have. Did it fail *there*, in a channel the
	// defect could plausibly show up in? The tone check is grey evidence
	// of either kind - a smudge is extra ink, faded print is missing ink -
	// so a tone region on the defect counts whichever channel it was in.
	for (const d of located) {
		if (!d.box) continue;
		for (const channel of defectChannels(d)) {
			const hit = findOverlap(regionsOf(channel), d.box);
			if (hit) {
				record.hit = { channel, defect: d.type, ...hit };
				record.verdict = "detected";
				return record;
			}
		}
		const toneHit = findOverlap(regionsOf("tone"), d.box);
		if (toneHit) {
			record.hit = { channel: "tone", defect: d.type, ...toneHit };
			record.verdict = "detected";
			return record;
		}
		// specks likewise: dust is extra ink, pinholes are missing ink
		const speckHit = findOverlap(regionsOf("speck"), d.box);
		if (speckHit) {
			record.hit = { channel: "speck", defect: d.type, ...speckHit };
			record.verdict = "detected";
			return record;
		}
	}
	record.verdict = "wrong-place";
	return record;
}

function percentile(values, p) {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[i];
}

function timingStats(records, pick) {
	const total = records.map((r) => pick(r, "totalMs")).filter(Number.isFinite);
	const align = records.map((r) => pick(r, "alignMs")).filter(Number.isFinite);
	return {
		count: records.length,
		totalMs: {
			p50: percentile(total, 50),
			p90: percentile(total, 90),
			max: total.length ? Math.max(...total) : null,
		},
		alignMs: {
			p50: percentile(align, 50),
			p90: percentile(align, 90),
			max: align.length ? Math.max(...align) : null,
		},
	};
}

function emptyBucket() {
	return { total: 0, detected: 0, missed: 0, wrongPlace: 0, recall: 0 };
}

function addToBucket(map, key, record) {
	if (!map[key]) map[key] = emptyBucket();
	const b = map[key];
	b.total++;
	if (record.verdict === "detected") b.detected++;
	else if (record.verdict === "missed") b.missed++;
	else if (record.verdict === "wrong-place") b.wrongPlace++;
	b.recall = b.total ? b.detected / b.total : 0;
	return b;
}

/**
 * Roll the per-case records up.
 *
 * Recall is `detected / (defect cases)` - misses and wrong-places both sit
 * in the denominator and neither in the numerator, which is the whole
 * point of separating them: a set can move from "missed" to "wrong-place"
 * without recall improving, and that move is a real change worth seeing.
 */
function aggregate(records) {
	const defectCases = records.filter((r) => !r.expectPass);
	const passCases = records.filter((r) => r.expectPass);

	const byFamily = {};
	const byFamilyVariant = {};
	const byFamilySeverity = {};
	const bySeverity = {};
	const byChannel = {};
	for (const r of defectCases) {
		addToBucket(byFamily, r.family, r);
		addToBucket(byFamilyVariant, `${r.family}/${r.variant}`, r);
		addToBucket(byFamilySeverity, `${r.family}/${r.severity}`, r);
		addToBucket(bySeverity, String(r.severity), r);
		addToBucket(byChannel, String(r.channel), r);
	}

	const detected = defectCases.filter((r) => r.verdict === "detected").length;
	const missed = defectCases.filter((r) => r.verdict === "missed").length;
	const wrongPlace = defectCases.filter((r) => r.verdict === "wrong-place").length;
	const falseFails = passCases.filter((r) => r.verdict === "false-fail");

	const graded = records.filter((r) => r.matchGrade != null);
	const positionOnClean = passCases.filter((r) => r.positionPass != null);

	return {
		overall: {
			cases: records.length,
			defectCases: defectCases.length,
			passCases: passCases.length,
			detected,
			missed,
			wrongPlace,
			recall: defectCases.length ? detected / defectCases.length : 0,
			falseFails: falseFails.length,
			falseFailRate: passCases.length ? falseFails.length / passCases.length : 0,
		},
		byFamily,
		byFamilyVariant,
		byFamilySeverity,
		bySeverity,
		byChannel,
		falseFails: falseFails.map((r) => ({
			id: r.id,
			family: r.family,
			failedParts: r.failedParts,
			printRatio: r.printRatio,
			backgroundRatio: r.backgroundRatio,
			largestRegion: r.largestRegion,
		})),
		problems: defectCases
			.filter((r) => r.verdict !== "detected")
			.map((r) => ({
				id: r.id,
				verdict: r.verdict,
				family: r.family,
				variant: r.variant,
				severity: r.severity,
				channel: r.channel,
				defectPixels: r.defectPixels,
				failedParts: r.failedParts,
				printRegions: r.printRegions,
				backgroundRegions: r.backgroundRegions,
				toneRegions: r.toneRegions,
				speckCount: r.speckCount,
				largestRegion: r.largestRegion,
			})),
		timings: {
			pass: timingStats(
				records.filter((r) => r.pass),
				(r, k) => (r.timings || {})[k],
			),
			fail: timingStats(
				records.filter((r) => !r.pass),
				(r, k) => (r.timings || {})[k],
			),
		},
		alignment: {
			goodGradeRate: graded.length
				? graded.filter((r) => r.matchGrade === "good").length / graded.length
				: 0,
			cleanPositionPassRate: positionOnClean.length
				? positionOnClean.filter((r) => r.positionPass).length /
					positionOnClean.length
				: 0,
			mismatchSuspected: records.filter((r) => r.mismatchSuspected).length,
		},
	};
}

/**
 * One row per swept value: what the whole set scored with that setting.
 * `runs` is `[{ value, summary }]` where `summary` is an aggregate above.
 */
function sweepTable(key, runs) {
	return {
		key,
		rows: runs.map((run) => ({
			value: run.value,
			cases: run.summary.overall.cases,
			detected: run.summary.overall.detected,
			missed: run.summary.overall.missed,
			wrongPlace: run.summary.overall.wrongPlace,
			recall: run.summary.overall.recall,
			falseFails: run.summary.overall.falseFails,
			falseFailRate: run.summary.overall.falseFailRate,
		})),
	};
}

module.exports = {
	VERDICTS,
	defectChannels,
	scoringDefects,
	expectsPass,
	scaleBox,
	boxesOverlap,
	findOverlap,
	largestRegion,
	failedParts,
	classifyCase,
	percentile,
	aggregate,
	sweepTable,
};
