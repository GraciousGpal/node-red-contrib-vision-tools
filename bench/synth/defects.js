/**
 * The defect library: realistic label faults painted onto a golden raster,
 * with ground truth measured from the pixels rather than declared.
 *
 * A defect generator that says "this one is a print defect" is telling you
 * what it *intended*. The benchmark needs what it *did*: a `mark` that
 * happened to land entirely on top of a solid black bar changed nothing
 * the background channel can see, and scoring the detector as having
 * missed it would be scoring noise. So every defect here paints into a
 * copy of the raster and the channel is derived by diffing the two:
 *
 *   printPixels      was ink (< 128) and is now >= 64 levels lighter
 *   backgroundPixels was paper (>= 128) and is now >= 64 levels darker
 *   channel          "print" / "background" / "both" / "none" from those
 *
 * 64 levels is a deliberate floor, not a rounding: it is roughly where a
 * change stops being a plausible exposure or JPEG artefact and starts
 * being something golden-compare should be expected to find under the
 * camera model in capture.js. A defect under that floor reports channel
 * "none" and the runner scores it as a part that must still pass - which
 * is the whole point of the `stain` variant.
 *
 * Rasters are { data: Uint8Array, width, height }, 0 = ink, 255 = paper -
 * the same convention lib/compare.js works in.
 *
 * Sizes are authored against a 1500px short side and scaled, so "medium"
 * is the same physical defect at 1500px and at 3000px. Where a scaled size
 * would round several severities onto the same pixel count (a 2px fold at
 * a 300px test raster), `ladder()` keeps the rungs distinct - a severity
 * ladder that collapses silently would make the benchmark's "medium is
 * worse than small" untrue without anything failing.
 *
 * Deliberately not modelled here: anything the camera does. Blur, noise,
 * illumination, magnification, rotation and JPEG all live in capture.js,
 * because a defect's ground truth has to be expressed in golden pixels -
 * that is the space the node reports its regions in.
 */

"use strict";

const SEVERITIES = ["tiny", "small", "medium", "large"];
// area/length multiplier per rung - 2x per step, so a rung is always well
// clear of its neighbour's jitter
const SEV_SCALE = { tiny: 0.25, small: 0.5, medium: 1, large: 2 };
const DESIGN_SHORT_SIDE = 1500;
const INK_LEVEL = 128;
const CHANGE_FLOOR = 64;

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function darken(out, i, level, alpha) {
	const v = Math.round(out[i] * (1 - alpha) + level * alpha);
	if (v < out[i]) out[i] = clamp255(v);
}

function lighten(out, i, level, alpha) {
	const v = Math.round(out[i] * (1 - alpha) + level * alpha);
	if (v > out[i]) out[i] = clamp255(v);
}

// ---------------------------------------------------------------- rasterising

function distToSegment(px, py, x0, y0, x1, y1) {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const len2 = dx * dx + dy * dy;
	let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
	if (t < 0) t = 0;
	else if (t > 1) t = 1;
	const qx = x0 + t * dx - px;
	const qy = y0 + t * dy - py;
	return Math.sqrt(qx * qx + qy * qy);
}

/**
 * Paint a polyline of the given width. `paint(index, alpha)` gets an alpha
 * that tapers over the last half pixel, so a 1px stroke is a 1px stroke
 * rather than a staircase of hard-edged squares.
 */
function strokePolyline(width, height, pts, strokeWidth, paint) {
	const half = strokeWidth / 2;
	const pad = Math.ceil(half + 1);
	for (let s = 0; s + 1 < pts.length; s++) {
		const [x0, y0] = pts[s];
		const [x1, y1] = pts[s + 1];
		const minX = Math.max(0, Math.floor(Math.min(x0, x1)) - pad);
		const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1)) + pad);
		const minY = Math.max(0, Math.floor(Math.min(y0, y1)) - pad);
		const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1)) + pad);
		for (let y = minY; y <= maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				const d = distToSegment(x + 0.5, y + 0.5, x0, y0, x1, y1);
				if (d > half + 0.5) continue;
				paint(y * width + x, Math.min(1, half + 0.5 - d));
			}
		}
	}
}

/**
 * An irregular blob: a radius that wobbles with three harmonics of the
 * polar angle, with a soft rim. Real ink marks are not discs, and a
 * detector tuned against discs learns the wrong edge statistics.
 */
function fillBlob(width, height, cx, cy, radius, prng, softness, paint) {
	const h = [];
	for (let i = 0; i < 3; i++) {
		h.push({
			amp: prng.uniform(0.08, 0.3),
			freq: prng.int(2, 6),
			phase: prng.uniform(0, Math.PI * 2),
		});
	}
	const radiusAt = (theta) => {
		let f = 1;
		for (const t of h) f += t.amp * Math.sin(t.freq * theta + t.phase);
		return radius * Math.max(0.25, f);
	};
	const reach = radius * 1.6 + softness + 1;
	const minX = Math.max(0, Math.floor(cx - reach));
	const maxX = Math.min(width - 1, Math.ceil(cx + reach));
	const minY = Math.max(0, Math.floor(cy - reach));
	const maxY = Math.min(height - 1, Math.ceil(cy + reach));
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const d = Math.sqrt(dx * dx + dy * dy);
			const rr = radiusAt(Math.atan2(dy, dx));
			let alpha;
			if (d <= rr) alpha = 1;
			else if (softness > 0 && d <= rr + softness) alpha = 1 - (d - rr) / softness;
			else continue;
			paint(y * width + x, alpha);
		}
	}
}

/** A smooth wandering path: a straight run with two sinusoidal wobbles. */
function wanderPath(x0, y0, angle, length, amplitude, prng, steps = 48) {
	const ca = Math.cos(angle);
	const sa = Math.sin(angle);
	const w1 = { f: prng.uniform(0.7, 2.2), p: prng.uniform(0, 6.28) };
	const w2 = { f: prng.uniform(2.5, 6), p: prng.uniform(0, 6.28) };
	const pts = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const lat =
			amplitude *
			(Math.sin(w1.f * t * Math.PI * 2 + w1.p) * 0.7 +
				Math.sin(w2.f * t * Math.PI * 2 + w2.p) * 0.3);
		pts.push([
			x0 + ca * length * t - sa * lat,
			y0 + sa * length * t + ca * lat,
		]);
	}
	return pts;
}

// ------------------------------------------------------------------- sampling

/**
 * A point sitting on ink (or on paper), by rejection. Placement matters:
 * a misprint dropped on blank paper erases nothing and would be scored as
 * a defect the detector "missed" when there was never anything to find.
 * Falls back to the frame centre after 400 tries so a blank raster still
 * produces a defect rather than hanging.
 */
function samplePoint(ctx, prng, wantInk, margin = 0) {
	const { before: data, width, height } = ctx;
	// a margin wider than half the raster would invert the range and index
	// outside the buffer - possible once a "large" defect meets a small
	// test raster
	const mx = Math.min(margin, (width - 1) >> 1);
	const my = Math.min(margin, (height - 1) >> 1);
	for (let i = 0; i < 400; i++) {
		const x = prng.int(mx, width - 1 - mx);
		const y = prng.int(my, height - 1 - my);
		const ink = data[y * width + x] < INK_LEVEL;
		if (ink === wantInk) return { x, y };
	}
	return { x: width >> 1, y: height >> 1 };
}

/**
 * 4-connected components of ink, as a label map plus per-component size and
 * centroid. Used only by `dropout`, which needs to remove a whole glyph
 * rather than a geometric patch of one.
 */
function labelInk(data, width, height) {
	const labels = new Int32Array(width * height).fill(-1);
	const comps = [];
	const stack = new Int32Array(width * height);
	for (let start = 0; start < labels.length; start++) {
		if (labels[start] !== -1 || data[start] >= INK_LEVEL) continue;
		const id = comps.length;
		let top = 0;
		stack[top++] = start;
		labels[start] = id;
		let size = 0;
		let sx = 0;
		let sy = 0;
		while (top > 0) {
			const idx = stack[--top];
			const x = idx % width;
			const y = (idx / width) | 0;
			size++;
			sx += x;
			sy += y;
			if (x > 0 && labels[idx - 1] === -1 && data[idx - 1] < INK_LEVEL) {
				labels[idx - 1] = id;
				stack[top++] = idx - 1;
			}
			if (x < width - 1 && labels[idx + 1] === -1 && data[idx + 1] < INK_LEVEL) {
				labels[idx + 1] = id;
				stack[top++] = idx + 1;
			}
			if (y > 0 && labels[idx - width] === -1 && data[idx - width] < INK_LEVEL) {
				labels[idx - width] = id;
				stack[top++] = idx - width;
			}
			if (
				y < height - 1 &&
				labels[idx + width] === -1 &&
				data[idx + width] < INK_LEVEL
			) {
				labels[idx + width] = id;
				stack[top++] = idx + width;
			}
		}
		comps.push({ id, size, cx: sx / size, cy: sy / size });
	}
	return { labels, comps };
}

// -------------------------------------------------------------------- context

function makeContext(before, out, width, height, severity, prng) {
	const shortSide = Math.min(width, height);
	const k = shortSide / DESIGN_SHORT_SIDE;
	const sevIndex = SEVERITIES.indexOf(severity);
	const sev = SEV_SCALE[severity];
	return {
		before,
		out,
		width,
		height,
		shortSide,
		prng,
		severity,
		sevIndex,
		sev,
		/** a design-px length in this raster's pixels */
		px: (designPx) => designPx * k,
		/**
		 * A scaled size that never lets two severities land on the same
		 * pixel count: the rung index is a floor. Without it a 300px test
		 * raster collapses "tiny" through "large" onto 1px and the ladder
		 * silently stops being a ladder.
		 */
		ladder: (designPx, min = 1) =>
			Math.max(min + sevIndex, Math.round(designPx * k)),
	};
}

// ------------------------------------------------------------------- painters
// Each painter mutates ctx.out and returns the params worth recording.
// None of them computes ground truth; applyDefect diffs for that.

function scratch(ctx, dark) {
	const { prng, width, height } = ctx;
	const lengthFrac = 0.06 * ctx.sev * 2 * prng.uniform(0.85, 1.15);
	const length = Math.max(6, lengthFrac * ctx.shortSide);
	const strokeWidth = Math.max(
		1,
		ctx.ladder(1 + ctx.sevIndex, 1) * prng.uniform(0.85, 1.15),
	);
	// a light scratch only shows where it crosses ink, a dark one only on
	// paper, so each starts where it has something to do
	const start = samplePoint(ctx, prng, !dark, 2);
	const angle = prng.uniform(0, Math.PI * 2);
	const pts = wanderPath(
		start.x,
		start.y,
		angle,
		length,
		length * prng.uniform(0.03, 0.12),
		prng,
	);
	const level = dark ? prng.int(15, 55) : 255;
	const opacity = prng.uniform(0.85, 1);
	strokePolyline(width, height, pts, strokeWidth, (i, a) => {
		if (dark) darken(ctx.out, i, level, a * opacity);
		else lighten(ctx.out, i, level, a * opacity);
	});
	return {
		length: Math.round(length),
		width: Math.round(strokeWidth * 10) / 10,
		level,
		opacity: Math.round(opacity * 100) / 100,
		direction: dark ? "additive" : "subtractive",
	};
}

function mark(ctx, variant) {
	const { prng, width, height } = ctx;
	const radius = Math.max(
		1,
		ctx.ladder(4 + 18 * ctx.sev, 1) * prng.uniform(0.85, 1.15),
	);
	const at = samplePoint(ctx, prng, false, Math.ceil(radius) + 1);
	if (variant === "spatter") {
		// a cluster of small dots - the case a block-density heat map can
		// miss because no single dot fills a block
		const dots = 4 << ctx.sevIndex;
		const spread = radius * 3;
		const level = prng.int(10, 45);
		for (let i = 0; i < dots; i++) {
			const a = prng.uniform(0, Math.PI * 2);
			const r = spread * Math.sqrt(prng.next());
			fillBlob(
				width,
				height,
				at.x + r * Math.cos(a),
				at.y + r * Math.sin(a),
				Math.max(0.6, radius * prng.uniform(0.15, 0.35)),
				prng,
				0.7,
				(idx, alpha) => darken(ctx.out, idx, level, alpha),
			);
		}
		return {
			radius: Math.round(radius * 10) / 10,
			dots,
			spread: Math.round(spread),
			level,
		};
	}
	const ink = variant === "ink";
	const level = ink ? prng.int(8, 32) : prng.int(95, 140);
	const opacity = ink ? prng.uniform(0.9, 1) : prng.uniform(0.55, 0.85);
	const softness = ink ? ctx.px(1.5) : Math.max(1, radius * 0.4);
	fillBlob(width, height, at.x, at.y, radius, prng, softness, (i, alpha) =>
		darken(ctx.out, i, level, alpha * opacity),
	);
	return {
		radius: Math.round(radius * 10) / 10,
		level,
		opacity: Math.round(opacity * 100) / 100,
		softness: Math.round(softness * 10) / 10,
	};
}

function misprint(ctx, variant) {
	const { prng, width, height } = ctx;
	if (variant === "void") {
		const radius = Math.max(
			1,
			ctx.ladder(3 + 9 * ctx.sev, 1) * prng.uniform(0.85, 1.15),
		);
		const at = samplePoint(ctx, prng, true, 1);
		fillBlob(width, height, at.x, at.y, radius, prng, ctx.px(1), (i, alpha) =>
			lighten(ctx.out, i, 255, alpha),
		);
		return { radius: Math.round(radius * 10) / 10 };
	}
	if (variant === "faded") {
		// partial ink loss over a strip. The fade fraction is independent of
		// severity on purpose: a faint fade is a real press condition and it
		// is *supposed* to fall under the change floor and report "none".
		const fraction = prng.uniform(0.2, 0.75);
		const w = Math.max(3, ctx.px(90) * ctx.sev * prng.uniform(0.8, 1.2));
		const h = Math.max(3, ctx.px(50) * ctx.sev * prng.uniform(0.8, 1.2));
		const at = samplePoint(ctx, prng, true, 1);
		const x0 = Math.max(0, Math.round(at.x - w / 2));
		const y0 = Math.max(0, Math.round(at.y - h / 2));
		const x1 = Math.min(width, x0 + Math.round(w));
		const y1 = Math.min(height, y0 + Math.round(h));
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = y * width + x;
				if (ctx.out[i] >= INK_LEVEL) continue;
				lighten(ctx.out, i, 255, fraction);
			}
		}
		return {
			fraction: Math.round(fraction * 100) / 100,
			w: x1 - x0,
			h: y1 - y0,
		};
	}
	if (variant === "dropout") {
		// whole connected components removed - a dropped glyph, not a hole
		const { labels, comps } = labelInk(ctx.before, width, height);
		let totalInk = 0;
		for (const c of comps) totalInk += c.size;
		// as a fraction of the label's ink, so "large" is a dropped line of
		// type rather than a fraction of the page that happens to scale with
		// the raster. 3x a rung keeps the ladder clear of the overshoot from
		// taking one component too many.
		const budget = Math.max(
			1,
			Math.round(totalInk * 0.001 * Math.pow(3, ctx.sevIndex)),
		);
		// only components the budget can afford, so a bigger budget is always
		// a superset of a smaller one's choices and the ladder holds
		let eligible = comps.filter((c) => c.size <= budget);
		if (!eligible.length && comps.length) {
			eligible = [comps.reduce((a, b) => (a.size <= b.size ? a : b))];
		}
		const anchor = samplePoint(ctx, prng, true, 1);
		eligible.sort(
			(a, b) =>
				(a.cx - anchor.x) ** 2 +
				(a.cy - anchor.y) ** 2 -
				((b.cx - anchor.x) ** 2 + (b.cy - anchor.y) ** 2),
		);
		const chosen = new Set();
		let taken = 0;
		for (const c of eligible) {
			chosen.add(c.id);
			taken += c.size;
			if (taken >= budget) break;
		}
		for (let i = 0; i < labels.length; i++) {
			if (labels[i] >= 0 && chosen.has(labels[i])) ctx.out[i] = 255;
		}
		return { components: chosen.size, pixels: taken, budget };
	}
	// streak: a dead thermal-head element - one narrow white column through
	// the print, the classic misprint on a direct-thermal label
	const strokeWidth = ctx.ladder(1 + 1.7 * ctx.sevIndex, 1);
	const runFrac = [0.3, 0.5, 0.75, 1][ctx.sevIndex] * prng.uniform(0.9, 1);
	// the column is chosen through ink: a streak down a blank margin is a
	// real thing a printer does, but it erases nothing, and a set full of
	// defects that changed no pixels measures nothing
	const at = samplePoint(ctx, prng, true, 1);
	const x = at.x;
	const h = Math.max(4, Math.round(height * runFrac));
	const y0 = Math.max(0, Math.min(height - h, at.y - (h >> 1)));
	for (let y = y0; y < y0 + h; y++) {
		for (let d = 0; d < strokeWidth; d++) {
			const xx = x + d;
			if (xx < 0 || xx >= width) continue;
			ctx.out[y * width + xx] = 255;
		}
	}
	return { x, y: y0, width: strokeWidth, height: h };
}

function overprint(ctx, variant) {
	const { prng, width, height } = ctx;
	if (variant === "ghost") {
		// a second impression of the artwork itself, shifted - double print
		const w = Math.max(6, ctx.px(120) * ctx.sev * prng.uniform(0.85, 1.15));
		const h = Math.max(6, ctx.px(90) * ctx.sev * prng.uniform(0.85, 1.15));
		const shift = ctx.ladder(2 + 3.5 * ctx.sevIndex, 2);
		const angle = prng.uniform(0, Math.PI * 2);
		// the `|| 0` is not redundant: Math.round can produce -0, which JSON
		// writes as 0, and the manifest in memory would stop matching the
		// manifest on disk
		const dx = Math.round(shift * Math.cos(angle)) || 0;
		const dy = Math.round(shift * Math.sin(angle)) || 0;
		const opacity = prng.uniform(0.45, 0.85);
		const at = samplePoint(ctx, prng, true, 1);
		const x0 = Math.max(0, Math.round(at.x - w / 2));
		const y0 = Math.max(0, Math.round(at.y - h / 2));
		const x1 = Math.min(width, x0 + Math.round(w));
		const y1 = Math.min(height, y0 + Math.round(h));
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const sx = x - dx;
				const sy = y - dy;
				if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
				darken(ctx.out, y * width + x, ctx.before[sy * width + sx], opacity);
			}
		}
		return {
			w: x1 - x0,
			h: y1 - y0,
			dx,
			dy,
			opacity: Math.round(opacity * 100) / 100,
		};
	}
	if (variant === "bleed") {
		// ink spreading: strokes thicken locally, which is the background
		// channel's hardest case because it hugs real ink
		const radius = Math.max(4, ctx.px(60) * ctx.sev * prng.uniform(0.85, 1.15));
		const grow = ctx.ladder(1 + 0.9 * ctx.sevIndex, 1);
		const level = prng.int(20, 60);
		const at = samplePoint(ctx, prng, true, 1);
		const minX = Math.max(0, Math.floor(at.x - radius));
		const maxX = Math.min(width - 1, Math.ceil(at.x + radius));
		const minY = Math.max(0, Math.floor(at.y - radius));
		const maxY = Math.min(height - 1, Math.ceil(at.y + radius));
		const g2 = grow * grow;
		for (let y = minY; y <= maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				const rx = x - at.x;
				const ry = y - at.y;
				if (rx * rx + ry * ry > radius * radius) continue;
				const i = y * width + x;
				if (ctx.before[i] < INK_LEVEL) continue;
				let near = false;
				for (let oy = -grow; oy <= grow && !near; oy++) {
					const yy = y + oy;
					if (yy < 0 || yy >= height) continue;
					for (let ox = -grow; ox <= grow; ox++) {
						if (ox * ox + oy * oy > g2) continue;
						const xx = x + ox;
						if (xx < 0 || xx >= width) continue;
						if (ctx.before[yy * width + xx] < INK_LEVEL) {
							near = true;
							break;
						}
					}
				}
				if (near) darken(ctx.out, i, level, 1);
			}
		}
		return { radius: Math.round(radius), grow, level };
	}
	if (variant === "stroke") {
		const strokeWidth = Math.max(1, ctx.ladder(2 + 2.5 * ctx.sevIndex, 1));
		const length = Math.max(8, 0.12 * ctx.sev * 2 * ctx.shortSide);
		const at = samplePoint(ctx, prng, false, 1);
		const angle = prng.uniform(0, Math.PI * 2);
		const level = prng.int(10, 50);
		strokePolyline(
			width,
			height,
			[
				[at.x, at.y],
				[at.x + Math.cos(angle) * length, at.y + Math.sin(angle) * length],
			],
			strokeWidth,
			(i, a) => darken(ctx.out, i, level, a),
		);
		return {
			width: strokeWidth,
			length: Math.round(length),
			level,
			angleDeg: Math.round((angle * 180) / Math.PI),
		};
	}
	// fill: a solid block where the artwork has none - a table cell filled in
	const w = Math.max(2, Math.round(ctx.px(26) * ctx.sev * prng.uniform(0.8, 1.2)));
	const h = Math.max(2, Math.round(ctx.px(18) * ctx.sev * prng.uniform(0.8, 1.2)));
	const at = samplePoint(ctx, prng, false, 1);
	const x0 = Math.max(0, Math.min(width - w, Math.round(at.x - w / 2)));
	const y0 = Math.max(0, Math.min(height - h, Math.round(at.y - h / 2)));
	const level = prng.int(10, 55);
	for (let y = y0; y < Math.min(height, y0 + h); y++) {
		for (let x = x0; x < Math.min(width, x0 + w); x++) {
			darken(ctx.out, y * width + x, level, 1);
		}
	}
	return { x: x0, y: y0, w, h, level };
}

function randomFamily(ctx, variant) {
	const { prng, width, height } = ctx;
	if (variant === "dust") {
		// count scales with area so the *density* of dust is what severity
		// means, not the absolute count on whatever raster you handed it
		const areaRatio = (width * height) / (DESIGN_SHORT_SIDE * 2100);
		const base = [40, 150, 600, 2400][ctx.sevIndex];
		const count = Math.max(2 + ctx.sevIndex, Math.round(base * areaRatio));
		const level = prng.int(15, 70);
		for (let i = 0; i < count; i++) {
			const x = prng.int(0, width - 1);
			const y = prng.int(0, height - 1);
			fillBlob(
				width,
				height,
				x,
				y,
				Math.max(0.5, ctx.px(prng.uniform(0.6, 1.6))),
				prng,
				0.6,
				(idx, a) => darken(ctx.out, idx, level, a),
			);
		}
		return { count, level };
	}
	if (variant === "void-spots") {
		const areaRatio = (width * height) / (DESIGN_SHORT_SIDE * 2100);
		const base = [30, 110, 440, 1760][ctx.sevIndex];
		const count = Math.max(2 + ctx.sevIndex, Math.round(base * areaRatio));
		let placed = 0;
		for (let i = 0; i < count; i++) {
			const at = samplePoint(ctx, prng, true, 1);
			fillBlob(
				width,
				height,
				at.x,
				at.y,
				Math.max(0.5, ctx.px(prng.uniform(0.8, 2.2))),
				prng,
				0.6,
				(idx, a) => lighten(ctx.out, idx, 255, a),
			);
			placed++;
		}
		return { count: placed };
	}
	if (variant === "stain") {
		// 15-40 grey levels off paper: below the change floor by
		// construction, so this variant's honest answer is always channel
		// "none". It is in the set to measure false alarms, not detections.
		const delta = prng.int(15, 40);
		const radius = Math.max(
			4,
			ctx.px(120) * ctx.sev * prng.uniform(0.85, 1.15),
		);
		const at = samplePoint(ctx, prng, false, 0);
		fillBlob(width, height, at.x, at.y, radius, prng, radius * 0.5, (i, a) => {
			const v = ctx.out[i] - delta * a;
			ctx.out[i] = clamp255(Math.round(v));
		});
		return { delta, radius: Math.round(radius) };
	}
	if (variant === "fold") {
		// a crease: a lit highlight with a shadow along one side, crossing
		// the whole label - lifts ink on one side and lays ink on the other
		const lightWidth = Math.max(1, ctx.ladder(2 + 2.5 * ctx.sevIndex, 1));
		const darkWidth = Math.max(1, ctx.ladder(1 + 1.5 * ctx.sevIndex, 1));
		const vertical = prng.bool();
		const pos = vertical
			? prng.int((width * 0.15) | 0, (width * 0.85) | 0)
			: prng.int((height * 0.15) | 0, (height * 0.85) | 0);
		const skew = prng.uniform(-0.08, 0.08);
		const span = vertical ? height : width;
		const a = vertical ? [pos, 0] : [0, pos];
		const b = vertical
			? [pos + skew * span, height]
			: [width, pos + skew * span];
		const darkLevel = prng.int(60, 130);
		const off = (lightWidth + darkWidth) / 2;
		const nx = vertical ? off : 0;
		const ny = vertical ? 0 : off;
		strokePolyline(width, height, [a, b], lightWidth, (i, al) =>
			lighten(ctx.out, i, 255, al * 0.9),
		);
		strokePolyline(
			width,
			height,
			[
				[a[0] + nx, a[1] + ny],
				[b[0] + nx, b[1] + ny],
			],
			darkWidth,
			(i, al) => darken(ctx.out, i, darkLevel, al * 0.9),
		);
		return { vertical, pos, lightWidth, darkWidth, darkLevel };
	}
	// combo: two or three faults on one part, reported as one ground truth
	// object - the runner scores what the frame contains, and a part with
	// three faults is still one reject
	const menu = [
		["scratch", "light"],
		["scratch", "dark"],
		["mark", "ink"],
		["mark", "smudge"],
		["misprint", "void"],
		["misprint", "streak"],
		["overprint", "ghost"],
		["overprint", "fill"],
		["random", "dust"],
		["random", "stain"],
	];
	const n = prng.int(2, 3);
	const parts = [];
	const pool = prng.shuffle(menu.slice());
	for (let i = 0; i < n; i++) {
		const [type, variantName] = pool[i];
		PAINTERS[type](ctx, variantName);
		parts.push({ type, variant: variantName });
	}
	return { parts };
}

const PAINTERS = {
	scratch: (ctx, variant) => scratch(ctx, variant === "dark"),
	mark,
	misprint,
	overprint,
	random: randomFamily,
};

/** Every family and the variants it offers, in a stable order. */
const FAMILIES = {
	scratch: ["light", "dark"],
	mark: ["ink", "smudge", "spatter"],
	misprint: ["void", "faded", "dropout", "streak"],
	overprint: ["ghost", "bleed", "stroke", "fill"],
	random: ["dust", "void-spots", "stain", "fold", "combo"],
};

// --------------------------------------------------------------- ground truth

/**
 * Diff two rasters into the ground-truth record. `bbox` covers every pixel
 * whose value changed *at all* - including sub-floor changes, so a faint
 * stain still reports where it is even though its channel is "none".
 */
function groundTruth(before, after, width, height, spec, params) {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	let printPixels = 0;
	let backgroundPixels = 0;
	let changed = 0;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const i = row + x;
			const a = before[i];
			const b = after[i];
			if (a === b) continue;
			changed++;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			if (a < INK_LEVEL) {
				if (b - a >= CHANGE_FLOOR) printPixels++;
			} else if (a - b >= CHANGE_FLOOR) backgroundPixels++;
		}
	}
	const bbox =
		maxX < 0
			? { x: 0, y: 0, w: 0, h: 0 }
			: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
	const channel =
		printPixels > 0 && backgroundPixels > 0
			? "both"
			: printPixels > 0
				? "print"
				: backgroundPixels > 0
					? "background"
					: "none";
	return {
		type: spec.type,
		variant: spec.variant,
		severity: spec.severity,
		channel,
		bbox,
		printPixels,
		backgroundPixels,
		params: { ...params, changedPixels: changed },
	};
}

/**
 * Apply one defect to a golden raster.
 *
 * @param {{data:Uint8Array,width:number,height:number}} golden
 * @param {{type:string,variant:string,severity:string}} spec
 * @param {object} prng from prng.js - required, so the result is reproducible
 * @returns {{data:Uint8Array,width:number,height:number,gt:object}}
 */
function applyDefect(golden, spec, prng) {
	const { data, width, height } = golden;
	const painter = PAINTERS[spec.type];
	if (!painter) throw new Error(`unknown defect family "${spec.type}"`);
	if (!FAMILIES[spec.type].includes(spec.variant)) {
		throw new Error(`unknown ${spec.type} variant "${spec.variant}"`);
	}
	if (!SEVERITIES.includes(spec.severity)) {
		throw new Error(`unknown severity "${spec.severity}"`);
	}
	const out = Uint8Array.from(data);
	const ctx = makeContext(data, out, width, height, spec.severity, prng);
	const params = painter(ctx, spec.variant) || {};
	return {
		data: out,
		width,
		height,
		gt: groundTruth(data, out, width, height, spec, params),
	};
}

/**
 * Stack several defects onto one raster. Each defect's ground truth is
 * measured against the raster *as it was just before that defect*, not
 * against the original: what a second scratch did is what it did to the
 * part it landed on.
 */
function applyDefects(golden, list, prng) {
	let current = golden;
	const gt = [];
	for (const spec of list) {
		const step = applyDefect(current, spec, prng);
		gt.push(step.gt);
		current = { data: step.data, width: step.width, height: step.height };
	}
	return { ...current, gt };
}

module.exports = {
	applyDefect,
	applyDefects,
	FAMILIES,
	SEVERITIES,
	INK_LEVEL,
	CHANGE_FLOOR,
	labelInk,
};
