/**
 * Native OpenCV addon vs the opencv.js WASM build, same host, same frames.
 *
 * Runs whichever engines actually load, so on a machine with no native
 * build it still reports the WASM numbers - it just has nothing to compare
 * them against. Both stages that use an engine are measured:
 *
 *   label-crop  - the full deskew-and-crop pipeline (resize, Otsu, Sobel,
 *                 crop, rotate, crop) on a synthetic raw frame
 *   imageAlign  - golden-compare's fast align (ORB + ECC + warp)
 *
 * Usage:
 *   node bench/engine-compare.js [--width 4000] [--height 3000]
 *                               [--iterations 5] [--edge 640]
 */

"use strict";

const { performance } = require("node:perf_hooks");

const { labelCrop } = require("../lib/labelCrop.js");
const { rawImage } = require("../test/helpers/synthetic.js");
const { NATIVE_PATH, probeNative } = require("../lib/engine.js");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const W = arg("width", 4000);
const H = arg("height", 3000);
const EDGE = arg("edge", 640);
const ITERATIONS = Math.max(2, arg("iterations", 5));
const ALIGN_SIZE = arg("align", 1024);

/** Dark tray, light label rotated 7deg, dark bars across it. */
function makeFrame(width, height, channels, angleDeg = 7) {
	const data = Buffer.alloc(width * height * channels);
	const ca = Math.cos((angleDeg * Math.PI) / 180);
	const sa = Math.sin((angleDeg * Math.PI) / 180);
	const cx = width / 2;
	const cy = height / 2;
	const lw = width * 0.6;
	const lh = height * 0.52;
	const bars = [0.15, 0.3, 0.45, 0.6, 0.75].map((f) => (f - 0.5) * lh);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = (x - cx) * ca + (y - cy) * sa;
			const v = -(x - cx) * sa + (y - cy) * ca;
			let value = 70;
			if (Math.abs(u) <= lw / 2 && Math.abs(v) <= lh / 2) {
				value = 236;
				for (const bar of bars) {
					if (Math.abs(u) < lw * 0.35 && Math.abs(v - bar) < lh * 0.03) {
						value = 30;
						break;
					}
				}
			}
			const i = (y * width + x) * channels;
			for (let c = 0; c < channels; c++) data[i + c] = value;
		}
	}
	return rawImage(data, width, height, channels, channels === 1 ? "GRAY" : "RGB");
}

/** The same frame translated, which is what the aligner has to recover. */
function shiftFrame(source, dx, dy) {
	const { width, height } = source;
	const out = Buffer.alloc(width * height, 70);
	for (let y = 0; y < height; y++) {
		const sy = y - dy;
		if (sy < 0 || sy >= height) continue;
		for (let x = 0; x < width; x++) {
			const sx = x - dx;
			if (sx < 0 || sx >= width) continue;
			out[y * width + x] = source.data[sy * width + sx];
		}
	}
	return rawImage(out, width, height, 1, "GRAY");
}

function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function stats(values) {
	return {
		p50: Math.round(percentile(values, 0.5) * 10) / 10,
		p95: Math.round(percentile(values, 0.95) * 10) / 10,
	};
}

/** Engines that actually work here, not merely those that require(). */
async function engines() {
	const found = [];
	try {
		// eslint-disable-next-line global-require
		const native = require(NATIVE_PATH);
		// not native.ready(): cpp-bridge 1.6.4 has no such method, and the
		// point of the probe is to work on both - see lib/engine.js
		await probeNative(native);
		found.push({ name: "native", engine: native });
	} catch (err) {
		console.error(`native: unavailable (${err.message.split("\n")[0]})`);
	}
	try {
		// eslint-disable-next-line global-require
		const cvjs = require("../lib/cvjs.js");
		// eslint-disable-next-line global-require
		const { imageAlign } = require("../lib/cvjsAlign.js");
		const t0 = performance.now();
		await cvjs.ready();
		console.error(`opencv-js: runtime ready in ${Math.round(performance.now() - t0)}ms`);
		found.push({
			name: "opencv-js",
			engine: {
				colorConvert: cvjs.colorConvert,
				resize: cvjs.resize,
				filter: cvjs.filter,
				crop: cvjs.crop,
				rotate: cvjs.rotate,
				imageAlign,
			},
		});
	} catch (err) {
		console.error(`opencv-js: unavailable (${err.message})`);
	}
	return found;
}

async function benchLabelCrop(engine, frame) {
	const samples = [];
	let detected = null;
	for (let i = 0; i <= ITERATIONS; i++) {
		const started = performance.now();
		const result = await labelCrop(
			frame,
			{ maxEdge: EDGE, polarity: "light", outputFormat: "raw" },
			engine,
		);
		const elapsed = performance.now() - started;
		if (!result.detected) throw new Error(`miss: ${result.metadata.reason}`);
		if (i === 0) continue; // warm-up: allocator, WASM heap growth
		detected = result.metadata;
		samples.push(elapsed);
	}
	return {
		totalMs: stats(samples),
		angleDeg: detected.angleDeg,
		width: detected.width,
		height: detected.height,
	};
}

async function benchAlign(engine, golden, target) {
	const samples = [];
	let last = null;
	for (let i = 0; i <= ITERATIONS; i++) {
		const started = performance.now();
		last = await engine.imageAlign(
			golden, target, 0.35, 30, 1e-3, "raw", 90, false, true, null,
			"affine", "features+ecc", "auto", "orb",
		);
		const elapsed = performance.now() - started;
		if (i === 0) continue;
		samples.push(elapsed);
	}
	const m = last && last.transformMatrix ? last.transformMatrix.matrix2x3 : null;
	return {
		totalMs: stats(samples),
		success: !!(last && last.success),
		offset: m ? [Math.round(m[2] * 100) / 100, Math.round(m[5] * 100) / 100] : null,
	};
}

async function main() {
	const available = await engines();
	if (available.length === 0) {
		console.log("no OpenCV engine available");
		return;
	}
	console.error(`building ${W}x${H} frame and ${ALIGN_SIZE}px align pair...`);
	const frame = makeFrame(W, H, 3);
	const golden = makeFrame(ALIGN_SIZE, ALIGN_SIZE, 1, 0);
	const target = shiftFrame(golden, 11, -6);

	const rows = [];
	for (const { name, engine } of available) {
		const row = { engine: name };
		try {
			const crop = await benchLabelCrop(engine, frame);
			row.labelCropP50 = crop.totalMs.p50;
			row.labelCropP95 = crop.totalMs.p95;
			row.angleDeg = crop.angleDeg;
		} catch (err) {
			row.labelCropP50 = `failed: ${err.message}`;
		}
		try {
			const align = await benchAlign(engine, golden, target);
			row.alignP50 = align.totalMs.p50;
			row.alignP95 = align.totalMs.p95;
			// the recovered shift; the truth is (11, -6)
			row.alignOffset = align.success ? JSON.stringify(align.offset) : "no solve";
		} catch (err) {
			row.alignP50 = `failed: ${err.message}`;
		}
		rows.push(row);
	}
	console.table(rows);
	console.log(
		JSON.stringify(
			{
				frame: { width: W, height: H, megapixels: (W * H) / 1e6 },
				align: { size: ALIGN_SIZE, trueOffset: [11, -6] },
				edge: EDGE,
				iterations: ITERATIONS,
				rows,
			},
			null,
			2,
		),
	);
}

main().catch((err) => {
	console.error(err.stack || err.message);
	process.exitCode = 1;
});
