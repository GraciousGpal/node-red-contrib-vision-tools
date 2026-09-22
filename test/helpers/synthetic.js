/**
 * Synthetic mask/image builders shared by the tests and the bench scripts.
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

/** Synthetic checkerboard: `cols` x `rows` physical squares, top-left
 * light unless `darkFirst`, each square `size` px, inside `margin` px of
 * white. The corner colour only matters on an odd-column board, where it
 * decides whether the long rows are the even-indexed ones or the odd-indexed
 * ones. */
function boardSvg(cols, rows, size, { darkFirst = false, margin = 0 } = {}) {
	let cells = "";
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const dark = (r + c) % 2 === (darkFirst ? 0 : 1);
			cells += `<rect x="${margin + c * size}" y="${margin + r * size}" width="${size}" height="${size}" fill="${dark ? "#000" : "#fff"}"/>`;
		}
	}
	const w = cols * size + 2 * margin;
	const h = rows * size + 2 * margin;
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			cells +
			`</svg>`,
	);
}

function labelOnTray(
	width,
	height,
	{
		angleDeg = 7,
		channels = 3,
		labelWidth = width * 0.6,
		labelHeight = height * 0.52,
		bars = [0.15, 0.3, 0.45, 0.6, 0.75],
	} = {},
) {
	const data = Buffer.alloc(width * height * channels, 70);
	const ca = Math.cos((angleDeg * Math.PI) / 180);
	const sa = Math.sin((angleDeg * Math.PI) / 180);
	const cx = width / 2;
	const cy = height / 2;
	const offsets = bars.map((f) => (f - 0.5) * labelHeight);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = (x - cx) * ca + (y - cy) * sa;
			const v = -(x - cx) * sa + (y - cy) * ca;
			if (Math.abs(u) > labelWidth / 2 || Math.abs(v) > labelHeight / 2) continue;
			let value = 236;
			for (const bar of offsets) {
				if (Math.abs(u) < labelWidth * 0.35 && Math.abs(v - bar) < labelHeight * 0.03) {
					value = 30;
					break;
				}
			}
			const i = (y * width + x) * channels;
			for (let c = 0; c < channels; c++) data[i + c] = value;
		}
	}
	return rawImage(data, width, height, channels, channels === 1 ? "GRAY" : "RGB");
}

module.exports = { makeRectMask, edgeLine, unionMasks, rawImage, boardSvg, labelOnTray };
