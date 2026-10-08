/**
 * Barcode regions found on the golden, carried into the frame
 * barcode-locate is given.
 *
 * golden-compare can derive the barcodes' boxes from the artwork itself
 * (a profile's `barcodes` section, golden native px) and has already
 * trained where the artwork sits in the frame it inspects (the profile's
 * `transform` section). Chained, the two say where each barcode lies in
 * any image of the same view, so nobody has to measure regions by eye
 * and re-measure them when the camera moves. Pure maths on numbers; the
 * node reads the files.
 *
 * The chain, per corner of each box (measured on the demo rig, 2026-10-08:
 * it landed on both Code128s in 149/149 photos):
 *
 *  1. golden native -> golden working: x goldenWidth / golden native
 *     width (the compare works on a resized golden). The pad is added
 *     here, on every side, so it scales with the artwork like the box does.
 *  2. golden working -> frame working, through the compare's own model
 *     (lib/align.js): tx = ox + cos*mx*gx - sin*my*gy, ty = oy +
 *     sin*mx*gx + cos*my*gy. The placement is the last training frame's;
 *     without one, the pinned search's starting point (the golden
 *     centred), which is off by however far the part sat from centre.
 *  3. frame working -> the frame the compare received: x frameNativeWidth
 *     / frameWidth (the working size rounds each axis on its own, so
 *     taking the width ratio for both is < 1 px out).
 *  4. -> the payload barcode-locate holds: x payload width /
 *     frameNativeWidth. On the rig that is the un-halved camera frame, and
 *     it matters: on the halved rectified frame the compare sees (~2.3
 *     px/module) only 23/149 photos read both codes and one read a
 *     confidently wrong string; on the native 3000x3700 frame 149/149
 *     read exactly, 152 ms median against 385 ms for the whole frame.
 *  5. With a calibration (the payload has NOT been through
 *     perspective-rectify, the compare's frame had), the point is still in
 *     rectified coordinates: take it back through the inverse of the
 *     rectification homography, rescaled to the payload's size. Scale
 *     first, then un-rectify - rescaleHomography is exactly the
 *     conjugation by that scale, so the order of the flow's resize and
 *     rectify does not matter.
 *  6. Axis-aligned box of the four corners, rounded once, clamped to the
 *     payload.
 *
 * Problems that leave the mapping usable come back as `warnings` for the
 * node to report; a transform without the frame fields cannot be mapped
 * at all and throws.
 */

"use strict";

const { applyHomography, invertHomography, rescaleHomography } = require("./homography.js");

const DEG = Math.PI / 180;

// Fields the transform needs for the chain. Records written before
// golden-compare stored the frame's size have none of the frame_ ones.
const SCALE_FIELDS = ["scaleX", "scaleY", "goldenWidth", "goldenHeight"];
const FRAME_FIELDS = ["frameWidth", "frameHeight", "frameNativeWidth", "frameNativeHeight"];

function positive(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function requireTransform(transform) {
	if (!transform || typeof transform !== "object") {
		throw new Error("goldenRegions: the profile has no transform section - train the transform first");
	}
	const bad = SCALE_FIELDS.filter((k) => !positive(transform[k]));
	if (bad.length) {
		throw new Error(`goldenRegions: the transform's ${bad.join(", ")} must be positive numbers - retrain the transform`);
	}
	const missing = FRAME_FIELDS.filter((k) => !positive(transform[k]));
	if (missing.length) {
		throw new Error(
			`goldenRegions: the transform has no ${missing.join(", ")} - it was trained before ` +
				"golden-compare recorded the frame's size; retrain the transform with this version",
		);
	}
}

/**
 * Where the compare starts its pinned search and where the position
 * check's zero is (lib/align.js, lib/compare.js): the golden, at the
 * trained scale, centred in the frame, unrotated.
 */
function nominalPlacement(transform) {
	return {
		ox: (transform.frameWidth - transform.scaleX * transform.goldenWidth) / 2,
		oy: (transform.frameHeight - transform.scaleY * transform.goldenHeight) / 2,
		angleDeg: 0,
	};
}

/**
 * The compare's model as an affine from golden working px to frame
 * working px: tx = a*gx + b*gy + c ; ty = d*gx + e*gy + f.
 */
function goldenToFrameAffine(transform, placement) {
	const t = (Number(placement.angleDeg) || 0) * DEG;
	const cos = Math.cos(t);
	const sin = Math.sin(t);
	return {
		a: cos * transform.scaleX,
		b: -sin * transform.scaleY,
		c: placement.ox,
		d: sin * transform.scaleX,
		e: cos * transform.scaleY,
		f: placement.oy,
	};
}

function validPlacement(p) {
	return p && typeof p === "object" && Number.isFinite(p.ox) && Number.isFinite(p.oy);
}

/**
 * @param {{ transform: object, barcodes: { regions: object[] }, goldenNative: { width: number, height: number } }} profile
 *   goldenNative: the golden the barcode boxes were measured on (the
 *   barcodes section's nativeWidth/Height; the node falls back to the
 *   profile's golden record)
 * @param {{ width: number, height: number }} frame the payload to decode
 * @param {{ homography: number[], nativeWidth: number, nativeHeight: number } | null} calibration
 *   only when the payload has NOT been rectified
 * @param {{ pad?: number, padMinPx?: number }} [options] pad: fraction of
 *   the box's longer edge, every side; padMinPx: the least pad, in golden
 *   working px
 * @returns {{ regions: Array<{ label, format, text, x, y, width, height }>, warnings: string[] }}
 */
function mapProfileRegions({ transform, barcodes, goldenNative }, frame, calibration, { pad = 0, padMinPx = 0 } = {}) {
	requireTransform(transform);
	if (!goldenNative || !positive(goldenNative.width) || !positive(goldenNative.height)) {
		throw new Error("goldenRegions: the golden's native size is unknown - re-derive the barcodes");
	}
	if (!frame || !positive(frame.width) || !positive(frame.height)) {
		throw new Error("goldenRegions: the payload's size is unknown");
	}
	const warnings = [];
	const boxes = barcodes && Array.isArray(barcodes.regions) ? barcodes.regions : [];

	let placement = transform.placement;
	if (!validPlacement(placement)) {
		placement = nominalPlacement(transform);
		warnings.push(
			"the transform has no recorded placement, so regions assume the part sat centred in the frame - " +
				"off by up to the margin around it; retrain the transform with this version",
		);
	}

	// A crop, or another camera, changes the aspect; scaling by the width
	// alone then puts regions off along the height.
	const aspect = frame.width / frame.height / (transform.frameNativeWidth / transform.frameNativeHeight);
	if (Math.abs(aspect - 1) > 0.01) {
		warnings.push(
			`the payload ${frame.width}x${frame.height} is not the aspect of the frame the transform was ` +
				`trained on (${transform.frameNativeWidth}x${transform.frameNativeHeight}) - a crop or another ` +
				"camera; regions will be off along one axis",
		);
	}

	let inverse = null;
	if (calibration) {
		try {
			inverse = invertHomography(
				rescaleHomography(calibration.homography, { width: calibration.nativeWidth, height: calibration.nativeHeight }, frame),
			);
		} catch (err) {
			// with no way back to the unrectified frame, any region would be
			// somewhere else - none at all lets the full-image fallback run
			warnings.push(`cannot undo the rectification: ${err.message}`);
			return { regions: [], warnings };
		}
	}

	const gs = transform.goldenWidth / goldenNative.width;
	const A = goldenToFrameAffine(transform, placement);
	const toNative = transform.frameNativeWidth / transform.frameWidth;
	const toPayload = frame.width / transform.frameNativeWidth;

	const regions = [];
	for (const box of boxes) {
		if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !positive(box.width) || !positive(box.height)) continue;
		const w = box.width * gs;
		const h = box.height * gs;
		const p = Math.max(pad * Math.max(w, h), padMinPx);
		const x0 = box.x * gs - p;
		const y0 = box.y * gs - p;
		const x1 = x0 + w + 2 * p;
		const y1 = y0 + h + 2 * p;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let finite = true;
		for (const [gx, gy] of [
			[x0, y0],
			[x1, y0],
			[x0, y1],
			[x1, y1],
		]) {
			let x = (A.a * gx + A.b * gy + A.c) * toNative * toPayload;
			let y = (A.d * gx + A.e * gy + A.f) * toNative * toPayload;
			if (inverse) ({ x, y } = applyHomography(inverse, x, y));
			// a corner at or past the homography's horizon has no place in the
			// frame, and min/max would silently skip a NaN
			if (!Number.isFinite(x) || !Number.isFinite(y)) finite = false;
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
		if (!finite) continue;
		// round the edges once, then clamp: rounding a clamped size would
		// round twice
		const left = Math.max(0, Math.round(minX));
		const top = Math.max(0, Math.round(minY));
		const right = Math.min(frame.width, Math.round(maxX));
		const bottom = Math.min(frame.height, Math.round(maxY));
		// written so a NaN edge fails it too: NaN compares false both ways, and a
		// NaN box reaching sharp's extract fails the whole message
		if (!(right > left && bottom > top)) continue;
		regions.push({
			label: box.label != null ? String(box.label) : "",
			format: box.format != null ? box.format : null,
			text: box.text != null ? box.text : null,
			x: left,
			y: top,
			width: right - left,
			height: bottom - top,
		});
	}
	return { regions, warnings };
}

module.exports = { mapProfileRegions, nominalPlacement, goldenToFrameAffine };
