/**
 * Synthetic label artwork: pure #000 on #fff, the way a PDF renders.
 *
 * golden-compare's golden is normally the label's artwork, so a benchmark
 * fixture has to look like artwork and not like a test pattern. What
 * matters for the print channel is the *stroke width distribution*: a
 * detector that only ever sees 20px bars looks excellent right up until it
 * meets 2px body type, which is where real misprints live and where the
 * alignment error budget actually bites. So this draws several sizes of
 * glyph-like runs down to 1-3px strokes at a 1500px-wide label, a barcode
 * of varying module widths, thin table rules, one solid fill (the logo)
 * and a hairline border.
 *
 * Deliberately not done:
 *  - No SVG <text>. Font availability differs per machine, so the same
 *    seed would render differently on the next host and the set would stop
 *    being reproducible. The glyphs are rectangles, ellipses and arcs that
 *    are *shaped* like type; they are not readable and are not meant to be.
 *  - No greys. The output is thresholded to exactly 0 and 255 after
 *    rasterising, so the antialiasing the SVG renderer adds does not leak
 *    a third level into a fixture whose whole premise is two.
 *  - No colour, no barcode that decodes, no realistic text content.
 */

"use strict";

const sharp = require("sharp");
const { makePrng } = require("./prng.js");

// Everything below is authored against a 1500px-wide label and scaled, so
// "a 2px rule" means the same physical hairline at 1500 and at 3000.
const DESIGN_WIDTH = 1500;

const r2 = (n) => Math.round(n * 100) / 100;

function rect(x, y, w, h) {
	if (w <= 0 || h <= 0) return "";
	return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}"/>`;
}

function strokePath(d, sw) {
	return `<path d="${d}" fill="none" stroke="#000" stroke-width="${r2(sw)}"/>`;
}

function line(x1, y1, x2, y2, sw) {
	return strokePath(`M${r2(x1)} ${r2(y1)}L${r2(x2)} ${r2(y2)}`, sw);
}

/**
 * One glyph-shaped mark in the cap box (x, y, w, h), drawn from a handful
 * of skeletons that between them cover the stroke geometries a print
 * defect has to be found against: solid stems, thin bars, closed rings,
 * open arcs and diagonals.
 */
function glyph(prng, x, y, w, h, sw) {
	switch (prng.int(0, 9)) {
		case 0: {
			// stem plus two or three crossbars (E, F)
			let s = rect(x, y, sw, h) + rect(x, y, w, sw) + rect(x, y + h - sw, w, sw);
			if (prng.bool(0.7)) s += rect(x, y + h / 2 - sw / 2, w * 0.75, sw);
			return s;
		}
		case 1:
			// closed ring (O, Q) - the thin-stroke curve case
			return `<ellipse cx="${r2(x + w / 2)}" cy="${r2(y + h / 2)}" rx="${r2(w / 2 - sw / 2)}" ry="${r2(h / 2 - sw / 2)}" fill="none" stroke="#000" stroke-width="${r2(sw)}"/>`;
		case 2: {
			// stem with a bowl on the right (P, R)
			const bowl = h * prng.uniform(0.45, 0.62);
			let s =
				rect(x, y, sw, h) +
				strokePath(
					`M${r2(x + sw / 2)} ${r2(y + sw / 2)}H${r2(x + w * 0.55)}` +
						`A${r2(w * 0.4)} ${r2(bowl / 2)} 0 0 1 ${r2(x + w * 0.55)} ${r2(y + bowl)}` +
						`H${r2(x + sw / 2)}`,
					sw,
				);
			if (prng.bool(0.5)) s += line(x + w * 0.35, y + bowl, x + w, y + h, sw);
			return s;
		}
		case 3:
			// two diagonals with an optional crossbar (A, V)
			return (
				line(x, y + h, x + w / 2, y, sw) +
				line(x + w / 2, y, x + w, y + h, sw) +
				(prng.bool(0.5) ? rect(x + w * 0.2, y + h * 0.65, w * 0.6, sw) : "")
			);
		case 4:
			// stem plus diagonal (N, K)
			return (
				rect(x, y, sw, h) +
				line(x + sw, y, x + w, y + h, sw) +
				(prng.bool(0.5) ? rect(x + w - sw, y, sw, h) : "")
			);
		case 5:
			// top bar over a centred stem (T)
			return rect(x, y, w, sw) + rect(x + w / 2 - sw / 2, y, sw, h);
		case 6:
			// box outline (D, square O) - four hairlines meeting at corners
			return `<rect x="${r2(x + sw / 2)}" y="${r2(y + sw / 2)}" width="${r2(w - sw)}" height="${r2(h - sw)}" fill="none" stroke="#000" stroke-width="${r2(sw)}"/>`;
		case 7:
			// narrow stem with a tittle (i, j) - the smallest connected mark,
			// and the first thing a dropout test should be able to remove
			return rect(x, y + h * 0.3, sw, h * 0.7) + rect(x, y, sw * 1.6, sw * 1.6);
		case 8:
			// open arc (C, G)
			return strokePath(
				`M${r2(x + w)} ${r2(y + h * 0.25)}` +
					`A${r2(w / 2)} ${r2(h / 2)} 0 1 0 ${r2(x + w)} ${r2(y + h * 0.75)}`,
				sw,
			);
		default:
			// stem plus foot (L) or a solid slab (the heavy end of the range)
			return prng.bool(0.6)
				? rect(x, y, sw, h) + rect(x, y + h - sw, w, sw)
				: rect(x, y + h * 0.15, w, h * 0.7);
	}
}

/**
 * A row of words: glyph runs of 2-9 marks separated by word gaps, filling
 * x0..xMax. Glyph widths vary within the row so the row has the ragged
 * look of type rather than the comb of a test pattern.
 */
function textRun(prng, x0, y, capHeight, sw, xMax) {
	let x = x0;
	let out = "";
	const tracking = capHeight * 0.28;
	while (x < xMax) {
		const word = prng.int(2, 9);
		for (let i = 0; i < word && x < xMax; i++) {
			const w = capHeight * prng.uniform(0.45, 0.85);
			if (x + w > xMax) break;
			out += glyph(prng, x, y, w, capHeight, sw);
			x += w + tracking;
		}
		x += capHeight * prng.uniform(0.35, 0.75);
	}
	return out;
}

function barcode(prng, x0, y, w, h, k) {
	let out = "";
	let x = x0;
	// module widths 2-8 design px: a real 1D symbology's narrow bar is the
	// finest repeated feature on a label and the one most sensitive to a
	// streak or a bleed
	while (x < x0 + w - 8 * k) {
		const bar = prng.int(2, 8) * k;
		out += rect(x, y, bar, h);
		x += bar + prng.int(2, 8) * k;
	}
	return out;
}

function logo(prng, x, y, size) {
	// a solid mark plus a knocked-out ring: the large-area ink the
	// background channel's false alarms tend to cluster around
	const cx = x + size / 2;
	const cy = y + size / 2;
	const pts = [];
	const sides = prng.int(5, 7);
	for (let i = 0; i < sides; i++) {
		const a = (i / sides) * Math.PI * 2 + prng.uniform(-0.15, 0.15);
		const rr = (size / 2) * prng.uniform(0.82, 1);
		pts.push(`${r2(cx + rr * Math.cos(a))},${r2(cy + rr * Math.sin(a))}`);
	}
	return (
		`<polygon points="${pts.join(" ")}"/>` +
		`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(size * 0.16)}" fill="#fff"/>`
	);
}

function labelSvg(width, height, seed) {
	const prng = makePrng(seed);
	const k = width / DESIGN_WIDTH;
	const W = width;
	const H = height;
	const hair = 1.5 * k;
	const body = new Array();

	// hairline border, inset
	const inset = 0.018 * W;
	body.push(
		`<rect x="${r2(inset)}" y="${r2(inset)}" width="${r2(W - 2 * inset)}" height="${r2(H - 2 * inset)}" fill="none" stroke="#000" stroke-width="${r2(hair)}"/>`,
	);

	const left = 0.05 * W;
	const right = 0.95 * W;

	body.push(logo(prng, left, 0.035 * H, 0.13 * W));
	// title block beside the logo: two weights, so the set contains type
	// that is trivially findable and type that is not
	body.push(textRun(prng, 0.22 * W, 0.045 * H, 0.03 * H, 4.5 * k, right));
	body.push(textRun(prng, 0.22 * W, 0.095 * H, 0.018 * H, 3 * k, right));

	// solid rule under the header
	body.push(rect(left, 0.14 * H, right - left, 0.006 * H));

	// body copy: the 2-3px stroke case
	for (let i = 0; i < 10; i++) {
		const y = 0.165 * H + i * 0.023 * H;
		const end = right - (prng.bool(0.3) ? prng.uniform(0.05, 0.3) * W : 0);
		body.push(textRun(prng, left, y, 0.013 * H, 2 * k, end));
	}

	// boxed table with thin rules and small type in the cells
	const tX = left;
	const tY = 0.42 * H;
	const tW = right - left;
	const tH = 0.2 * H;
	const cols = 4;
	const rows = 5;
	body.push(
		`<rect x="${r2(tX)}" y="${r2(tY)}" width="${r2(tW)}" height="${r2(tH)}" fill="none" stroke="#000" stroke-width="${r2(hair)}"/>`,
	);
	for (let c = 1; c < cols; c++) {
		body.push(rect(tX + (c * tW) / cols, tY, 1.2 * k, tH));
	}
	for (let r = 1; r < rows; r++) {
		body.push(rect(tX, tY + (r * tH) / rows, tW, 1.2 * k));
	}
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const cx = tX + (c * tW) / cols + 0.008 * W;
			const cy = tY + (r * tH) / rows + tH / rows / 2 - 0.005 * H;
			body.push(
				textRun(
					prng,
					cx,
					cy,
					0.011 * H,
					(r === 0 ? 2.5 : 1.6) * k,
					tX + ((c + 1) * tW) / cols - 0.008 * W,
				),
			);
		}
	}

	// barcode plus its human-readable line
	body.push(barcode(prng, 0.08 * W, 0.66 * H, 0.62 * W, 0.1 * H, k));
	body.push(textRun(prng, 0.08 * W, 0.775 * H, 0.014 * H, 2.5 * k, 0.6 * W));
	// a second solid mark on the right, away from the barcode
	body.push(rect(0.76 * W, 0.66 * H, 0.16 * W, 0.045 * H));

	// footer: the finest type on the label
	for (let i = 0; i < 5; i++) {
		body.push(
			textRun(prng, left, 0.82 * H + i * 0.019 * H, 0.011 * H, 1.6 * k, right),
		);
	}

	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			`<g fill="#000">${body.join("")}</g>` +
			`</svg>`,
	);
}

/**
 * Render the artwork to a PNG Buffer. Thresholded, so the result is
 * exactly two levels whatever the SVG renderer's antialiasing did.
 */
async function syntheticLabel(width, height, seed = 1) {
	return sharp(labelSvg(width, height, seed))
		.grayscale()
		.threshold(128)
		.png({ compressionLevel: 9 })
		.toBuffer();
}

/** The same artwork as a raster the defect library can operate on. */
async function syntheticLabelRaster(width, height, seed = 1) {
	const { data, info } = await sharp(labelSvg(width, height, seed))
		.grayscale()
		.threshold(128)
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
	};
}

module.exports = { syntheticLabel, syntheticLabelRaster, labelSvg };
