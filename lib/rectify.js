/**
 * Perspective rectification of a raw frame: resample it through the
 * homography checkerboard-calibrate measured, so a camera that looks at
 * the tray slightly off-axis hands downstream nodes the same flat,
 * keystone-free view a square-on camera would.
 *
 * Pure JS so it runs on either engine and on hosts with neither - the
 * native cpp-bridge exports no warpPerspective, and opencv.js's is a
 * single WASM thread that measured no faster than this loop on a 3-channel
 * frame (114ms vs 127ms at 1500x1850). What makes it fast is the worker
 * pool: rows are independent, so `warpRows` is the kernel and
 * lib/parallel.js splits the frame across the pool exactly as the golden
 * warp is split. The serial form stays the reference the pooled one is
 * tested byte-identical against.
 *
 * Inverse mapping with bilinear interpolation: every output pixel asks the
 * inverse homography where it came from and samples the four neighbours
 * there. A near-identity warp (the normal case on a rig that is only a
 * degree or two off) moves pixels by fractions of a pixel across most of
 * the frame, and bilinear is the right cost for that - a nearest-neighbour
 * warp would leave step artifacts along every edge, and anything fancier
 * costs more than the sub-pixel gain is worth in front of an Otsu mask.
 *
 * Edges are border-replicated, not filled: a black or white fill along
 * the frame edge is a fake feature to label-crop's blob search and to
 * golden-compare's background check, while a smeared copy of the edge
 * pixels is what the same camera would have seen a little further out.
 */

"use strict";

const { allocU8 } = require("./shared.js");
const { invertHomography, isIdentityLike } = require("./homography.js");

/**
 * The row kernel: write output rows [lo, hi) of the warp into `out`.
 * `inv` is the inverse homography (rectified -> source). Deterministic
 * per pixel, so any split of the row range produces the same bytes.
 */
function warpRows(data, width, height, channels, inv, out, lo, hi) {
	const [a, b, c, d, e, f, g, h, i] = inv;
	const maxX = width - 1;
	const maxY = height - 1;
	const stride = width * channels;

	for (let Y = lo; Y < hi; Y++) {
		// the three numerators are affine in X, so advance them per pixel
		// instead of re-evaluating the full product
		let nx = b * Y + c;
		let ny = e * Y + f;
		let w = h * Y + i;
		let o = Y * stride;
		for (let X = 0; X < width; X++, nx += a, ny += d, w += g) {
			let sx = nx / w;
			let sy = ny / w;
			// border replicate: clamp into the image, then bilinear
			if (!(sx >= 0)) sx = 0;
			else if (sx > maxX) sx = maxX;
			if (!(sy >= 0)) sy = 0;
			else if (sy > maxY) sy = maxY;
			const x0 = sx | 0;
			const y0 = sy | 0;
			const x1 = x0 < maxX ? x0 + 1 : x0;
			const y1 = y0 < maxY ? y0 + 1 : y0;
			const fx = sx - x0;
			const fy = sy - y0;
			const w00 = (1 - fx) * (1 - fy);
			const w10 = fx * (1 - fy);
			const w01 = (1 - fx) * fy;
			const w11 = fx * fy;
			const p00 = (y0 * width + x0) * channels;
			const p10 = (y0 * width + x1) * channels;
			const p01 = (y1 * width + x0) * channels;
			const p11 = (y1 * width + x1) * channels;
			for (let ch = 0; ch < channels; ch++) {
				out[o++] =
					data[p00 + ch] * w00 +
					data[p10 + ch] * w10 +
					data[p01 + ch] * w01 +
					data[p11 + ch] * w11 +
					0.5;
			}
		}
	}
}

/**
 * @param {{data:Uint8Array, width:number, height:number, channels:number}} src
 * @param {number[]} H homography mapping source -> rectified coordinates
 * @returns {{data:Uint8Array, width:number, height:number, channels:number}}
 *   the rectified frame, same size and channel count; `src` itself when H
 *   is the identity.
 */
function warpPerspective(src, H) {
	const { width, height, channels } = src;
	if (isIdentityLike(H)) return src;
	const inv = invertHomography(H);
	const out = allocU8(width * height * channels);
	warpRows(src.data, width, height, channels, inv, out, 0, height);
	return { data: out, width, height, channels };
}

module.exports = { warpPerspective, warpRows };
