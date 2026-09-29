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
const { makePrng } = require("./prng.js");
const { syntheticLabelRaster } = require("./label.js");
const { applyDefect, FAMILIES, SEVERITIES } = require("./defects.js");
const { capture, capturePresets } = require("./capture.js");

const MANIFEST_VERSION = 1;
// clean frames as a fraction of the defect frames. 0.15 of the defect
// count is a little over a tenth of the whole set, which is the floor the
// false-alarm measurement needs to mean anything.
const CLEAN_FRACTION = 0.15;
const CLEAN_PER_PRESET = 2;

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pad4 = (n) => String(n).padStart(4, "0");

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

async function loadGolden({ goldenPath, width, height, seed }) {
	if (!goldenPath) {
		const raster = await syntheticLabelRaster(width, height, seed);
		return { raster, source: "synthetic", sourcePath: null };
	}
	const { data, info } = await sharp(goldenPath)
		.removeAlpha()
		.grayscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		raster: {
			data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			width: info.width,
			height: info.height,
		},
		source: "file",
		sourcePath: path.resolve(goldenPath),
	};
}

/** The case list, in the order the prng will be consumed. */
function planCases(perVariant, preset) {
	const cases = [];
	let n = 0;
	for (const [family, variants] of Object.entries(FAMILIES)) {
		for (const variant of variants) {
			for (const severity of SEVERITIES) {
				for (let i = 0; i < perVariant; i++) {
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

	const prng = makePrng(seed);
	const plan = planCases(perVariant, preset);
	const cases = [];
	let bytes = 0;
	for (const c of plan) {
		const defected = c.spec ? applyDefect(raster, c.spec, prng) : raster;
		const shot = await capture(defected, c.preset, prng);
		const frame = `frames/${c.id}.${shot.format}`;
		fs.writeFileSync(path.join(out, frame), shot.buffer);
		bytes += shot.buffer.length;
		const defects = c.spec ? [defected.gt] : [];
		cases.push({
			id: c.id,
			family: c.family,
			frame,
			capture: shot.params,
			defects,
			expected: expectedFrom(defects),
		});
		if (!quiet && cases.length % 25 === 0) {
			process.stdout.write(`  ${cases.length}/${plan.length} frames\n`);
		}
	}

	const manifest = {
		version: MANIFEST_VERSION,
		seed,
		preset,
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
				`preset ${preset}, seed ${seed}\n`,
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
	}).catch((err) => {
		console.error(err.message);
		process.exitCode = 1;
	});
}

module.exports = { generate, planCases, expectedFrom, MANIFEST_VERSION };
