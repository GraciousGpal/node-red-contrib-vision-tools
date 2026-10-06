/**
 * Build a synthetic frame set for golden-compare, with a manifest the
 * benchmark runner (bench/synth/run.js) scores against.
 *
 * Usage:
 *   node bench/synth/generate.js --out ./set
 *   node bench/synth/generate.js --out ./set --seed 7 --per-variant 3
 *   node bench/synth/generate.js --out ./set --preset harsh
 *   node bench/synth/generate.js --out ./set --golden /path/to/artwork.png
 *
 * The set is every (family, variant, severity) combination `--per-variant`
 * times, plus a `clean` family - no defect at all, the same camera
 * variation - at no less than a tenth of the set, plus a couple of clean
 * frames at each of the other capture presets. Without the clean frames a
 * detector that flags everything scores perfectly, and the whole point of
 * the two-channel design in lib/compare.js is that it does *not* flag a
 * good part.
 *
 * Everything is driven by one prng seeded from --seed and consumed in a
 * fixed case order, so the same command reproduces the same set byte for
 * byte on any host.
 *
 * The set itself - the plan, the defects, the camera, the ground truth -
 * is lib/synth/cases.js, so the `synthetic-defects` node emits exactly
 * the frames this writes. All that is left here is the directory, the
 * file names and the manifest.
 *
 * Deliberately not done: nothing here inspects anything. This writes
 * frames and ground truth; scoring a detector against them is run.js's
 * job, and keeping the two apart is what lets a set be generated once and
 * replayed against several versions of the node.
 *
 * --golden takes the user's own artwork. The decoded golden is written
 * into the output directory so the set is self-contained for the runner -
 * so point --out at a scratch directory outside the repository when the
 * artwork is a customer's.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { capturePresets } = require("../../lib/synth/capture.js");
const {
	planCases,
	expectedFrom,
	makeCases,
	goldenRaster,
} = require("../../lib/synth/cases.js");

const MANIFEST_VERSION = 1;

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadGolden({ goldenPath, width, height, seed }) {
	if (!goldenPath) {
		const raster = await goldenRaster(null, { width, height, seed });
		return { raster, source: "synthetic", sourcePath: null };
	}
	return {
		raster: await goldenRaster(fs.readFileSync(goldenPath)),
		source: "file",
		sourcePath: path.resolve(goldenPath),
	};
}

function summarize(cases) {
	const families = [...new Set(cases.map((c) => c.family))];
	const channels = ["print", "background", "both", "none"];
	const rows = families.map((family) => {
		const row = { family, frames: 0, defects: 0 };
		for (const ch of channels) row[ch] = 0;
		for (const c of cases) {
			if (c.family !== family) continue;
			row.frames++;
			for (const d of c.defects) {
				row.defects++;
				row[d.channel]++;
			}
		}
		return row;
	});
	const head =
		"family      frames  defects  " +
		channels.map((c) => c.padStart(11)).join("");
	const body = rows.map(
		(r) =>
			r.family.padEnd(12) +
			String(r.frames).padStart(6) +
			String(r.defects).padStart(9) +
			"  " +
			channels.map((c) => String(r[c]).padStart(11)).join(""),
	);
	const failing = cases.filter((c) => !c.expected.pass).length;
	return (
		`${head}\n${body.join("\n")}\n\n` +
		`${cases.length} frames, ${failing} expected to fail, ` +
		`${cases.length - failing} expected to pass ` +
		`(${((cases.filter((c) => c.family === "clean").length / cases.length) * 100).toFixed(1)}% clean)`
	);
}

async function generate({
	out,
	goldenPath = null,
	seed = 1,
	perVariant = 3,
	preset = "typical",
	width = 1500,
	height = 2100,
	rig = true,
	quiet = false,
} = {}) {
	if (!out) throw new Error("--out is required");
	if (!capturePresets[preset]) {
		throw new Error(
			`unknown preset "${preset}" - have ${Object.keys(capturePresets).join(", ")}`,
		);
	}
	const framesDir = path.join(out, "frames");
	fs.mkdirSync(framesDir, { recursive: true });

	const { raster, source, sourcePath } = await loadGolden({
		goldenPath,
		width,
		height,
		seed,
	});
	await sharp(raster.data, {
		raw: { width: raster.width, height: raster.height, channels: 1 },
	})
		.png({ compressionLevel: 9 })
		.toFile(path.join(out, "golden.png"));

	const plan = planCases({ perVariant, preset });
	const cases = [];
	let bytes = 0;
	let rigRecord = null;
	for await (const c of makeCases({ raster, seed, plan, rig })) {
		if (c.rig) rigRecord = c.rig;
		const frame = `frames/${c.id}.${c.format}`;
		fs.writeFileSync(path.join(out, frame), c.buffer);
		bytes += c.buffer.length;
		cases.push({
			id: c.id,
			family: c.family,
			frame,
			capture: c.capture,
			defects: c.defects,
			expected: c.expected,
		});
		if (!quiet && cases.length % 25 === 0) {
			process.stdout.write(`  ${cases.length}/${plan.length} frames\n`);
		}
	}

	const manifest = {
		version: MANIFEST_VERSION,
		seed,
		preset,
		// the magnification and stretch every frame was shot at, or null
		// when each frame drew its own (--rig false)
		rig: rigRecord,
		golden: {
			path: "golden.png",
			width: raster.width,
			height: raster.height,
			source,
			...(sourcePath ? { sourcePath } : {}),
		},
		cases,
	};
	fs.writeFileSync(
		path.join(out, "manifest.json"),
		JSON.stringify(manifest, null, 2),
	);

	if (!quiet) {
		console.log(
			`\n${path.resolve(out)}  golden ${raster.width}x${raster.height} (${source}), ` +
				`preset ${preset}, seed ${seed}, ` +
				(rigRecord
					? `rig pinned at mx ${rigRecord.mx} my ${rigRecord.my}`
					: "free geometry per frame") +
				`\n`,
		);
		console.log(summarize(cases));
		console.log(
			`\nframes ${(bytes / 1e6).toFixed(1)} MB, ` +
				`manifest ${(fs.statSync(path.join(out, "manifest.json")).size / 1e6).toFixed(2)} MB`,
		);
	}
	return manifest;
}

if (require.main === module) {
	generate({
		out: arg("out", null),
		goldenPath: arg("golden", null),
		seed: Number(arg("seed", 1)),
		perVariant: Number(arg("per-variant", 3)),
		preset: arg("preset", "typical"),
		width: Number(arg("width", 1500)),
		height: Number(arg("height", 2100)),
		rig: arg("rig", "true") !== "false",
	}).catch((err) => {
		console.error(err.message);
		process.exitCode = 1;
	});
}

module.exports = { generate, planCases, expectedFrom, MANIFEST_VERSION };
