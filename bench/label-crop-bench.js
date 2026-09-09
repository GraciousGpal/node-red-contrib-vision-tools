const { performance } = require("node:perf_hooks");
const { labelCrop, available } = require("../lib/labelCrop.js");
const { rawImage } = require("../test/helpers/synthetic.js");
const sharp = require("sharp");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ONLY_RAW = process.argv.includes("--raw");
const EDGE = Number(arg("edge", 640));
const ITERATIONS = Math.max(2, Number(arg("iterations", 5)));
const W = Number(arg("width", 6000));
const H = Number(arg("height", 4000));

/** Synthetic 24MP frame: dark tray, light label rotated 7deg with dark bars. */
function makeFrame() {
	const rgb = Buffer.alloc(W * H * 3);
	const ca = Math.cos((7 * Math.PI) / 180);
	const sa = Math.sin((7 * Math.PI) / 180);
	const cx = W / 2;
	const cy = H / 2;
	const lw = W * 0.6;
	const lh = H * 0.52;
	const bars = [0.15, 0.3, 0.45, 0.6, 0.75].map((f) => (f - 0.5) * lh);
	for (let y = 0; y < H; y++) {
		const row = y * W * 3;
		for (let x = 0; x < W; x++) {
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
			const i = row + x * 3;
			rgb[i] = rgb[i + 1] = rgb[i + 2] = value;
		}
	}
	return rawImage(rgb, W, H, 3, "RGB");
}

function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(samples, key) {
	const values = samples.map((sample) => sample[key]);
	return {
		p50: Math.round(percentile(values, 0.5) * 10) / 10,
		p95: Math.round(percentile(values, 0.95) * 10) / 10,
	};
}

async function measure(input, inputFormat, outputFormat) {
	const samples = [];
	for (let iteration = 0; iteration <= ITERATIONS; iteration++) {
		const started = performance.now();
		const result = await labelCrop(input, {
			maxEdge: EDGE,
			polarity: "light",
			outputFormat,
		});
		if (!result.detected)
			throw new Error(`${inputFormat}: ${result.metadata.reason}`);
		if (iteration === 0) continue; // native/allocator warm-up
		const timing = result.metadata.timings;
		const final = timing.engine.find((entry) => entry.op === "final-crop") || {};
		samples.push({
			decodeMs: timing.decodeMs,
			detectMs: timing.detectCopyMs + timing.maskMs + timing.analysisMs,
			warpMs: timing.rotateMs,
			cropMs: Number(final.taskMs) || 0,
			encodeMs: Number(final.encodeMs) || 0,
			totalMs: performance.now() - started,
		});
	}
	const summary = { inputFormat, outputFormat, iterations: ITERATIONS };
	for (const key of [
		"decodeMs",
		"detectMs",
		"warpMs",
		"cropMs",
		"encodeMs",
		"totalMs",
	]) {
		summary[key] = summarize(samples, key);
	}
	return summary;
}

async function main() {
	if (!available()) {
		console.log(
			"label-crop benchmark: OpenCV engine unavailable on this platform; " +
				"run on Linux x64/arm64, Alpine x64, or macOS arm64.",
		);
		return;
	}
	console.error(`building ${W}x${H} synthetic frame...`);
	const frame = makeFrame();
	const results = [await measure(frame, "raw", "raw")];
	if (!ONLY_RAW) {
		const image = sharp(frame.data, {
			raw: { width: W, height: H, channels: 3 },
		});
		const jpg = await image.clone().jpeg({ quality: 92 }).toBuffer();
		const png = await image.clone().png({ compressionLevel: 1 }).toBuffer();
		results.push(await measure(jpg, "jpg", "jpg"));
		results.push(await measure(png, "png", "png"));
	}
	console.log(
		JSON.stringify(
			{
				frame: { width: W, height: H, megapixels: (W * H) / 1e6 },
				edge: EDGE,
				results,
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
