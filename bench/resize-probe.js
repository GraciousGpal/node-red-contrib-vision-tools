/**
 * Which interpolation does the native engine's resize use?
 *
 * The bridge does not say, and lib/cvjs.js has to match it: the detection
 * copy's pixels decide where `refineRectBoundary` snaps each side of the
 * label, and on an axis-aligned label a sub-pixel difference is enough to
 * pick the wrong edge (see the resize comment in lib/cvjs.js).
 *
 * Downscales a random-texture image through the native engine, then through
 * every opencv.js interpolation, and reports which one reproduces it. Needs
 * both engines, so run it on a host with the native addon.
 *
 *   node bench/resize-probe.js
 */

"use strict";

const { rawImage } = require("../test/helpers/synthetic.js");
const { NATIVE_PATH, probeNative } = require("../lib/engine.js");
const cvjs = require("../lib/cvjs.js");

const SRC = 512;
const DST = 160;

async function main() {
	let bridge;
	try {
		// eslint-disable-next-line global-require
		bridge = require(NATIVE_PATH);
		await probeNative(bridge);
	} catch (err) {
		console.error(`native: unavailable (${err.message.split("\n")[0]})`);
		return;
	}
	const cv = await cvjs.ready();

	// Random texture, because every interpolation agrees on a flat field and
	// most agree on a smooth ramp. Noise separates them.
	const src = Buffer.alloc(SRC * SRC);
	let seed = 42;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (let i = 0; i < src.length; i++) src[i] = Math.floor(rnd() * 256);

	const native = (
		await bridge.resize(
			rawImage(src, SRC, SRC, 1, "GRAY"),
			"num",
			DST,
			"num",
			DST,
			"raw",
		)
	).image;

	const mat = new cv.Mat(SRC, SRC, cv.CV_8UC1);
	mat.data.set(src);
	const rows = [];
	for (const name of [
		"INTER_NEAREST",
		"INTER_LINEAR",
		"INTER_AREA",
		"INTER_CUBIC",
		"INTER_LANCZOS4",
	]) {
		const dst = new cv.Mat();
		cv.resize(mat, dst, new cv.Size(DST, DST), 0, 0, cv[name]);
		let total = 0;
		let max = 0;
		let exact = 0;
		for (let i = 0; i < DST * DST; i++) {
			const d = Math.abs(dst.data[i] - native.data[i]);
			total += d;
			if (d > max) max = d;
			if (d === 0) exact++;
		}
		rows.push({
			interpolation: name,
			meanAbsDiff: Math.round((total / (DST * DST)) * 1000) / 1000,
			maxDiff: max,
			exactPct: Math.round((exact / (DST * DST)) * 1000) / 10,
		});
		dst.delete();
	}
	mat.delete();
	console.table(rows);
	const match = rows.find((r) => r.maxDiff === 0);
	console.log(
		match
			? `native resize == ${match.interpolation}`
			: "no interpolation reproduces the native engine exactly",
	);
}

main().catch((err) => {
	console.error(err.stack || err.message);
	process.exitCode = 1;
});
