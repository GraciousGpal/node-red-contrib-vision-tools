/**
 * Does the trained nuisance map actually separate the false accepts?
 *
 * Run inside the NodeRed-Test container with NODE_PATH set and
 * VISION_BENCH_ROOT pointing at the source snapshot under test:
 *
 *   node bench/nuisance-validate.js --threshold 0.25 --out /tmp/nuisance.json
 *
 * Two numbers matter and both are reported held-out, never on the frames
 * the map was trained on: the worst novelty score a good frame reaches, and
 * the score the known-bad frames reach. The gap between them is the whole
 * result - a map validated on its own training frames would report a gap it
 * cannot reproduce in production.
 *
 * The good set is split in half by alternating the sorted order (so the two
 * halves interleave in time and neither is "the morning run"), the map is
 * trained on one half and every good frame in the other half is scored
 * against it, then the halves swap. Bad frames are scored against both maps
 * and the worse - more forgiving - of the two is reported.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i < 0 ? fallback : process.argv[i + 1];
}

const root = path.resolve(
	process.env.VISION_BENCH_ROOT || path.join(__dirname, ".."),
);
const installed = "/usr/src/node-red/node_modules";
const bridge = require(
	`${installed}/@rosepetal/node-red-contrib-image-tools/node-red-contrib-image-tools/lib/cpp-bridge.js`,
);
const { compareFrame, prepareGolden } = require(path.join(root, "lib/compare.js"));
const nuisance = require(path.join(root, "lib/nuisanceMap.js"));

const threshold = Number(arg("threshold", 0.25));
const limit = Number(arg("limit", 0));
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function half(image) {
	return (
		await bridge.resize(
			image,
			"num",
			Math.round(image.width / 2),
			"num",
			Math.round(image.height / 2),
			"raw",
		)
	).image;
}

async function buildGolden(flows, config) {
	const pdfCfg = flows.find((n) => n.z === config.z && n.type === "pdf-to-image");
	const pdfInput = flows.find(
		(n) => n.z === config.z && n.type === "file in" && /\.pdf$/i.test(n.filename),
	);
	assert(pdfCfg && pdfInput, "no PDF golden source in the comparison tab");
	// Render through the deployed node so the golden is bit-identical to the
	// one the flow builds; anything else would be measuring a different part.
	const mod = require(
		`${installed}/@graciousstar/node-red-contrib-pdf-to-image/pdf-to-image.js`,
	);
	let handler;
	const RED = {
		nodes: {
			createNode() {},
			registerType(_name, ctor) {
				handler = ctor;
			},
		},
		util: {},
	};
	mod(RED);
	const node = {
		on(_evt, fn) {
			this._fn = fn;
		},
		status() {},
		error(e) {
			throw e;
		},
		warn() {},
		log() {},
	};
	handler.call(node, { ...pdfCfg, outputMode: "message", splitPages: false });
	const out = await new Promise((resolve, reject) => {
		node._fn(
			{ payload: fs.readFileSync(pdfInput.filename) },
			(m) => resolve(m),
			(e) => reject(e),
		);
	});
	assert(!Array.isArray(out.payload), "expected exactly one golden page");
	return half(out.payload);
}

function listFixtures(label) {
	const dir = `/data/Inspection/sample_images/${label}`;
	const files = fs
		.readdirSync(dir)
		.filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
		.sort();
	return (limit ? files.slice(0, limit) : files).map((f) => path.join(dir, f));
}

async function main() {
	const flows = JSON.parse(fs.readFileSync("/data/flows.json"));
	const config = flows.find((n) => n.type === "golden-compare");
	assert(config, "no golden-compare node in the saved flow");
	const golden = await buildGolden(flows, config);
	const goldenKey = hash(golden.data);

	const cfg = { ...config, workers: 12, trainTransform: false };
	delete cfg.nuisanceBaseline;

	const good = listFixtures("good");
	const bad = listFixtures("bad");
	console.log(
		JSON.stringify({
			golden: { w: golden.width, h: golden.height, sha256: goldenKey.slice(0, 12) },
			good: good.length,
			bad: bad.length,
			threshold,
		}),
	);

	// One pass over every frame, keeping the background density grid. The
	// grid is what the map is built from and what it is scored against, so
	// nothing below has to re-run the comparison.
	// compareFrame takes a PREPARED golden - the signatures the search needs
	// are built here, not per frame.
	const prepared = await prepareGolden(golden.data, {
		...cfg,
		raw: {
			width: golden.width,
			height: golden.height,
			channels: golden.channels,
		},
	});
	const grids = new Map();
	async function gridFor(file) {
		if (grids.has(file)) return grids.get(file);
		const decoded = await bridge.colorConvert(fs.readFileSync(file), "RGB", "raw");
		const frame = await half(decoded.image);
		// compareFrame takes raw bytes plus the geometry describing them, the
		// same pair golden-compare hands it after loadImage.
		const r = await compareFrame(frame.data, prepared, {
			...cfg,
			targetRaw: {
				width: frame.width,
				height: frame.height,
				channels: frame.channels,
			},
		});
		const b = r.backgroundBlemish;
		const rec = {
			density: Float32Array.from(b.density),
			gridW: b.gridW,
			gridH: b.gridH,
			basePass: r.pass,
		};
		grids.set(file, rec);
		return rec;
	}

	for (const f of [...good, ...bad]) await gridFor(f);
	const any = grids.get(good[0]);
	console.log(JSON.stringify({ grid: [any.gridW, any.gridH] }));

	function train(files) {
		const acc = nuisance.createAccumulator(any.gridW, any.gridH);
		for (const f of files) nuisance.accumulate(acc, grids.get(f).density);
		return { baseline: nuisance.finalize(acc), acc };
	}
	const score = (file, baseline) =>
		nuisance.excessOver(grids.get(file).density, baseline).worst;

	// Interleaved split, so neither half is a contiguous slice of the run.
	const evens = good.filter((_, i) => i % 2 === 0);
	const odds = good.filter((_, i) => i % 2 === 1);
	const mapA = train(evens); // scores odds
	const mapB = train(odds); // scores evens

	const heldOutGood = [
		...odds.map((f) => ({ file: f, s: score(f, mapA.baseline) })),
		...evens.map((f) => ({ file: f, s: score(f, mapB.baseline) })),
	].sort((a, b) => b.s - a.s);

	const badScores = bad
		.map((f) => ({
			file: f,
			// the more forgiving of the two maps, so the result cannot depend
			// on a lucky split
			s: Math.min(score(f, mapA.baseline), score(f, mapB.baseline)),
			basePass: grids.get(f).basePass,
		}))
		.sort((a, b) => b.s - a.s);

	const worstGood = heldOutGood[0].s;
	const wouldReject = (s) => s >= threshold;
	const falseRejects = heldOutGood.filter((g) => wouldReject(g.s));
	// Frames the existing gates already accept - the ones this has to catch.
	const slipping = badScores.filter((b) => b.basePass);
	const caught = slipping.filter((b) => wouldReject(b.s));

	console.log("\n=== held-out good frames (worst 8) ===");
	for (const g of heldOutGood.slice(0, 8)) {
		console.log(`  ${g.s.toFixed(4)}  ${path.basename(g.file)}`);
	}
	console.log("\n=== bad frames ===");
	for (const b of badScores) {
		const tag = b.basePass ? "SLIPPING-THROUGH" : "already rejected";
		console.log(
			`  ${b.s.toFixed(4)}  ${wouldReject(b.s) ? "CAUGHT " : "missed "} ${tag}  ${path.basename(b.file)}`,
		);
	}
	console.log("\n=== verdict ===");
	console.log(`worst held-out good ....... ${worstGood.toFixed(4)}`);
	console.log(
		`slipping-through frames ... ${slipping.map((b) => b.s.toFixed(4)).join(", ") || "(none)"}`,
	);
	console.log(`threshold ................. ${threshold}`);
	console.log(`new false rejects ......... ${falseRejects.length} of ${heldOutGood.length}`);
	console.log(`false accepts caught ...... ${caught.length} of ${slipping.length}`);
	const margin = slipping.length
		? Math.min(...slipping.map((b) => b.s)) / (worstGood || 1e-9)
		: 0;
	console.log(`separation margin ......... ${margin.toFixed(2)}x`);

	const out = arg("out", null);
	if (out) {
		fs.writeFileSync(
			out,
			JSON.stringify(
				{
					threshold,
					worstGood,
					heldOutGood: heldOutGood.map((g) => ({ f: path.basename(g.file), s: g.s })),
					bad: badScores.map((b) => ({
						f: path.basename(b.file),
						s: b.s,
						basePass: b.basePass,
					})),
					falseRejects: falseRejects.length,
					caught: caught.length,
					slipping: slipping.length,
				},
				null,
				2,
			),
		);
		console.log(`wrote ${out}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
