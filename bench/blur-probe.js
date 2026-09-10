/**
 * What does the native engine's filter(..., "otsu", kernel, ...) do to the
 * image it was given?
 *
 * Answer, measured: it GaussianBlurs the input with a kernel x kernel
 * window at sigma 0 and writes that back over THE CALLER'S buffer, then
 * Otsu-thresholds the blurred copy and returns the mask.
 *
 * That side effect is load-bearing in label-crop, which calls
 * filter(det, "otsu") and then filter(det, "edge") on the same `det` and
 * hands `det` to refineRectBoundary as its grey image - so the boundary
 * refinement has always run on a blurred copy it never asked for. lib/cvjs.js
 * reproduces it for that reason. This script is the evidence, and the check
 * that it is still true of a new engine version.
 *
 *   node bench/blur-probe.js
 */

"use strict";

const crypto = require("node:crypto");

const { rawImage } = require("../test/helpers/synthetic.js");
const { NATIVE_PATH, probeNative } = require("../lib/engine.js");
const cvjs = require("../lib/cvjs.js");

const W = 128;
const H = 128;

const sha = (view) =>
	crypto.createHash("sha1").update(view).digest("hex").slice(0, 12);

function noise() {
	const data = Buffer.alloc(W * H);
	let seed = 3;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (let i = 0; i < data.length; i++) data[i] = Math.floor(rnd() * 256);
	return data;
}

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
	const base = noise();

	// 1. does each engine mutate the buffer it was handed?
	const rows = [];
	for (const [name, engine] of [
		["native", bridge],
		["opencv-js", cvjs],
	]) {
		const input = Buffer.from(base);
		const before = sha(input);
		const result = await engine.filter(
			rawImage(input, W, H, 1, "GRAY"),
			"otsu",
			3,
			0,
			"raw",
		);
		rows.push({
			engine: name,
			inputMutated: sha(input) !== before,
			inputSha: sha(input),
			maskSha: sha(
				new Uint8Array(
					result.image.data.buffer,
					result.image.data.byteOffset,
					W * H,
				),
			),
		});
	}
	console.table(rows);
	console.log(
		rows[0].inputSha === rows[1].inputSha
			? "the engines leave the caller's buffer in the same state"
			: "MISMATCH: the engines leave the caller's buffer differently",
	);
	console.log(
		rows[0].maskSha === rows[1].maskSha
			? "the engines return the same mask"
			: "MISMATCH: the engines return different masks",
	);

	// 2. which blur reproduces what native left behind?
	const probe = Buffer.from(base);
	await bridge.filter(rawImage(probe, W, H, 1, "GRAY"), "otsu", 3, 0, "raw");
	const src = new cv.Mat(H, W, cv.CV_8UC1);
	src.data.set(base);
	const candidates = {
		"blur 3x3 (box)": (d) => cv.blur(src, d, new cv.Size(3, 3)),
		"GaussianBlur 3x3 sigma 0": (d) =>
			cv.GaussianBlur(src, d, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT),
		"GaussianBlur 3x3 sigma 1": (d) =>
			cv.GaussianBlur(src, d, new cv.Size(3, 3), 1, 1, cv.BORDER_DEFAULT),
		"medianBlur 3": (d) => cv.medianBlur(src, d, 3),
	};
	const kernels = [];
	for (const [name, run] of Object.entries(candidates)) {
		const dst = new cv.Mat();
		run(dst);
		let total = 0;
		let max = 0;
		for (let i = 0; i < W * H; i++) {
			const d = Math.abs(dst.data[i] - probe[i]);
			total += d;
			if (d > max) max = d;
		}
		kernels.push({
			candidate: name,
			meanAbsDiff: Math.round((total / (W * H)) * 1000) / 1000,
			maxDiff: max,
		});
		dst.delete();
	}
	src.delete();
	console.table(kernels);
	const match = kernels.find((k) => k.maxDiff === 0);
	console.log(
		match
			? `native leaves behind exactly: ${match.candidate}`
			: "no candidate reproduces what native leaves behind",
	);
}

main().catch((err) => {
	console.error(err.stack || err.message);
	process.exitCode = 1;
});
