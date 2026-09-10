/**
 * End-to-end proof of the nuisance map, driven through the real
 * golden-compare handler rather than the library underneath it.
 *
 * Phase 1 trains on the good frames the same way an operator would - send
 * them through with trainNuisance set - and writes a map file. Phase 2
 * turns training off, loads that map, and re-runs every frame, reporting
 * the two numbers that matter: good frames rejected, and bad frames still
 * accepted.
 *
 * --holdout N trains on every Nth good frame only, so the good frames it
 * then scores are mostly ones the map never saw. Without it the good set
 * is scored against a map trained on itself, which flatters the result.
 *
 *   node bench/nuisance-e2e.js --holdout 2 --threshold 0.27
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
const inspector = require(path.join(root, "lib/inspector.js"));

const threshold = Number(arg("threshold", 0.27));
const holdout = Number(arg("holdout", 2));
const mapPath = arg("map", "/tmp/nuisance-map.json");
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** The minimal RED seam golden-compare needs, same shape the other benches use. */
function makeNode(file, config) {
	let ctor;
	const RED = {
		nodes: {
			createNode() {},
			registerType(_name, fn) {
				ctor = fn;
			},
		},
		util: {
			getMessageProperty: (msg, prop) =>
				prop.split(".").reduce((o, k) => (o == null ? o : o[k]), msg),
		},
		settings: {},
	};
	require(file)(RED);
	const node = {
		warnings: [],
		on(evt, fn) {
			if (evt === "input") this._input = fn;
		},
		status() {},
		send() {},
		log() {},
		warn(w) {
			this.warnings.push(String(w));
		},
		error(e) {
			throw e instanceof Error ? e : new Error(String(e));
		},
	};
	ctor.call(node, config);
	return node;
}

function send(node, msg) {
	return new Promise((resolve, reject) => {
		node._input(
			msg,
			(m) => resolve(m ?? msg),
			(err) => (err ? reject(err) : resolve(msg)),
		);
	});
}

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
	const node = makeNode(
		`${installed}/@graciousstar/node-red-contrib-pdf-to-image/pdf-to-image.js`,
		{ ...pdfCfg, outputMode: "message", splitPages: false },
	);
	const out = await send(node, { payload: fs.readFileSync(pdfInput.filename) });
	assert(!Array.isArray(out.payload), "expected exactly one golden page");
	return half(out.payload);
}

function listFixtures(label) {
	const dir = `/data/Inspection/sample_images/${label}`;
	return fs
		.readdirSync(dir)
		.filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
		.sort()
		.map((f) => path.join(dir, f));
}

async function main() {
	const flows = JSON.parse(fs.readFileSync("/data/flows.json"));
	const config = flows.find((n) => n.type === "golden-compare");
	assert(config, "no golden-compare node in the saved flow");
	const golden = await buildGolden(flows, config);
	const goldenKey = hash(golden.data);
	const good = listFixtures("good");
	const bad = listFixtures("bad");

	const frames = new Map();
	async function frameFor(file) {
		if (!frames.has(file)) {
			const decoded = await bridge.colorConvert(
				fs.readFileSync(file),
				"RGB",
				"raw",
			);
			frames.set(file, await half(decoded.image));
		}
		return frames.get(file);
	}

	const base = {
		...config,
		workers: 12,
		trainTransform: false,
		nuisancePath: mapPath,
		noveltyThreshold: threshold,
	};
	const message = (frame) => ({
		payload: frame,
		golden,
		goldenKey,
		trainTransform: false,
	});

	// ---- phase 1: train -------------------------------------------------
	try {
		fs.unlinkSync(mapPath);
	} catch {
		/* first run */
	}
	const trainFiles = good.filter((_, i) => i % holdout === 0);
	const trainer = makeNode(path.join(root, "golden-compare.js"), {
		...base,
		trainNuisance: true,
	});
	let trained;
	for (const f of trainFiles) {
		const out = await send(trainer, message(await frameFor(f)));
		trained = out.trainedNuisance;
	}
	console.log(
		JSON.stringify({
			phase: "train",
			frames: trained.frames,
			grid: [trained.gridW, trained.gridH],
			bytes: fs.statSync(mapPath).size,
		}),
	);

	// ---- phase 2: inspect ----------------------------------------------
	const checker = makeNode(path.join(root, "golden-compare.js"), {
		...base,
		trainNuisance: false,
	});
	const rows = [];
	for (const label of ["good", "bad"]) {
		for (const f of label === "good" ? good : bad) {
			const out = await send(checker, message(await frameFor(f)));
			const r = out.result;
			rows.push({
				file: path.basename(f),
				label,
				heldOut: label === "good" && !trainFiles.includes(f),
				graded: r.pass && r.match.grade === "good",
				excess: r.backgroundBlemish.worstExcess,
				noveltyPass: r.backgroundBlemish.noveltyPass,
			});
		}
	}
	assert(
		!checker.warnings.some((w) => /nuisance map/.test(w)),
		`map was refused: ${checker.warnings.filter((w) => /nuisance/.test(w))[0]}`,
	);

	const goodRows = rows.filter((r) => r.label === "good");
	const heldOut = goodRows.filter((r) => r.heldOut);
	const rejectedGood = goodRows.filter((r) => !r.graded);
	const acceptedBad = rows.filter((r) => r.label === "bad" && r.graded);
	const caughtByNovelty = rows.filter(
		(r) => r.label === "bad" && !r.noveltyPass,
	);

	console.log("\n=== worst held-out good frames ===");
	for (const r of heldOut.sort((a, b) => b.excess - a.excess).slice(0, 6)) {
		console.log(`  ${r.excess.toFixed(4)}  ${r.graded ? "pass" : "REJECT"}  ${r.file}`);
	}
	console.log("\n=== bad frames ===");
	for (const r of rows
		.filter((r) => r.label === "bad")
		.sort((a, b) => b.excess - a.excess)) {
		console.log(
			`  ${r.excess.toFixed(4)}  ${r.graded ? "ACCEPTED" : "rejected"}` +
				`${r.noveltyPass ? "" : "  (novelty gate fired)"}  ${r.file}`,
		);
	}
	console.log("\n=== verdict ===");
	console.log(`trained on ............. ${trainFiles.length} of ${good.length} good frames`);
	console.log(`held-out good frames ... ${heldOut.length}`);
	console.log(`good rejected .......... ${rejectedGood.length} of ${goodRows.length}`);
	console.log(`bad accepted ........... ${acceptedBad.length} of ${bad.length}`);
	console.log(`caught by novelty ...... ${caughtByNovelty.length}`);
	if (rejectedGood.length) {
		console.log(`  rejected: ${rejectedGood.map((r) => r.file).join(", ")}`);
	}
	if (acceptedBad.length) {
		console.log(`  still accepted: ${acceptedBad.map((r) => r.file).join(", ")}`);
	}
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => inspector.shutdown());
