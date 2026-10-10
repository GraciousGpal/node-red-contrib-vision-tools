/**
 * Bound the drift between two golden-compare runs over the same frames:
 * two `--dump` files from bench/golden-container-bench.js, say one from
 * the previous release's tree (VISION_BENCH_ROOT) and one from this one.
 *
 *   node bench/golden-drift.js reference.jsonl candidate.jsonl
 *
 * Fails (exit 1) on any change an operator would act on - a verdict, a
 * grade, the alignment route, a check's pass - and on any number past its
 * bound below; prints, per msg.result field, how many frames moved and by
 * how much at most. The bounds are what an engine swap that keeps the
 * same decisions may move: the alignment by a tenth of a pixel and a
 * hundredth of a degree, the local alignment's worst tile by three pixels
 * (it snaps to whole-pixel offsets), scores and densities by a hundredth.
 * A blemish region that moves while its check's verdict holds is listed,
 * not failed: on a failing part the regions are the evidence, and a cell
 * on the threshold can join two of them. Measured for the own OpenCV 5
 * engine against rosepetal's 4.x on the rig: 0 verdicts, 0 grades, 0
 * routes; ox 0.058 px, angle 0.0018 deg, localAlign.maxPx 2.07 px;
 * regions moved on 4 of 162 frames, all failing parts that still fail.
 * A re-baseline that needs wider bounds is a change to review, not drift.
 */

"use strict";

const fs = require("node:fs");

// field (array indices folded to []) -> largest |delta| allowed
const BOUNDS = {
	".transform.ox": 0.1,
	".transform.oy": 0.1,
	".transform.angleDeg": 0.01,
	".position.angleDeg": 0.01,
	".transform.scale": 1e-4,
	".transform.scaleX": 1e-4,
	".transform.scaleY": 1e-4,
	".transform.stretchPercent": 0.01,
	".position.scale": 1e-4,
	".position.scaleX": 1e-4,
	".position.scaleY": 1e-4,
	".position.stretchPercent": 0.01,
	".position.dxPx": 1,
	".position.dyPx": 1,
	".position.dxMm": 0.15,
	".position.dyMm": 0.15,
	".transform.score": 0.01,
	".match.score": 0.01,
	".match.coverage": 0.01,
	".localAlign.meanPx": 0.5,
	".localAlign.medianPx": 0.5,
	".localAlign.maxPx": 3,
	".localAlign.localised": 8,
	".thresholds.target": 2,
	".printBlemish.defectRatio": 0.002,
	".backgroundBlemish.defectRatio": 0.002,
	".toneBlemish.defectRatio": 0.002,
	".printBlemish.worstMissing": 0.05,
	".backgroundBlemish.worstExcess": 0.05,
	".speckBlemish.area": 25,
	".speckBlemish.largest": 25,
};
// moves with nothing but timing
const IGNORED = /(^\.timings|Ms$|^\.profile)/;
// any change at all fails
const EXACT = [
	".pass",
	".match.grade",
	".transform.native",
	".transform.nativeFallback",
	".transform.pinned",
	".printBlemish.pass",
	".backgroundBlemish.pass",
	".toneBlemish.pass",
	".speckBlemish.pass",
];

function load(file) {
	const out = new Map();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const r = JSON.parse(line);
		const key = `${r.w}|${r.named}|${r.file}|${r.iter}`;
		// the bench keys fixtures by basename: two with one name would
		// compare against each other's results
		if (out.has(key)) throw new Error(`${file}: ${key} twice`);
		out.set(key, r);
	}
	return out;
}

const HEATMAPS = ["heatmap", "printHeatmap", "backgroundHeatmap", "toneHeatmap", "speckHeatmap"];

function leaves(value, prefix, out) {
	if (value && typeof value === "object") {
		if (Array.isArray(value)) {
			out.set(`${prefix}.length`, value.length);
			value.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out));
		} else {
			for (const [k, v] of Object.entries(value)) leaves(v, `${prefix}.${k}`, out);
		}
	} else {
		out.set(prefix, value);
	}
	return out;
}

const fold = (p) => p.replace(/\[\d+\]/g, "[]");

function main() {
	const [refPath, candPath] = process.argv.slice(2);
	if (!refPath || !candPath) {
		console.error("usage: node bench/golden-drift.js reference.jsonl candidate.jsonl");
		process.exit(2);
	}
	const ref = load(refPath);
	const cand = load(candPath);
	const fields = new Map();
	const breaches = [];
	const regionMoves = new Set();
	const heatmapMoves = new Map();
	let compared = 0;
	for (const [key, a] of ref) {
		const b = cand.get(key);
		if (!b) {
			breaches.push(`${key}: missing from the candidate`);
			continue;
		}
		compared++;
		// which debug stages and heat maps a frame produced is a property
		// of its route and settings: the same, or something else changed
		if (JSON.stringify(a.stages) !== JSON.stringify(b.stages)) breaches.push(`${key}: stages ${a.stages} -> ${b.stages}`);
		for (const h of HEATMAPS) {
			if ((a[h] == null) !== (b[h] == null)) breaches.push(`${key}: ${h} present in one run only`);
			else if (a[h] !== b[h]) heatmapMoves.set(h, (heatmapMoves.get(h) || 0) + 1);
		}
		const la = leaves(a.result, "", new Map());
		const lb = leaves(b.result, "", new Map());
		for (const path of new Set([...la.keys(), ...lb.keys()])) {
			if (IGNORED.test(path)) continue;
			const u = la.get(path);
			const v = lb.get(path);
			if (u === v) continue;
			const f = fold(path);
			const s = fields.get(f) || { frames: 0, max: 0 };
			s.frames++;
			const numeric = typeof u === "number" && typeof v === "number";
			const d = numeric ? Math.abs(u - v) : Infinity;
			s.max = Math.max(s.max, d);
			fields.set(f, s);
			const region = /^\.(\w+Blemish)\.regions/.exec(f);
			if (region) {
				// allowed only while that check's own verdict holds
				const pass = `.${region[1]}.pass`;
				if (la.get(pass) === undefined || la.get(pass) !== lb.get(pass)) {
					breaches.push(`${key}: ${path} moved and ${pass} did not hold`);
				}
				regionMoves.add(key);
				continue;
			}
			const bound = BOUNDS[f];
			if (EXACT.includes(f) || bound === undefined || d > bound) {
				breaches.push(`${key}: ${path} ${JSON.stringify(u)} -> ${JSON.stringify(v)}`);
			}
		}
	}
	if (cand.size !== ref.size) breaches.push(`${ref.size} reference samples, ${cand.size} candidate`);
	console.log(`${compared} samples compared`);
	for (const [f, s] of [...fields].sort((x, y) => y[1].frames - x[1].frames)) {
		const bound = BOUNDS[f];
		console.log(`  ${String(s.frames).padStart(5)} moved  ${f.padEnd(40)} max ${s.max === Infinity ? "(changed)" : s.max.toPrecision(3)}${bound === undefined ? "" : `  bound ${bound}`}`);
	}
	// a heat map follows the alignment pixel for pixel, so any engine
	// change moves it; counted, not failed
	for (const [h, n] of heatmapMoves) console.log(`  ${String(n).padStart(5)} moved  ${h} (bytes)`);
	if (regionMoves.size) {
		console.log(`blemish regions moved on ${regionMoves.size} samples, every check's verdict held:`);
		for (const key of regionMoves) console.log(`  ${key}`);
	}
	if (breaches.length) {
		console.log(`DRIFT: ${breaches.length} past the bounds`);
		for (const b of breaches.slice(0, 20)) console.log(`  ${b}`);
		process.exitCode = 1;
	} else {
		console.log("within bounds");
	}
}

main();
