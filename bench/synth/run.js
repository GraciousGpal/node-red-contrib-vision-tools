/**
 * Detection benchmark for golden-compare against a generated set of
 * synthetic defects.
 *
 * `bench/synth/generate.js` writes a directory of camera-like frames of a
 * label plus a `manifest.json` that says, per frame, exactly what was
 * injected and where. This script runs every frame through the library
 * pipeline (`prepareGolden` / `compareFrame` - not the Node-RED node) and
 * scores the verdict *and the reported regions* against that truth, so
 * the answer is "did it find the scratch" rather than "did it fail the
 * frame". The scoring rules live in ./score.js and are restated in the
 * report it writes.
 *
 * Deliberately not a test, and not named `*.test.js`: it has no pass/fail
 * of its own and exits non-zero only when it crashes. A bad recall number
 * is a finding, not a broken run - a benchmark that fails the build gets
 * tuned until it is green rather than until the detector is good.
 *
 * Two things it deliberately does not do:
 *
 *  - **No concurrency across frames.** `totalMs`/`alignMs` are wall clock
 *    (see the header of bench/frame-bench.js); two frames in flight each
 *    report most of the same window and the timing half of the report
 *    becomes fiction. Frames run strictly sequentially, one warm-up frame
 *    discarded. `--workers` still parallelises *within* a frame.
 *  - **No image writing.** It reads frames and writes two report files.
 *    Nothing here renders a heat map or a debug stage; both are off in
 *    the default cfg because they cost ~1s a frame and change no verdict.
 *
 * Usage:
 *   node bench/synth/run.js <set dir>
 *   node bench/synth/run.js <set dir> --working 1024 --workers 0
 *   node bench/synth/run.js <set dir> --cfg overrides.json --filter scratch
 *   node bench/synth/run.js <set dir> --limit 20 --verbose
 *   node bench/synth/run.js <set dir> --json r.json --md r.md
 *   node bench/synth/run.js <set dir> --sweep blockThreshold=0.1,0.15,0.2
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { prepareGolden, compareFrame } = require("../../lib/compare.js");
const { shutdown } = require("../../lib/pool.js");
const score = require("./score.js");

/**
 * The node's shipped defaults, copied from golden-compare.js's SETTINGS
 * table. Copied rather than imported because SETTINGS is a local inside
 * the node's registration closure; if the two ever drift, this file is
 * the one that is wrong.
 *
 * Two deliberate departures from the node: both heat maps are off (they
 * are pictures for a person and the verdict never reads them) and
 * `debugStages` is off. Neither changes a pass/fail.
 */
function defaultCfg() {
	return {
		workingSize: 1024,
		threshold: 128,
		thresholdMode: "otsu",
		sauvolaRadius: 24,
		sauvolaK: 0.2,
		inkMargin: 8,
		scaleSearchMin: 0.6,
		scaleSearchMax: 2.5,
		scaleSearchSteps: 37,
		alignCandidates: 5,
		workers: 0,
		mismatchScore: 0.15,
		minCoverage: 0.5,
		localAlign: true,
		localAlignTile: 96,
		localAlignMax: 3,
		maxAspect: 0.06,
		aspectSteps: 7,
		maxAngleDeg: 2,
		angleSteps: 5,
		positionToleranceAngleDeg: 1,
		printTolerance: 2,
		backgroundTolerance: 1,
		alignSearch: 16,
		positionToleranceXMm: 2,
		positionToleranceYMm: 2,
		positionToleranceXPx: 16,
		positionToleranceYPx: 16,
		blockSize: 16,
		blockThreshold: 0.15,
		failThreshold: 0.3,
		failRatio: 0.002,
		outputPrintHeatmap: false,
		outputBackgroundHeatmap: false,
		debugStages: false,
		mmPerPixelNative: null,
		calibrationNativeWidth: null,
		calibrationNativeHeight: null,
	};
}

const SCORING_RULES = [
	"A case whose manifest says `expected.pass` is true - a clean frame, or one",
	"whose only injected defects have channel `none`, meaning nothing moved by 64",
	"grey levels - is **correct** when the result passes and a **false fail**",
	"otherwise; the false fail is recorded with which check tripped (position,",
	"print, background) and the largest region reported anywhere.",
	"",
	"A case with a real defect is **detected** only when the result fails *and*",
	"some reported region in a channel that defect could appear in overlaps that",
	"defect's ground-truth box. The box is scaled from golden native pixels to",
	"golden working pixels per axis and padded by one `blockSize` on every side,",
	"because regions are quantised to blocks. A `both` defect is accepted in",
	"either channel. If the result passes it is a **miss**. If the result fails",
	"but no region in an allowed channel touches any defect box it is a **wrong",
	"place** - a fail for the wrong reason is not a detection, and it counts",
	"against recall exactly as a miss does.",
	"",
	"Recall is detected / (all defect cases), so misses and wrong places share",
	"one denominator. Timings are wall clock from strictly sequential frames,",
	"one warm-up frame discarded, heat maps and debug stages off.",
].join("\n");

function parseArgs(argv) {
	const out = { positional: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			out.positional.push(a);
			continue;
		}
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next == null || next.startsWith("--")) {
			out.flags[key] = true;
		} else {
			out.flags[key] = next;
			i++;
		}
	}
	return out;
}

/** JSON where it parses, the raw string otherwise - so a sweep can carry
 * numbers, booleans and mode strings without a per-key table. */
function coerce(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function readManifest(setDir) {
	const file = path.join(setDir, "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!Array.isArray(manifest.cases)) {
		throw new Error(`${file}: no "cases" array`);
	}
	if (!manifest.golden || !manifest.golden.path) {
		throw new Error(`${file}: no "golden.path"`);
	}
	return manifest;
}

function selectCases(manifest, opts) {
	let cases = manifest.cases;
	if (opts.filter) {
		const re = new RegExp(opts.filter);
		cases = cases.filter((c) => re.test(c.id));
	}
	if (opts.limit > 0) cases = cases.slice(0, opts.limit);
	return cases;
}

/**
 * Run one whole set and score it. No file writing and no pool shutdown:
 * the sweep calls this once per value and reuses the workers, and the
 * tests call it directly.
 */
async function runSet(opts) {
	const setDir = path.resolve(opts.dir);
	const manifest = readManifest(setDir);
	const cfg = { ...defaultCfg(), ...(opts.cfg || {}) };
	const goldenPath = path.resolve(setDir, manifest.golden.path);
	const golden = await prepareGolden(fs.readFileSync(goldenPath), cfg);

	// The manifest states the golden's native size; prepareGolden measures
	// it. Trust the measurement for the ratio and say so if they differ,
	// because a silent mismatch would scale every ground-truth box wrongly
	// and read as a detector that cannot find anything.
	const nativeWidth = golden.nativeWidth;
	const nativeHeight = golden.nativeHeight;
	const warnings = [];
	if (
		manifest.golden.width != null &&
		(manifest.golden.width !== nativeWidth ||
			manifest.golden.height !== nativeHeight)
	) {
		warnings.push(
			`manifest golden ${manifest.golden.width}x${manifest.golden.height} but ` +
				`the file is ${nativeWidth}x${nativeHeight}; boxes scaled against the file`,
		);
	}
	const ctx = {
		scaleX: golden.width / nativeWidth,
		scaleY: golden.height / nativeHeight,
		blockSize: cfg.blockSize,
	};

	const cases = selectCases(manifest, opts);
	const records = [];

	// Warm-up: first frame pays worker spawn, JIT and the OS's first read
	// of the frame directory. Not counted - see the header.
	if (cases.length) {
		const warm = fs.readFileSync(path.resolve(setDir, cases[0].frame));
		await compareFrame(warm, golden, { ...cfg });
	}

	for (const caseDef of cases) {
		const buf = fs.readFileSync(path.resolve(setDir, caseDef.frame));
		const t = performance.now();
		const result = await compareFrame(buf, golden, { ...cfg });
		const wallMs = performance.now() - t;
		const record = score.classifyCase(caseDef, result, ctx);
		record.timings = { ...result.timings, wallMs };
		records.push(record);
		if (opts.onCase) opts.onCase(record, records.length, cases.length);
	}

	return {
		meta: {
			set: setDir,
			manifestVersion: manifest.version,
			seed: manifest.seed,
			preset: manifest.preset,
			golden: {
				path: manifest.golden.path,
				nativeWidth,
				nativeHeight,
				workingWidth: golden.width,
				workingHeight: golden.height,
				scaleX: ctx.scaleX,
				scaleY: ctx.scaleY,
			},
			cfg,
			node: process.version,
			ranAt: new Date().toISOString(),
			warnings,
		},
		cases: records,
		summary: score.aggregate(records),
	};
}

const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
const ms = (x) => (x == null ? "-" : String(Math.round(x)));
const num = (x, d) => (x == null ? "-" : x.toFixed(d == null ? 3 : d));

function table(headers, rows) {
	const lines = [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
	];
	for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
	return lines.join("\n");
}

function overallRows(s) {
	return [
		["cases", String(s.overall.cases)],
		["defect cases", String(s.overall.defectCases)],
		["detected", `${s.overall.detected} (${pct(s.overall.recall)} recall)`],
		["missed", String(s.overall.missed)],
		["wrong place", String(s.overall.wrongPlace)],
		["expected-pass cases", String(s.overall.passCases)],
		["false fails", `${s.overall.falseFails} (${pct(s.overall.falseFailRate)})`],
		["match grade good", pct(s.alignment.goodGradeRate)],
		["position pass on expected-pass", pct(s.alignment.cleanPositionPassRate)],
		["mismatch suspected", String(s.alignment.mismatchSuspected)],
	];
}

function bucketRows(map) {
	return Object.keys(map)
		.sort()
		.map((k) => {
			const b = map[k];
			return [k, String(b.total), String(b.detected), String(b.missed), String(b.wrongPlace), pct(b.recall)];
		});
}

/** family x severity recall grid - the one table a tuning session reads first. */
function severityGrid(records) {
	const families = [...new Set(records.filter((r) => !r.expectPass).map((r) => r.family))].sort();
	const severities = ["tiny", "small", "medium", "large"];
	const seen = [...new Set(records.filter((r) => !r.expectPass).map((r) => r.severity))];
	const cols = severities.filter((s) => seen.includes(s)).concat(seen.filter((s) => !severities.includes(s)).sort());
	const rows = families.map((f) => {
		const row = [f];
		for (const sev of cols) {
			const hits = records.filter(
				(r) => !r.expectPass && r.family === f && r.severity === sev,
			);
			if (!hits.length) {
				row.push("-");
				continue;
			}
			const det = hits.filter((r) => r.verdict === "detected").length;
			row.push(`${pct(det / hits.length)} (${det}/${hits.length})`);
		}
		return row;
	});
	return { headers: ["family", ...cols.map(String)], rows };
}

function slowest(records, n) {
	return [...records]
		.sort((a, b) => (b.timings.totalMs || 0) - (a.timings.totalMs || 0))
		.slice(0, n)
		.map((r) => [
			r.id,
			r.pass ? "pass" : "fail",
			ms(r.timings.totalMs),
			ms(r.timings.decodeMs),
			ms(r.timings.alignMs),
			ms(r.timings.searchMs),
			ms(r.timings.localAlignMs),
			ms(r.timings.diffMs),
			ms(r.timings.heatmapMs),
		]);
}

function timingBlock(s) {
	const row = (label, t) => [
		label,
		String(t.count),
		ms(t.totalMs.p50),
		ms(t.totalMs.p90),
		ms(t.totalMs.max),
		ms(t.alignMs.p50),
		ms(t.alignMs.p90),
		ms(t.alignMs.max),
	];
	return table(
		["frames", "n", "total p50", "total p90", "total max", "align p50", "align p90", "align max"],
		[row("passed", s.timings.pass), row("failed", s.timings.fail)],
	);
}

function buildMarkdown(report, sweep) {
	const s = report.summary;
	const out = [];
	out.push("# golden-compare synthetic-defect benchmark");
	out.push("");
	out.push(
		`Set \`${report.meta.set}\` (seed ${report.meta.seed}, preset ` +
			`${report.meta.preset}), golden ${report.meta.golden.nativeWidth}x` +
			`${report.meta.golden.nativeHeight} native -> ${report.meta.golden.workingWidth}x` +
			`${report.meta.golden.workingHeight} working, \`workingSize\` ` +
			`${report.meta.cfg.workingSize}, \`workers\` ${report.meta.cfg.workers}, ` +
			`node ${report.meta.node}, ${report.meta.ranAt}.`,
	);
	if (report.meta.warnings.length) {
		out.push("");
		for (const w of report.meta.warnings) out.push(`> **warning** ${w}`);
	}
	if (sweep) {
		out.push("");
		out.push(
			`> This was a \`--sweep\` of \`${sweep.key}\`. Every table but the last is the ` +
				`**final** swept value's run; the sweep table at the bottom is the comparison.`,
		);
	}
	out.push("");
	out.push("## How a case is scored");
	out.push("");
	out.push(SCORING_RULES);
	out.push("");
	out.push("## Overall");
	out.push("");
	out.push(table(["measure", "value"], overallRows(s)));
	out.push("");
	out.push("## Recall by family and severity");
	out.push("");
	const grid = severityGrid(report.cases);
	out.push(grid.rows.length ? table(grid.headers, grid.rows) : "_no defect cases_");
	out.push("");
	out.push("## By family");
	out.push("");
	out.push(table(["family", "n", "detected", "missed", "wrong place", "recall"], bucketRows(s.byFamily)));
	out.push("");
	out.push("## By variant");
	out.push("");
	out.push(table(["family/variant", "n", "detected", "missed", "wrong place", "recall"], bucketRows(s.byFamilyVariant)));
	out.push("");
	out.push("## By channel");
	out.push("");
	out.push(table(["channel", "n", "detected", "missed", "wrong place", "recall"], bucketRows(s.byChannel)));
	out.push("");
	out.push("## False fails");
	out.push("");
	out.push(
		s.falseFails.length
			? table(
					["id", "family", "failed", "print ratio", "background ratio", "largest region"],
					s.falseFails.map((f) => [
						f.id,
						f.family,
						f.failedParts.join("+") || "-",
						num(f.printRatio, 5),
						num(f.backgroundRatio, 5),
						f.largestRegion
							? `${f.largestRegion.channel} ${f.largestRegion.w}x${f.largestRegion.h} @ ` +
								`${f.largestRegion.x},${f.largestRegion.y} d=${num(f.largestRegion.density)}`
							: "-",
					]),
				)
			: "_none_",
	);
	out.push("");
	out.push("## Misses and wrong places");
	out.push("");
	out.push(
		s.problems.length
			? table(
					["id", "verdict", "family", "variant", "severity", "channel", "defect px", "failed", "regions p/b"],
					s.problems.map((p) => [
						p.id,
						p.verdict,
						p.family,
						String(p.variant),
						String(p.severity),
						String(p.channel),
						String(p.defectPixels),
						p.failedParts.join("+") || "-",
						`${p.printRegions}/${p.backgroundRegions}`,
					]),
				)
			: "_none - every defect case was detected in the right place_",
	);
	out.push("");
	out.push("## Timing");
	out.push("");
	out.push(timingBlock(s));
	out.push("");
	out.push("### Ten slowest frames");
	out.push("");
	out.push(
		table(
			["id", "result", "total", "decode", "align", "search", "localAlign", "diff", "heatmap"],
			slowest(report.cases, 10),
		),
	);
	if (sweep) {
		out.push("");
		out.push(`## Sweep: \`${sweep.key}\``);
		out.push("");
		out.push(
			table(
				[sweep.key, "cases", "detected", "missed", "wrong place", "recall", "false fails", "false fail rate"],
				sweep.rows.map((r) => [
					JSON.stringify(r.value),
					String(r.cases),
					String(r.detected),
					String(r.missed),
					String(r.wrongPlace),
					pct(r.recall),
					String(r.falseFails),
					pct(r.falseFailRate),
				]),
			),
		);
	}
	out.push("");
	return out.join("\n");
}

function printTables(report, sweep) {
	const s = report.summary;
	console.log("\noverall");
	for (const [k, v] of overallRows(s)) {
		console.log(`  ${k.padEnd(32)} ${v}`);
	}
	console.log("\nby family");
	console.log(
		`  ${"family".padEnd(12)} ${"n".padStart(4)} ${"det".padStart(4)} ${"miss".padStart(5)} ${"wrong".padStart(6)}  recall`,
	);
	for (const row of bucketRows(s.byFamily)) {
		console.log(
			`  ${row[0].padEnd(12)} ${row[1].padStart(4)} ${row[2].padStart(4)} ` +
				`${row[3].padStart(5)} ${row[4].padStart(6)}  ${row[5]}`,
		);
	}
	if (sweep) {
		console.log(`\nsweep ${sweep.key}`);
		for (const r of sweep.rows) {
			console.log(
				`  ${String(JSON.stringify(r.value)).padEnd(12)} recall ${pct(r.recall).padStart(7)}  ` +
					`false fails ${String(r.falseFails).padStart(3)} (${pct(r.falseFailRate)})`,
			);
		}
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const setDir = args.positional[0];
	if (!setDir) {
		console.error("usage: node bench/synth/run.js <set dir> [options] - see the header");
		process.exitCode = 1;
		return;
	}
	const cfgOverrides = {};
	if (args.flags.working) cfgOverrides.workingSize = Number(args.flags.working);
	if (args.flags.workers != null && args.flags.workers !== true) {
		cfgOverrides.workers = Number(args.flags.workers);
	}
	if (args.flags.cfg && args.flags.cfg !== true) {
		Object.assign(cfgOverrides, JSON.parse(fs.readFileSync(args.flags.cfg, "utf8")));
	}
	const verbose = !!args.flags.verbose;
	const base = {
		dir: setDir,
		cfg: cfgOverrides,
		filter: args.flags.filter === true ? null : args.flags.filter,
		limit: Number(args.flags.limit) || 0,
		onCase: verbose
			? (r, i, n) =>
					console.log(
						`[${String(i).padStart(4)}/${n}] ${r.verdict.padEnd(12)} ${r.id} ` +
							`(${ms(r.timings.totalMs)}ms, align ${num(r.matchScore)})`,
					)
			: null,
	};

	let sweep = null;
	let report;
	if (args.flags.sweep && args.flags.sweep !== true) {
		const eq = String(args.flags.sweep).indexOf("=");
		if (eq < 0) throw new Error(`--sweep wants "key=v1,v2", got "${args.flags.sweep}"`);
		const key = args.flags.sweep.slice(0, eq);
		const values = args.flags.sweep.slice(eq + 1).split(",").map(coerce);
		const runs = [];
		for (const value of values) {
			console.log(`\n=== ${key} = ${JSON.stringify(value)} ===`);
			report = await runSet({ ...base, cfg: { ...cfgOverrides, [key]: value } });
			runs.push({ value, summary: report.summary });
			printTables(report, null);
		}
		sweep = score.sweepTable(key, runs);
	} else {
		report = await runSet(base);
	}

	const jsonOut =
		args.flags.json && args.flags.json !== true
			? args.flags.json
			: path.join(path.resolve(setDir), "report.json");
	const mdOut =
		args.flags.md && args.flags.md !== true
			? args.flags.md
			: path.join(path.resolve(setDir), "report.md");
	fs.writeFileSync(jsonOut, JSON.stringify({ ...report, sweep }, null, 2));
	fs.writeFileSync(mdOut, buildMarkdown(report, sweep));

	printTables(report, sweep);
	for (const w of report.meta.warnings) console.log(`\nwarning: ${w}`);
	console.log(`\nwrote ${jsonOut}\nwrote ${mdOut}`);
	shutdown();
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err.stack || err);
		shutdown();
		process.exitCode = 1;
	});
}

module.exports = { runSet, defaultCfg, buildMarkdown, printTables, SCORING_RULES };
