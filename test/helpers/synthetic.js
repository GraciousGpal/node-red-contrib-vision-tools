/**
 * Synthetic mask/image builders shared by the label-crop tests and the
 * label-crop benchmark.
 *
 * The mask is a rectangle in its own frame: center (cx, cy), size w x h,
 * rotated by angleDeg. Rasterised by point-in-rect test, so a pixel is
 * foreground when its center lies within the rotated rectangle - the same
 * convention the deskew math uses (u/v projections onto the rect's axes).
 */

/** Rasterise a rotated rectangle into a width x height Uint8Array. */
function makeRectMask(
	width,
	height,
	{ cx, cy, w, h, angleDeg = 0, value = 255 },
) {
	const mask = new Uint8Array(width * height);
	const a = (angleDeg * Math.PI) / 180;
	const ca = Math.cos(a);
	const sa = Math.sin(a);
	const hw = w / 2;
	const hh = h / 2;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const u = (x - cx) * ca + (y - cy) * sa;
			const v = -(x - cx) * sa + (y - cy) * ca;
			if (Math.abs(u) <= hw && Math.abs(v) <= hh) mask[row + x] = value;
		}
	}
	return mask;
}

/** Draw a horizontal or vertical edge line into a width*height edge map. */
function edgeLine(edges, width, x0, y0, x1, y1, value) {
	const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1;
	const height = Math.floor(edges.length / width);
	for (let i = 0; i < steps; i++) {
		const x = Math.round(x0 + (i * (x1 - x0)) / Math.max(1, steps - 1));
		const y = Math.round(y0 + (i * (y1 - y0)) / Math.max(1, steps - 1));
		if (x >= 0 && x < width && y >= 0 && y < height) edges[y * width + x] = value;
	}
}

/** Union of two masks (OR), e.g. two blobs in one frame. */
function unionMasks(a, b) {
	const out = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i];
	return out;
}

/**
 * A raw image object in the shape the native engine returns and the
 * label-crop op accepts: { data, width, height, channels, colorSpace,
 * dtype }.
 */
function rawImage(data, width, height, channels = 1, colorSpace = "GRAY") {
	const buf = Buffer.isBuffer(data)
		? data
		: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return { data: buf, width, height, channels, colorSpace, dtype: "uint8" };
}

module.exports = { makeRectMask, edgeLine, unionMasks, rawImage };
