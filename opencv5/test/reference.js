/**
 * The same ops on the stock opencv.js WASM build (@techstark/opencv-js, a
 * dev dependency): what the tests hold the addon to. Built from the WASM
 * library's own functions with the same arguments, so a test that matches
 * it byte for byte checks the addon's argument handling as much as OpenCV.
 */

"use strict";

let cvPromise;
function cv() {
	if (!cvPromise) {
		cvPromise = (async () => {
			const mod = require("@techstark/opencv-js");
			const api = typeof mod.then === "function" ? await mod : mod;
			if (typeof api.Mat !== "function") {
				await new Promise((resolve) => {
					api.onRuntimeInitialized = resolve;
				});
			}
			return api;
		})();
	}
	return cvPromise;
}

function available() {
	try {
		require.resolve("@techstark/opencv-js");
		return true;
	} catch {
		return false;
	}
}

const TYPE = (c, channels) => ({ 1: c.CV_8UC1, 3: c.CV_8UC3, 4: c.CV_8UC4 })[channels];

/** Run `fn(c, src, dst, keep)` on a Mat of `image`; return dst as a Buffer. */
async function run(image, fn) {
	const c = await cv();
	const mats = [];
	const keep = (m) => (mats.push(m), m);
	try {
		const src = keep(new c.Mat(image.height, image.width, TYPE(c, image.channels)));
		src.data.set(image.data.subarray(0, image.width * image.height * image.channels));
		const dst = keep(new c.Mat());
		fn(c, src, dst, keep);
		let out = dst;
		if (!dst.isContinuous()) {
			out = keep(new c.Mat(dst.rows, dst.cols, dst.type()));
			dst.copyTo(out);
		}
		return {
			data: Buffer.from(out.data.subarray(0, out.rows * out.cols * out.channels())),
			width: out.cols,
			height: out.rows,
			channels: out.channels(),
		};
	} finally {
		for (const m of mats) m.delete();
	}
}

const toGray = (image) => run(image, (c, src, dst) => c.cvtColor(src, dst, image.channels === 4 ? c.COLOR_RGBA2GRAY : c.COLOR_RGB2GRAY));
const resize = (image, w, h) => run(image, (c, src, dst) => c.resize(src, dst, new c.Size(w, h), 0, 0, c.INTER_LINEAR));
const blur = (image, k) => run(image, (c, src, dst) => c.GaussianBlur(src, dst, new c.Size(k, k), 0, 0, c.BORDER_DEFAULT));
const otsu = (image) => run(image, (c, src, dst) => c.threshold(src, dst, 0, 255, c.THRESH_BINARY | c.THRESH_OTSU));
const edge = (image, k, weight) =>
	run(image, (c, src, dst, keep) => {
		const gx = keep(new c.Mat());
		const gy = keep(new c.Mat());
		const ax = keep(new c.Mat());
		const ay = keep(new c.Mat());
		c.Sobel(src, gx, c.CV_16S, 1, 0, k);
		c.Sobel(src, gy, c.CV_16S, 0, 1, k);
		c.convertScaleAbs(gx, ax);
		c.convertScaleAbs(gy, ay);
		c.addWeighted(ax, 0.5 * weight, ay, 0.5 * weight, 0, dst);
	});
const rotate = (image, angle, w, h, pad) =>
	run(image, (c, src, dst, keep) => {
		const m = keep(c.getRotationMatrix2D(new c.Point(image.width / 2, image.height / 2), angle, 1));
		m.data64F[2] += w / 2 - image.width / 2;
		m.data64F[5] += h / 2 - image.height / 2;
		c.warpAffine(src, dst, m, new c.Size(w, h), c.INTER_LINEAR, c.BORDER_CONSTANT, new c.Scalar(...pad));
	});

module.exports = { available, toGray, resize, blur, otsu, edge, rotate };
