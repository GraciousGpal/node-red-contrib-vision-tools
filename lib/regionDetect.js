/**
 * Finds the regions of interest on a printed label: text blocks, barcodes
 * and graphics. One-off (run when a golden image is chosen), not per frame.
 * Measured with orientation "auto": 0.3 s on the 1500x1000 synthetic test
 * label and 0.4 s on it stretched to 1500x1850; about 2.5 s on a real
 * 1500x1850 label, mostly the barcode decode and the orientation votes
 * (two model reads per text block).
 *
 * detectRegions(raw, opts) -> { regions, timings, charHeight }
 *   raw: { data, width, height, channels }: width and height positive
 *     integers, channels 1 to 4, data a Uint8Array or Buffer of exactly
 *     width x height x channels bytes; anything else throws, naming it.
 *   opts (an object or undefined): orientation "auto" | 0 | 90 | 180 | 270,
 *     a number or numeric string (default "auto"); minTextHeight px (8),
 *     pad px (4) and minScore 0..1 (0.7), each Number()-ed, finite, >= 0;
 *     graphics (true), barcodes (true). With orientation "auto", text
 *     blocks whose score is under minScore are dropped.
 *   regions: [{ name, label, kind, x, y, width, height, rotate, score }],
 *     integers in frame px, sorted by y then x, numbered per kind
 *     ("text1", "barcode1", "graphic1"), label === name; boxes of one kind
 *     do not overlap. rotate (text only, else 0) turns the box clockwise
 *     upright, as lib/ocr.js reads it. score 0..1: text, the orientation
 *     vote, the mean OCR confidence over the characters of the block's
 *     longest line at its rotate, and 1 when the orientation is forced
 *     (nothing is read then and the model is not loaded); barcode, 1 when
 *     decoded, else the bars' regularity (at most 0.95); graphic, its ink
 *     over its ink's bounding box.
 *   timings: { thresholdMs, componentsMs, barcodeMs, textMs, orientMs,
 *     graphicsMs, totalMs }, ms with one decimal; totalMs covers the parts.
 *   charHeight: m below, px.
 *
 * Method:
 *  1. Grey. Dark ink is Sauvola foreground, or darker than both the Otsu
 *     level and mid-grey (Sauvola alone leaves the inside of a solid fill
 *     empty). Dust is a component shorter than 0.6 x minTextHeight: it is
 *     never a character. m0 is the median height of the dark components
 *     of area >= 9 and height >= 4 that are not dust and have a neighbour
 *     of 0.5x-2x their height within 1.5x their height (characters sit in
 *     rows, dust is alone); without any such, of all of them; 4 when there
 *     are none. Light ink (reversed text) is
 *     Sauvola foreground of the inverted grey where the grey's mean over a
 *     window of radius max(12, 1.2 m0) is dark, so the paper around
 *     ordinary dark text is not light ink. Components are labelled per
 *     mask and keep their polarity.
 *  2. Barcodes: zxing over the whole frame; a decoded symbol box is padded
 *     by pad, and by at least 12 px across a linear code's bars. Then
 *     groups of at least 10 thin parallel dark components (long side >= 4x
 *     the short side, side by side within 4 bar widths, overlapping >= 50%
 *     along their length, so >= 20 alternations), of median length >= 3 m0
 *     (a row of I's is short strokes), with lengths of coefficient of
 *     variation <= 0.15 are barcodes too, and so are groups of at least 15
 *     with variation <= 0.35 (guard bars, bars cut short by digits) whose
 *     median gap is under twice the median bar width. A group meeting a
 *     decoded box gives that box its extent (the decoded symbol padded by
 *     pad, joined with the group padded by pad). Components centred in a
 *     barcode go.
 *  3. m is m0's median again over what is left; a component is char-sized
 *     when it is not dust and neither side passes 6 m.
 *  4. Text lines. Two char-sized components of one polarity link along X
 *     when their Y ranges overlap by half the smaller one and their gap
 *     along X is at most 1.2x the taller (the reach of a smear of 0.6x
 *     char height from both sides, per pair so large and small text both
 *     join their words); along Y the same, transposed. Each component
 *     takes the axis whose group is the more elongated; linking again on
 *     the chosen axis only gives lines. A group is a line when its length
 *     is >= 3x its thickness, or when it has two or more components one of
 *     which fills under 0.7 of its box (a short field such as "OK"; two
 *     solid specks are not one). Lines of one axis and polarity stacked
 *     across it with a gap < 1.5x the thicker line and overlapping >= 50%
 *     of the shorter along it form a block. A block whose median line
 *     thickness is under minTextHeight is dropped.
 *  5. Orientation: a number in opts is used as it is. Otherwise the
 *     block's longest line is read both ways (0/180 for lines along X,
 *     90/270 along Y) and the higher mean confidence wins; when the
 *     confident votes (margin >= 0.3) of one axis favour one way at least
 *     2:1, blocks of that axis below that margin follow them.
 *  6. Graphics: dark components in no kept or too-thin text block (a
 *     block dropped for its score gives its components back) and not
 *     centred in a barcode. One enclosing a text block stays when solid
 *     (its box holds m^2 px of dark ink m/2 from any paper: a panel holding
 *     reversed text, even half of a box) and goes when not (a frame around
 *     text); any other goes when centred in a text block. Light ink is never a graphic. Touching boxes merge; each is padded; a strip along the
 *     frame edge (touching it, over 80% of the frame one way, under 5% the
 *     other) goes. Last, on the padded boxes and until a pass merges
 *     nothing, boxes that touch, overlap or lie side by side (within 2x of
 *     each other's size across, overlapping by half the smaller across,
 *     apart by under half the smaller along)
 *     merge (mergeGraphicBoxes); then a graphic whose ink box is under 2 m
 *     on either side or 6 m^2 in area goes (graphicBigEnough).
 *  7. Every box is padded by pad, clamped to the frame and rounded;
 *     overlapping boxes of one kind merge.
 *
 * Known limits: two blocks closer than 1.2x their char height merge into
 * one; a 2D code that does not decode comes out as a graphic; a single
 * short character (one component under 3:1) is no text and, under the
 * graphic size floor, vanishes; random dense specks can read as text at
 * 0.6-0.9 confidence; large graphics within 1.2x the char height of text
 * can join its text block (squares flanking a word); an undecoded 2D code
 * next to text may be classed as text; reversed text under about 24 px on
 * a thin band may be missed. Raise minTextHeight or minScore, or edit the
 * regions in the editor.
 */

"use strict";

const sharp = require("sharp");
const { thresholdForeground } = require("./threshold.js");
const { connectedComponents } = require("./components.js");
const { dilate } = require("./dilate.js");
const { locateBarcodes } = require("./locate.js");
const { recognise } = require("./ocr.js");

const SAUVOLA_RADIUS = 15;
const SAUVOLA_K = 0.2;
const ROTATIONS = [0, 90, 180, 270];

const ms = (from) => Math.round((performance.now() - from) * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;

async function toGrey(raw) {
	const { data } = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
		.greyscale()
		.extractChannel(0)
		.raw()
		.toBuffer({ resolveWithObject: true });
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// mean of grey over a (2r+1)^2 window, clipped at the frame, < level
function darkSurround(grey, w, h, r, level) {
	const stride = w + 1;
	const sum = new Float64Array(stride * (h + 1));
	for (let y = 0; y < h; y++) {
		let row = 0;
		for (let x = 0; x < w; x++) {
			row += grey[y * w + x];
			sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + row;
		}
	}
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const y0 = Math.max(0, y - r);
		const y1 = Math.min(h, y + r + 1);
		for (let x = 0; x < w; x++) {
			const x0 = Math.max(0, x - r);
			const x1 = Math.min(w, x + r + 1);
			const s = sum[y1 * stride + x1] - sum[y0 * stride + x1] - sum[y1 * stride + x0] + sum[y0 * stride + x0];
			out[y * w + x] = s < level * (x1 - x0) * (y1 - y0) ? 1 : 0;
		}
	}
	return out;
}

const SAUVOLA = { thresholdMode: "sauvola", sauvolaRadius: SAUVOLA_RADIUS, sauvolaK: SAUVOLA_K };

function darkMask(grey, w, h) {
	const dark = thresholdForeground(grey, w, h, SAUVOLA).fg;
	const { level } = thresholdForeground(grey, w, h, { thresholdMode: "otsu" });
	const solid = Math.min(level, 128);
	for (let i = 0; i < dark.length; i++) if (grey[i] < solid) dark[i] = 1;
	return dark;
}

// light ink where the grey's mean over a (2 gate + 1)^2 window is dark
function lightMask(grey, w, h, gate) {
	const inv = new Uint8Array(grey.length);
	for (let i = 0; i < inv.length; i++) inv[i] = 255 - grey[i];
	const light = thresholdForeground(inv, w, h, SAUVOLA).fg;
	const dark = darkSurround(grey, w, h, gate, 128);
	for (let i = 0; i < light.length; i++) light[i] &= dark[i];
	return light;
}

// boxes are { x0, y0, x1, y1 }, ends exclusive
const boxW = (b) => b.x1 - b.x0;
const boxH = (b) => b.y1 - b.y0;
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const touch = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const contains = (outer, inner) => outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;
const centredIn = (c, b) => c.cx >= b.x0 && c.cx < b.x1 && c.cy >= b.y0 && c.cy < b.y1;
const maxOf = (v) => v.reduce((a, b) => (b > a ? b : a), 0);
const median = (v) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : 0;
};

const notDust = (c, minTextHeight) => boxH(c) >= 0.6 * minTextHeight;

// the components with a neighbour of 0.5x to 2x their height within 1.5x
// their height (the larger of the gaps across x and y between the boxes):
// characters sit in rows, dust is alone
function withNeighbours(comps) {
	const s = [...comps].sort((a, b) => a.x0 - b.x0);
	const ok = new Set();
	for (let i = 0; i < s.length; i++) {
		const a = s[i];
		const ha = boxH(a);
		for (let j = i + 1; j < s.length; j++) {
			const b = s[j];
			// b qualifies within 1.5 hb <= 3 ha of a
			if (b.x0 > a.x1 + 3 * ha) break;
			const hb = boxH(b);
			if (hb < 0.5 * ha || hb > 2 * ha) continue;
			const gap = Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1, 0);
			if (gap <= 1.5 * ha) ok.add(a);
			if (gap <= 1.5 * hb) ok.add(b);
		}
	}
	return comps.filter((c) => ok.has(c));
}

// m: the median height of components of area >= 9, height >= 4, not dust
// (shorter than 0.6 x minTextHeight) and with a neighbour (withNeighbours);
// without such neighbours all of them; 4 when there are none
function charHeight(comps, minTextHeight) {
	const fit = comps.filter((c) => c.area >= 9 && boxH(c) >= 4 && notDust(c, minTextHeight));
	return median(withNeighbours(fit).map(boxH)) || median(fit.map(boxH)) || 4;
}

// union-find groups of items under link(a, b); items sorted by their
// start along `axis`, a pair is tested only while b starts within
// reach px of a's end
function groups(items, axis, reach, link) {
	const lo = axis === "x" ? "x0" : "y0";
	const hi = axis === "x" ? "x1" : "y1";
	const order = items.map((_, i) => i).sort((i, j) => items[i][lo] - items[j][lo]);
	const parent = items.map((_, i) => i);
	const find = (i) => {
		while (parent[i] !== i) i = parent[i] = parent[parent[i]];
		return i;
	};
	for (let p = 0; p < order.length; p++) {
		const a = items[order[p]];
		const limit = a[hi] + reach;
		for (let q = p + 1; q < order.length; q++) {
			const b = items[order[q]];
			if (b[lo] > limit) break;
			if (link(a, b)) parent[find(order[p])] = find(order[q]);
		}
	}
	const out = new Map();
	items.forEach((_, i) => {
		const r = find(i);
		if (!out.has(r)) out.set(r, []);
		out.get(r).push(items[i]);
	});
	return [...out.values()];
}

const boxOf = (members) => members.reduce((b, c) => union(b, c), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

// along: "x" or "y"; the extents along and across that axis
const along = (b, axis) => (axis === "x" ? boxW(b) : boxH(b));
const across = (b, axis) => (axis === "x" ? boxH(b) : boxW(b));
const range = (b, axis) => (axis === "x" ? [b.x0, b.x1] : [b.y0, b.y1]);
const rangeOverlap = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
const perp = (axis) => (axis === "x" ? "y" : "x");

// char-sized components that read as one line along axis
function linkChars(chars, axis) {
	const reach = 1.2 * maxOf(chars.map((c) => across(c, axis)));
	return groups(chars, axis, reach, (a, b) => {
		if (a.polarity !== b.polarity) return false;
		const o = rangeOverlap(range(a, perp(axis)), range(b, perp(axis)));
		if (o < 0.5 * Math.min(across(a, axis), across(b, axis))) return false;
		const gap = -rangeOverlap(range(a, axis), range(b, axis));
		return gap <= 1.2 * Math.max(across(a, axis), across(b, axis));
	});
}

// a letter's ink fills under 0.7 of its box; a speck, a dot or a solid
// square fills more. A short field (under 3:1) needs one such letter, so
// two touching specks are not text
const open = (c) => c.area < 0.7 * boxW(c) * boxH(c);

function textLines(chars) {
	const elong = new Map();
	for (const axis of ["x", "y"]) {
		for (const g of linkChars(chars, axis)) {
			const b = boxOf(g);
			const e = along(b, axis) / Math.max(1, across(b, axis));
			for (const c of g) elong.set(c, { ...(elong.get(c) || {}), [axis]: e });
		}
	}
	const lines = [];
	for (const axis of ["x", "y"]) {
		const mine = chars.filter((c) => (axis === "y" ? elong.get(c).y > elong.get(c).x : elong.get(c).y <= elong.get(c).x));
		for (const g of linkChars(mine, axis)) {
			const box = boxOf(g);
			lines.push({ ...box, axis, polarity: g[0].polarity, members: g, line: along(box, axis) >= 3 * across(box, axis) || (g.length >= 2 && g.some(open)) });
		}
	}
	return lines;
}

// { blocks, thin }: thin, the lines of blocks under minTextHeight
function textBlocks(lines, minTextHeight) {
	const blocks = [];
	const thin = [];
	for (const axis of ["x", "y"]) {
		const mine = lines.filter((l) => l.line && l.axis === axis);
		const p = perp(axis);
		const reach = 1.5 * maxOf(mine.map((l) => across(l, axis)));
		const found = groups(mine, p, reach, (a, b) => {
			if (a.polarity !== b.polarity) return false;
			const gap = -rangeOverlap(range(a, p), range(b, p));
			if (gap >= 1.5 * Math.max(across(a, axis), across(b, axis))) return false;
			return rangeOverlap(range(a, axis), range(b, axis)) >= 0.5 * Math.min(along(a, axis), along(b, axis));
		});
		for (const g of found) {
			const thickness = median(g.map((l) => across(l, axis)));
			if (thickness < minTextHeight) {
				thin.push(...g);
				continue;
			}
			const longest = g.reduce((a, b) => (along(b, axis) > along(a, axis) ? b : a));
			blocks.push({ ...boxOf(g), axis, lines: g, longest });
		}
	}
	return { blocks, thin };
}

function pad(b, by, w, h) {
	const p = typeof by === "number" ? { x: by, y: by } : by;
	return {
		x0: Math.max(0, Math.floor(b.x0 - p.x)),
		y0: Math.max(0, Math.floor(b.y0 - p.y)),
		x1: Math.min(w, Math.ceil(b.x1 + p.x)),
		y1: Math.min(h, Math.ceil(b.y1 + p.y)),
	};
}

// merges the boxes of list that meet (meet(a, b)) until none do;
// combine(a, b) gives the merged item, its box the union. Each pass takes
// every box in turn and folds into it every later box that meets it as it
// grows (O(n^2)); passes repeat until one merges nothing.
function mergeBoxes(list, meet, combine) {
	let out = [...list];
	for (let merged = true; merged; ) {
		merged = false;
		const gone = new Uint8Array(out.length);
		for (let i = 0; i < out.length; i++) {
			if (gone[i]) continue;
			for (let j = i + 1; j < out.length; j++) {
				if (gone[j] || !meet(out[i], out[j])) continue;
				out[i] = { ...combine(out[i], out[j]), ...union(out[i], out[j]) };
				gone[j] = 1;
				merged = true;
			}
		}
		out = out.filter((_, i) => !gone[i]);
	}
	return out;
}

const area = (b) => boxW(b) * boxH(b);

// side by side along axis: within 2x of each other's size across it,
// overlapping by half the smaller box across it, apart along it by under
// half the smaller box's size along it (the letters of a wordmark; not an
// icon beside a much larger panel)
function aligned(a, b, axis) {
	const p = perp(axis);
	const [sa, sb] = [along(a, p), along(b, p)];
	if (Math.max(sa, sb) > 2 * Math.min(sa, sb)) return false;
	if (rangeOverlap(range(a, p), range(b, p)) < 0.5 * Math.min(sa, sb)) return false;
	return -rangeOverlap(range(a, axis), range(b, axis)) < 0.5 * Math.min(along(a, axis), along(b, axis));
}

// graphic boxes { x0, y0, x1, y1, ink, ink box? } that touch, overlap or
// lie side by side (aligned) merged until none do; ink adds up, the ink
// boxes (inkBox, else the box) join
function mergeGraphicBoxes(list) {
	return mergeBoxes(
		list,
		// boxes apart on both axes neither touch nor line up: the cheap test
		// first, as nearly every pair of many small pieces is such a pair
		(a, b) => !(Math.max(a.x0 - b.x1, b.x0 - a.x1) > 0 && Math.max(a.y0 - b.y1, b.y0 - a.y1) > 0) && (touch(a, b) || aligned(a, b, "x") || aligned(a, b, "y")),
		(a, b) => ({ ink: (a.ink || 0) + (b.ink || 0), inkBox: union(a.inkBox || a, b.inkBox || b) }),
	);
}

// a graphic's ink box is at least 2 m on both sides and 6 m^2 in area
const graphicBigEnough = (width, height, m) => width >= 2 * m && height >= 2 * m && width * height >= 6 * m * m;

// the label's own edge: over 80% of the frame one way, under 5% the
// other, touching the frame
function edgeStrip(g, w, h) {
	const edge = g.x0 <= 0 || g.y0 <= 0 || g.x1 >= w || g.y1 >= h;
	return edge && ((boxH(g) > 0.8 * h && boxW(g) < 0.05 * w) || (boxW(g) > 0.8 * w && boxH(g) < 0.05 * h));
}
const bigger = (a, b) => (area(b) > area(a) ? b : a);

async function decodedBarcodes(raw, padBy) {
	const { results } = await locateBarcodes(raw.data, {
		mode: "autoOnly",
		raw: { width: raw.width, height: raw.height, channels: raw.channels },
		preview: false,
	});
	return results.map((r) => {
		const s = r.symbol || r.roi;
		const b = { x0: s.x, y0: s.y, x1: s.x + s.width, y1: s.y + s.height };
		// a linear code's position can be one scan line: pad across its bars
		const short = Math.max(padBy, 12);
		const by = s.width >= s.height ? { x: padBy, y: short } : { x: short, y: padBy };
		return { ...pad(b, by, raw.width, raw.height), symbol: pad(b, padBy, raw.width, raw.height), score: 1 };
	});
}

// the median gap between bars side by side along axis is under twice the
// median bar width
function evenGaps(bars, axis) {
	const s = [...bars].sort((a, b) => range(a, axis)[0] - range(b, axis)[0]);
	const gaps = [];
	for (let i = 1; i < s.length; i++) gaps.push(range(s[i], axis)[0] - range(s[i - 1], axis)[1]);
	return median(gaps) < 2 * median(s.map((c) => along(c, axis)));
}

// groups of thin parallel dark components with regular lengths, the
// median length >= 3 m
function periodicBarcodes(comps, m) {
	const found = [];
	for (const axis of ["x", "y"]) {
		// bars along `long`, side by side along axis
		const long = perp(axis);
		const bars = comps.filter((c) => c.polarity === 0 && along(c, long) >= 12 && along(c, long) >= 4 * along(c, axis));
		const reach = 4 * maxOf(bars.map((c) => along(c, axis))) + 2;
		const g = groups(bars, axis, reach, (a, b) => {
			const gap = -rangeOverlap(range(a, axis), range(b, axis));
			if (gap > 4 * Math.max(along(a, axis), along(b, axis)) + 2) return false;
			return rangeOverlap(range(a, long), range(b, long)) >= 0.5 * Math.min(along(a, long), along(b, long));
		});
		for (const members of g) {
			if (members.length < 10) continue;
			const lengths = members.map((c) => along(c, long));
			// a row of I's or 1's is thin parallel strokes too, but short
			if (median(lengths) < 3 * m) continue;
			const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length;
			const sd = Math.sqrt(lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / lengths.length);
			const cv = sd / mean;
			if (!(cv <= 0.15 || (cv <= 0.35 && members.length >= 15 && evenGaps(members, axis)))) continue;
			found.push({ ...boxOf(members), score: round3(0.95 * (1 - cv)) });
		}
	}
	return found;
}

async function readLine(raw, line, rotate) {
	const t = across(line, line.axis);
	const roi = pad(line, Math.max(2, Math.round(0.25 * t)), raw.width, raw.height);
	return meanConfidence(await recognise(raw, { x: roi.x0, y: roi.y0, width: boxW(roi), height: boxH(roi) }, { rotate }));
}

// the mean confidence of recognise's characters, the line breaks (1 each)
// left out; 0 when nothing was read
function meanConfidence(r) {
	const c = r.lines.flatMap((l) => l.confidences);
	return c.length ? c.reduce((s, v) => s + v, 0) / c.length : 0;
}

async function orient(raw, blocks, orientation) {
	if (orientation !== "auto") {
		// nothing to vote on: no read, and the model is not loaded
		for (const b of blocks) {
			b.rotate = orientation;
			b.score = 1;
		}
		return;
	}
	for (const b of blocks) {
		const [p, q] = b.axis === "x" ? [0, 180] : [90, 270];
		b.conf = { [p]: await readLine(raw, b.longest, p), [q]: await readLine(raw, b.longest, q) };
		b.rotate = b.conf[q] > b.conf[p] ? q : p;
		b.margin = Math.abs(b.conf[p] - b.conf[q]);
	}
	for (const axis of ["x", "y"]) {
		const mine = blocks.filter((b) => b.axis === axis);
		const sure = mine.filter((b) => b.margin >= 0.3);
		const [p, q] = axis === "x" ? [0, 180] : [90, 270];
		const np = sure.filter((b) => b.rotate === p).length;
		const nq = sure.length - np;
		const major = np > 0 && np >= 2 * nq ? p : nq > 0 && nq >= 2 * np ? q : null;
		if (major === null) continue;
		for (const b of mine) if (b.margin < 0.3) b.rotate = major;
	}
	for (const b of blocks) b.score = b.conf[b.rotate];
}

// a dark component and the text blocks: one that encloses a block stays
// when solid(c) (a panel holding reversed text) and goes when not (a frame
// around text); any other goes when centred in a block
function keptBeside(c, blocks, solid) {
	if (blocks.some((b) => contains(c, b))) return solid(c);
	return !blocks.some((b) => centredIn(c, b));
}

// solid(c): c's box holds at least m^2 pixels of dark ink at least r = m/2
// (at least 3) from any paper, the ink left by eroding the dark mask with
// a (2r + 1)^2 square. A frame's strokes, text and a rule touching a panel
// erode away; a panel's body does not. Its ink over its box would not do:
// large reversed glyphs and a rule along an edge put a solid panel under
// half. The erosion is made on first use.
function solidTest(dark, w, h, m) {
	let paperNear = null;
	return (c) => {
		if (!paperNear) {
			const paper = new Uint8Array(w * h);
			for (let i = 0; i < paper.length; i++) paper[i] = dark[i] ? 0 : 1;
			paperNear = dilate(paper, w, h, Math.max(3, Math.ceil(m / 2)));
		}
		let n = 0;
		for (let y = c.y0; y < c.y1; y++) for (let x = c.x0, i = y * w + x; x < c.x1; x++, i++) n += paperNear[i] ? 0 : 1;
		return n >= m * m;
	};
}

function checkRaw(raw) {
	if (raw === null || typeof raw !== "object") throw new Error(`raw must be { data, width, height, channels }, got ${raw === null ? "null" : typeof raw}`);
	const { data, width, height, channels } = raw;
	for (const [k, v] of [["width", width], ["height", height]]) {
		if (!Number.isInteger(v) || v <= 0) throw new Error(`raw.${k} ${JSON.stringify(v)} is not a positive integer`);
	}
	if (!Number.isInteger(channels) || channels < 1 || channels > 4) throw new Error(`raw.channels ${JSON.stringify(channels)} is not 1, 2, 3 or 4`);
	if (!(data instanceof Uint8Array)) throw new Error(`raw.data is not a Uint8Array or Buffer`);
	const need = width * height * channels;
	if (data.length !== need) throw new Error(`raw.data has ${data.length} bytes, ${width}x${height}x${channels} needs ${need}`);
}

// a number option: absent is the default; else Number(value), finite,
// from 0 to max
function numberOpt(opts, name, def, max = Infinity) {
	const v = opts[name];
	if (v === undefined) return def;
	const n = typeof v === "string" && v.trim() === "" ? NaN : v === null || typeof v === "boolean" ? NaN : Number(v);
	if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name} ${String(v)} is not a finite number from 0 to ${max}`);
	return n;
}

function options(opts) {
	if (opts === undefined) opts = {};
	if (opts === null || typeof opts !== "object") throw new Error(`opts must be an object, got ${opts === null ? "null" : typeof opts}`);
	let orientation = opts.orientation === undefined ? "auto" : opts.orientation;
	if (orientation !== "auto") {
		const n = typeof orientation === "number" || (typeof orientation === "string" && orientation.trim() !== "") ? Number(orientation) : NaN;
		if (!ROTATIONS.includes(n)) throw new Error(`orientation ${typeof orientation === "string" ? JSON.stringify(orientation) : String(orientation)} is not "auto", 0, 90, 180 or 270`);
		orientation = n;
	}
	return {
		orientation,
		minTextHeight: numberOpt(opts, "minTextHeight", 8),
		graphics: opts.graphics !== false,
		barcodes: opts.barcodes !== false,
		pad: numberOpt(opts, "pad", 4),
		minScore: numberOpt(opts, "minScore", 0.7, 1),
	};
}

async function detectRegions(raw, opts) {
	const started = performance.now();
	checkRaw(raw);
	const o = options(opts);
	const { width: w, height: h } = raw;
	const spent = { thresholdMs: 0, componentsMs: 0, barcodeMs: 0, textMs: 0, orientMs: 0, graphicsMs: 0 };
	let t = performance.now();
	const lap = (key) => {
		const now = performance.now();
		spent[key] += now - t;
		t = now;
	};
	const label = (mask, polarity) => connectedComponents(mask, w, h, { minArea: 4 }).map((c) => ({ ...c, polarity }));

	const grey = await toGrey(raw);
	const dark = darkMask(grey, w, h);
	lap("thresholdMs");
	const darkComps = label(dark, 0);
	const m0 = charHeight(darkComps, o.minTextHeight);
	lap("componentsMs");
	const light = lightMask(grey, w, h, Math.max(12, Math.round(1.2 * m0)));
	lap("thresholdMs");
	let comps = [...darkComps, ...label(light, 1)];
	lap("componentsMs");

	let barcodes = [];
	if (o.barcodes) {
		barcodes = await decodedBarcodes(raw, o.pad);
		for (const g of periodicBarcodes(comps, m0)) {
			const hit = barcodes.find((b) => b.score === 1 && touch(b, g));
			// the bars' own extent replaces the guessed 12 px across them
			if (hit) Object.assign(hit, union(hit.symbol, pad(g, o.pad, w, h)));
			else barcodes.push({ ...pad(g, o.pad, w, h), score: g.score });
		}
		barcodes = mergeBoxes(barcodes, overlap, (a, b) => ({ score: Math.max(a.score, b.score) }));
		comps = comps.filter((c) => !barcodes.some((b) => centredIn(c, b)));
	}
	lap("barcodeMs");

	const m = charHeight(comps, o.minTextHeight);
	const charSized = (c) => boxH(c) <= 6 * m && boxW(c) <= 6 * m && notDust(c, o.minTextHeight);
	const lines = textLines(comps.filter(charSized));
	const found = textBlocks(lines, o.minTextHeight);
	let blocks = found.blocks.map((b) => ({ ...b, ...pad(b, o.pad, w, h) }));
	blocks = mergeBoxes(blocks, overlap, (a, b) => {
		const big = bigger(a, b);
		return { axis: big.axis, longest: big.longest, lines: [...a.lines, ...b.lines] };
	});
	lap("textMs");

	await orient(raw, blocks, o.orientation);
	// a forced orientation is not a vote: its score 1 says nothing
	if (o.orientation === "auto") blocks = blocks.filter((b) => b.score >= o.minScore);
	lap("orientMs");

	let graphics = [];
	if (o.graphics) {
		// text is the kept blocks and those too thin; a block dropped for its
		// score, and characters in no block, may be part of a graphic. Light
		// ink is never a graphic: it is the paper between dark shapes, or
		// reversed text
		const inText = new Set([...blocks.flatMap((b) => b.lines), ...found.thin].flatMap((l) => l.members));
		const solid = solidTest(dark, w, h, m);
		const candidates = comps.filter(
			(c) =>
				c.polarity === 0 &&
				!inText.has(c) &&
				keptBeside(c, blocks, solid) &&
				!barcodes.some((b) => centredIn(c, b)),
		);
		const pieces = mergeBoxes(
			candidates.map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, ink: c.area })),
			touch,
			(a, b) => ({ ink: a.ink + b.ink }),
		)
			.map((g) => ({ ...pad(g, o.pad, w, h), ink: g.ink, inkBox: { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 } }))
			.filter((g) => !edgeStrip(g, w, h));
		// last, on the padded boxes, until stable; the size floor after, so
		// thin parts of one mark count once joined
		graphics = mergeGraphicBoxes(pieces)
			.filter((g) => graphicBigEnough(boxW(g.inkBox), boxH(g.inkBox), m))
			.map((g) => ({ ...g, score: round3(Math.min(1, g.ink / area(g.inkBox))) }));
	}
	lap("graphicsMs");

	const regions = [
		...blocks.map((b) => ({ kind: "text", box: b, rotate: b.rotate, score: round3(b.score) })),
		...barcodes.map((b) => ({ kind: "barcode", box: b, rotate: 0, score: b.score })),
		...graphics.map((b) => ({ kind: "graphic", box: b, rotate: 0, score: b.score })),
	]
		.map(({ kind, box, rotate, score }) => ({ kind, x: box.x0, y: box.y0, width: boxW(box), height: boxH(box), rotate, score }))
		.sort((a, b) => a.y - b.y || a.x - b.x);
	const count = {};
	const out = regions.map((r) => {
		count[r.kind] = (count[r.kind] || 0) + 1;
		const name = `${r.kind}${count[r.kind]}`;
		return { name, label: name, ...r };
	});
	const timings = {};
	for (const [k, v] of Object.entries(spent)) timings[k] = Math.round(v * 10) / 10;
	timings.totalMs = ms(started);
	return { regions: out, timings, charHeight: m };
}

module.exports = { detectRegions, mergeGraphicBoxes, meanConfidence, graphicBigEnough };
