/**
 * Do the two OpenCV engines agree on the same frames?
 *
 * bench/engine-compare.js answers "how fast"; this answers "does it decide
 * the same thing", which is the question that decides whether the WASM
 * engine is a drop-in on a rig that was tuned against the native one.
 *
 * Reports label-crop's detection metadata side by side over a sweep of
 * angles and label sizes, and flags any frame where the two disagree by
 * more than the tolerances below.
 *
 * Usage:
 *   node bench/engine-parity.js [--width 2000] [--height 1500]
 */

"use strict";

const { labelCrop } = require("../lib/labelCrop.js");
const { rawImage } = require("../test/helpers/synthetic.js");
const { NATIVE_PATH, probeNative } = require("../lib/engine.js");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const W = arg("width", 2000);
const H = arg("height", 1500);

// What counts as agreement. The engines resample differently (INTER_AREA
// vs whatever the addon picks), so the detection copy can differ by a
// pixel at the boundary; these are the tolerances that difference can
// produce without changing what an operator would do with the result.
const TOLERANCE = { angleDeg: 0.25, centerPx: 3, sizePx: 6 };

function labelFrame(width, height, angleDeg, labelWidth, labelHeight) {
	const data = Buffer.alloc(width * height * 3, 70);
	const ca = Math.cos((angleDeg * Math.PI) / 180);
	const sa = Math.sin((angleDeg * Math.PI) / 180);
	const cx = width / 2;
	const cy = height / 2;
	const bars = [0.2, 0.4, 0.6, 0.8].map((f) => (f - 0.5) * labelHeight);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = (x - cx) * ca + (y - cy) * sa;
			const v = -(x - cx) * sa + (y - cy) * ca;
			let value = 70;
			if (Math.abs(u) <= labelWidth / 2 && Math.abs(v) <= labelHeight / 2) {
				value = 236;
				for (const bar of bars) {
					if (Math.abs(u) < labelWidth * 0.35 && Math.abs(v - bar) < labelHeight * 0.03) {
						value = 30;
						break;
					}
				}
			}
			const i = (y * width + x) * 3;
			data[i] = data[i + 1] = data[i + 2] = value;
		}
	}
	return rawImage(data, width, height, 3, "RGB");
}

async function main() {
	let native = null;
	try {
		// eslint-disable-next-line global-require
		const bridge = require(NATIVE_PATH);
		await probeNative(bridge);
		native = bridge;
	} catch (err) {
		console.error(`native: unavailable (${err.message.split("\n")[0]})`);
		console.error("parity needs both engines; run this on a host with the addon.");
		return;
	}
	// eslint-disable-next-line global-require
	const cvjs = require("../lib/cvjs.js");
	// eslint-disable-next-line global-require
	const { imageAlign } = require("../lib/cvjsAlign.js");
	await cvjs.ready();
	const wasm = {
		colorConvert: cvjs.colorConvert,
		resize: cvjs.resize,
		filter: cvjs.filter,
		crop: cvjs.crop,
		rotate: cvjs.rotate,
		imageAlign,
	};

	const rows = [];
	let disagreements = 0;
	for (const angle of [0, 3, 7, 12, -9, 20]) {
		for (const [lw, lh] of [
			[W * 0.6, H * 0.5],
			[W * 0.35, H * 0.7],
		]) {
			const frame = labelFrame(W, H, angle, lw, lh);
			const opts = { maxEdge: 640, polarity: "light", outputFormat: "raw" };
			const a = await labelCrop(frame, opts, native);
			const b = await labelCrop(frame, opts, wasm);
			const row = {
				angle,
				label: `${Math.round(lw)}x${Math.round(lh)}`,
				nativeDetected: a.detected,
				wasmDetected: b.detected,
			};
			if (a.detected && b.detected) {
				const dAngle = Math.abs(a.metadata.angleDeg - b.metadata.angleDeg);
				const dCx = Math.abs(a.metadata.center.x - b.metadata.center.x);
				const dCy = Math.abs(a.metadata.center.y - b.metadata.center.y);
				const dW = Math.abs(a.metadata.width - b.metadata.width);
				const dH = Math.abs(a.metadata.height - b.metadata.height);
				row.dAngleDeg = Math.round(dAngle * 1000) / 1000;
				row.dCenterPx = Math.round(Math.max(dCx, dCy) * 10) / 10;
				row.dSizePx = Math.round(Math.max(dW, dH) * 10) / 10;
				row.agree =
					dAngle <= TOLERANCE.angleDeg &&
					Math.max(dCx, dCy) <= TOLERANCE.centerPx &&
					Math.max(dW, dH) <= TOLERANCE.sizePx;
				// the crops themselves must also come out the same shape
				row.dCropPx = Math.max(
					Math.abs(a.image.width - b.image.width),
					Math.abs(a.image.height - b.image.height),
				);
			} else {
				row.agree = a.detected === b.detected;
				row.nativeReason = a.metadata.reason;
				row.wasmReason = b.metadata.reason;
			}
			if (!row.agree) disagreements++;
			rows.push(row);
		}
	}
	console.table(rows);
	console.log(
		disagreements === 0
			? `all ${rows.length} frames agree within ${JSON.stringify(TOLERANCE)}`
			: `${disagreements} of ${rows.length} frames disagree`,
	);
	process.exitCode = disagreements === 0 ? 0 : 1;
}

main().catch((err) => {
	console.error(err.stack || err.message);
	process.exitCode = 1;
});
