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
 *
 * --labelcrop 1 runs every frame through lib/labelCrop.js first (blob
 * mode, maxBorderContact 0.75 - this rig's label touches three frame
 * edges when it shifts), so the two pipelines the flow could be wired as
 * can be compared on the same frames: verdicts, the alignment score,
 * the blemish ratios, and the time per frame.
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
const { labelCrop } = require(path.join(root, "lib/labelCrop.js"));

const threshold = Number(arg("threshold", 0.27));
const holdout = Number(arg("holdout", 2));
const mapPath = arg("map", "/tmp/nuisance-map.json");
const useLabelCrop = arg("labelcrop", "0") === "1";
const labelCropCfg = { maxBorderContact: 0.75, outputFormat: "raw" };
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
	const cropMeta = new Map();
	async function frameFor(file) {
		if (!frames.has(file)) {
			const decoded = await bridge.colorConvert(
				fs.readFileSync(file),
				"RGB",
				"raw",
			);
			let frame = await half(decoded.image);
			if (useLabelCrop) {
				const res = await labelCrop(frame, labelCropCfg, bridge);
				cropMeta.set(file, {
					detected: res.detected,
					reason: res.metadata.reason,
					width: res.metadata.width,
					height: res.metadata.height,
					cropMs: Math.round(res.metadata.timings.totalMs),
				});
				if (res.detected) frame = res.image;
			}
			frames.set(file, frame);
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
				align: r.match.score,
				printRatio: r.printBlemish.defectRatio,
				backgroundRatio: r.backgroundBlemish.defectRatio,
				alignMs: out.timings.alignMs,
				totalMs: out.timings.totalMs,
				crop: cropMeta.get(f) || null,
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
	const q = (a, f) => {
		const s = [...a].sort((x, y) => x - y);
		return s.length ? s[Math.floor((s.length - 1) * f)] : NaN;
	};
	const stat = (name, arr, digits = 4) =>
		console.log(
			`  ${name.padEnd(22)} p10 ${q(arr, 0.1).toFixed(digits)}  p50 ${q(arr, 0.5).toFixed(digits)}  p90 ${q(arr, 0.9).toFixed(digits)}  max ${q(arr, 1).toFixed(digits)}`,
		);
	console.log(`\n=== per-frame, good (${goodRows.length}) ===`);
	stat("align score", goodRows.map((r) => r.align));
	stat("print ratio", goodRows.map((r) => r.printRatio), 5);
	stat("background ratio", goodRows.map((r) => r.backgroundRatio), 5);
	stat("excess", goodRows.map((r) => r.excess));
	stat("align ms", goodRows.map((r) => r.alignMs), 0);
	stat("total ms", goodRows.map((r) => r.totalMs), 0);
	const badRows = rows.filter((r) => r.label === "bad");
	console.log(`=== per-frame, bad (${badRows.length}) ===`);
	stat("align score", badRows.map((r) => r.align));
	stat("excess", badRows.map((r) => r.excess));
	console.log(
		`separation: worst good excess ${q(goodRows.map((r) => r.excess), 1).toFixed(4)} vs ` +
			`weakest bad excess ${q(badRows.map((r) => r.excess), 0).toFixed(4)}`,
	);
	if (useLabelCrop) {
		const crops = rows.map((r) => r.crop).filter(Boolean);
		const missed = crops.filter((c) => !c.detected);
		console.log(`=== label-crop (${crops.length} frames) ===`);
		console.log(`  detected ${crops.length - missed.length}, missed ${missed.length}` +
			(missed.length ? ` (${[...new Set(missed.map((c) => c.reason))].join(", ")})` : ""));
		stat("crop width", crops.filter((c) => c.detected).map((c) => c.width), 0);
		stat("crop height", crops.filter((c) => c.detected).map((c) => c.height), 0);
		stat("crop ms", crops.map((c) => c.cropMs), 0);
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
