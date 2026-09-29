/**
 * The synthetic frame generator (bench/synth/).
 *
 * This is bench code, but its output is the *measuring stick* a detector
 * change gets judged against, so the properties that would silently
 * invalidate a benchmark are worth pinning:
 *
 *  - a seed reproduces a set (otherwise two runs are not comparable);
 *  - the golden really is two-level artwork with a plausible ink fraction;
 *  - every defect's ground truth matches what it did to the pixels - the
 *    bbox, the per-channel counts and the derived channel are recomputed
 *    here from an independent diff, because a generator that mislabels its
 *    own output produces a benchmark that is confidently wrong;
 *  - each severity ladder really is a ladder;
 *  - `stain` stays under the change floor, which is the one variant whose
 *    correct answer is "this part passes";
 *  - the manifest matches the contract run.js reads.
 *
 * Everything runs on small rasters (300x420, and 200x280 for the whole
 * generator) so the file stays a few seconds.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { makePrng } = require("../bench/synth/prng.js");
const {
	syntheticLabel,
	syntheticLabelRaster,
} = require("../bench/synth/label.js");
const {
	applyDefect,
	applyDefects,
	FAMILIES,
	SEVERITIES,
	INK_LEVEL,
	CHANGE_FLOOR,
} = require("../bench/synth/defects.js");
const { capture, capturePresets } = require("../bench/synth/capture.js");
const { generate } = require("../bench/synth/generate.js");

const W = 300;
const H = 420;

let goldenPromise = null;
function smallGolden() {
	if (!goldenPromise) goldenPromise = syntheticLabelRaster(W, H, 3);
	return goldenPromise;
}

/** The ground-truth derivation, rewritten independently of defects.js. */
function diff(before, after, width, height) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let printPixels = 0;
	let backgroundPixels = 0;
	let changed = 0;
	for (let i = 0; i < before.length; i++) {
		if (before[i] === after[i]) continue;
		changed++;
		const x = i % width;
		const y = Math.floor(i / width);
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
		if (before[i] < INK_LEVEL) {
			if (after[i] - before[i] >= CHANGE_FLOOR) printPixels++;
		} else if (before[i] - after[i] >= CHANGE_FLOOR) {
			backgroundPixels++;
		}
	}
	const channel =
		printPixels > 0 && backgroundPixels > 0
			? "both"
			: printPixels > 0
				? "print"
				: backgroundPixels > 0
					? "background"
					: "none";
	return {
		changed,
		printPixels,
		backgroundPixels,
		channel,
		bbox: changed
			? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
			: { x: 0, y: 0, w: 0, h: 0 },
	};
}

const everyVariant = Object.entries(FAMILIES).flatMap(([type, variants]) =>
	variants.map((variant) => [type, variant]),
);

test("a seed reproduces the prng stream, and a different seed does not", () => {
	const a = makePrng(42);
	const b = makePrng(42);
	const c = makePrng(43);
	const draw = (p) => [
		p.next(),
		p.uniform(-3, 3),
		p.int(0, 1000),
		p.pick([1, 2, 3, 4, 5]),
		p.gaussian(0, 2),
		p.bool(),
		p.shuffle([1, 2, 3, 4, 5, 6]).join(","),
	];
	assert.deepEqual(draw(a), draw(b));
	assert.notDeepEqual(draw(makePrng(42)), draw(c));

	const p = makePrng(7);
	for (let i = 0; i < 2000; i++) {
		const u = p.uniform(2, 5);
		assert.ok(u >= 2 && u < 5);
		const n = p.int(3, 6);
		assert.ok(n >= 3 && n <= 6 && Number.isInteger(n));
	}
});

test("the synthetic label is two-level artwork with a label-like ink fraction", async () => {
	for (const [w, h] of [
		[300, 420],
		[1500, 2100],
	]) {
		const raster = await syntheticLabelRaster(w, h, 1);
		assert.equal(raster.width, w);
		assert.equal(raster.height, h);
		let ink = 0;
		for (let i = 0; i < raster.data.length; i++) {
			const v = raster.data[i];
			assert.ok(v === 0 || v === 255, `level ${v} is neither ink nor paper`);
			if (v === 0) ink++;
		}
		const fraction = ink / raster.data.length;
		assert.ok(
			fraction > 0.05 && fraction < 0.35,
			`ink fraction ${fraction.toFixed(3)} is not label-like at ${w}x${h}`,
		);
	}
	const png = await syntheticLabel(200, 280, 2);
	const meta = await sharp(png).metadata();
	assert.equal(meta.format, "png");
	assert.equal(meta.width, 200);
	assert.equal(meta.height, 280);
});

test("every defect's ground truth is what it did to the pixels", async () => {
	const golden = await smallGolden();
	for (const [type, variant] of everyVariant) {
		for (const severity of ["small", "large"]) {
			const spec = { type, variant, severity };
			const result = applyDefect(golden, spec, makePrng(91));
			const truth = diff(golden.data, result.data, W, H);
			const where = `${type}/${variant}/${severity}`;
			assert.ok(truth.changed > 0, `${where} changed nothing`);
			assert.deepEqual(result.gt.bbox, truth.bbox, `${where} bbox`);
			assert.equal(result.gt.printPixels, truth.printPixels, `${where} print`);
			assert.equal(
				result.gt.backgroundPixels,
				truth.backgroundPixels,
				`${where} background`,
			);
			assert.equal(result.gt.channel, truth.channel, `${where} channel`);
			assert.equal(result.gt.params.changedPixels, truth.changed);
			assert.equal(result.gt.type, type);
			assert.equal(result.gt.variant, variant);
			assert.equal(result.gt.severity, severity);
			// the golden itself is never touched
			assert.notEqual(result.data, golden.data);
		}
	}
});

test("severity is a ladder: more severe changes more pixels", async () => {
	const golden = await smallGolden();
	for (const [type, variant] of everyVariant) {
		const means = SEVERITIES.map((severity) => {
			let sum = 0;
			for (let s = 0; s < 3; s++) {
				const r = applyDefect(
					golden,
					{ type, variant, severity },
					makePrng(1000 + s * 17),
				);
				sum += r.gt.params.changedPixels;
			}
			return sum / 3;
		});
		for (let i = 1; i < means.length; i++) {
			assert.ok(
				means[i] > means[i - 1],
				`${type}/${variant} ladder is not monotonic: ${means.join(", ")}`,
			);
		}
	}
});

test("a faint stain is honestly reported as changing no channel", async () => {
	const golden = await smallGolden();
	for (const severity of SEVERITIES) {
		for (let s = 0; s < 4; s++) {
			const r = applyDefect(
				golden,
				{ type: "random", variant: "stain", severity },
				makePrng(500 + s),
			);
			assert.equal(r.gt.channel, "none", `stain/${severity} seed ${s}`);
			assert.equal(r.gt.printPixels, 0);
			assert.equal(r.gt.backgroundPixels, 0);
			assert.ok(r.gt.params.delta >= 15 && r.gt.params.delta <= 40);
			assert.ok(r.gt.params.changedPixels > 0, "a stain still changes pixels");
		}
	}
});

test("stacked defects each report against the raster they landed on", async () => {
	const golden = await smallGolden();
	const list = [
		{ type: "mark", variant: "ink", severity: "medium" },
		{ type: "misprint", variant: "streak", severity: "medium" },
	];
	const stacked = applyDefects(golden, list, makePrng(11));
	assert.equal(stacked.gt.length, 2);
	assert.equal(stacked.gt[0].variant, "ink");
	assert.equal(stacked.gt[1].variant, "streak");
	// the second is measured against the first's output, so the union of the
	// two diffs is exactly the total change from the original
	const total = diff(golden.data, stacked.data, W, H);
	assert.ok(total.changed > 0);
	assert.ok(
		total.changed <=
			stacked.gt[0].params.changedPixels + stacked.gt[1].params.changedPixels,
	);
});

test("capture produces the frame it recorded, within the preset's ranges", async () => {
	const golden = await smallGolden();
	for (const [name, ranges] of Object.entries(capturePresets)) {
		const shot = await capture(golden, name, makePrng(5));
		const meta = await sharp(shot.buffer).metadata();
		assert.equal(meta.width, shot.params.frameWidth, `${name} width`);
		assert.equal(meta.height, shot.params.frameHeight, `${name} height`);
		assert.equal(meta.format === "jpeg" ? "jpg" : meta.format, shot.format);
		// the label plus its tray margin is always bigger than the golden
		assert.ok(shot.params.frameWidth > golden.width);
		assert.ok(shot.params.frameHeight > golden.height);

		const within = (key, [lo, hi]) =>
			assert.ok(
				shot.params[key] >= lo - 1e-6 && shot.params[key] <= hi + 1e-6,
				`${name}.${key} = ${shot.params[key]} outside [${lo}, ${hi}]`,
			);
		within("mx", ranges.mag);
		within("angleDeg", ranges.angleDeg);
		within("ink", ranges.ink);
		within("paper", ranges.paper);
		within("gradient", ranges.gradient);
		within("vignette", ranges.vignette);
		within("blurSigma", ranges.blurSigma);
		within("noiseSigma", ranges.noiseSigma);
		within("margin", ranges.margin);
		within("trayGrey", ranges.tray);
		// my is mx stretched, and both magnifications stay in the physical band
		const stretch = shot.params.my / shot.params.mx - 1;
		assert.ok(
			stretch >= ranges.stretch[0] - 1e-3 && stretch <= ranges.stretch[1] + 1e-3,
			`${name} stretch ${stretch}`,
		);
		assert.ok(shot.params.my >= 1 && shot.params.my <= 2);
		if (ranges.jpegQuality === null) {
			assert.equal(shot.params.jpegQuality, null);
			assert.equal(shot.format, "png");
		} else {
			within("jpegQuality", ranges.jpegQuality);
			assert.equal(shot.format, "jpg");
		}
		assert.ok(shot.params.dx >= 0 && shot.params.dy >= 0);

		const again = await capture(golden, name, makePrng(5));
		assert.deepEqual(again.params, shot.params, `${name} params drifted`);
		assert.ok(again.buffer.equals(shot.buffer), `${name} bytes drifted`);
	}
});

test("generate writes a manifest matching the contract", async (t) => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "synth-set-"));
	t.after(() => fs.rmSync(out, { recursive: true, force: true }));

	const manifest = await generate({
		out,
		seed: 4,
		perVariant: 1,
		preset: "typical",
		width: 200,
		height: 280,
		quiet: true,
	});

	const onDisk = JSON.parse(
		fs.readFileSync(path.join(out, "manifest.json"), "utf8"),
	);
	assert.deepEqual(onDisk, manifest);

	assert.equal(manifest.version, 1);
	assert.equal(manifest.seed, 4);
	assert.equal(manifest.preset, "typical");
	assert.deepEqual(manifest.golden, {
		path: "golden.png",
		width: 200,
		height: 280,
		source: "synthetic",
	});
	const goldenMeta = await sharp(path.join(out, "golden.png")).metadata();
	assert.equal(goldenMeta.width, 200);
	assert.equal(goldenMeta.height, 280);

	const variantCount = Object.values(FAMILIES).reduce(
		(n, v) => n + v.length,
		0,
	);
	const defectFrames = variantCount * SEVERITIES.length;
	const clean = manifest.cases.filter((c) => c.family === "clean");
	assert.equal(manifest.cases.length - clean.length, defectFrames);
	assert.ok(
		clean.length / manifest.cases.length >= 0.1,
		`only ${clean.length}/${manifest.cases.length} clean frames`,
	);
	// a couple of clean frames at every preset, so capture quality can be
	// swept independently of the defects
	for (const preset of Object.keys(capturePresets)) {
		assert.ok(
			clean.some((c) => c.id.startsWith(`clean-${preset}-`)),
			`no clean frames at preset ${preset}`,
		);
	}

	const ids = new Set();
	const captureKeys = [
		"mx",
		"my",
		"angleDeg",
		"dx",
		"dy",
		"ink",
		"paper",
		"gradient",
		"blurSigma",
		"noiseSigma",
		"jpegQuality",
		"frameWidth",
		"frameHeight",
	];
	for (const c of manifest.cases) {
		assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
		ids.add(c.id);
		assert.match(c.id, /^[a-z-]+-[a-z-]+-[a-z]+-\d{4}$/, c.id);
		assert.ok(
			c.family === "clean" || Object.keys(FAMILIES).includes(c.family),
			c.family,
		);
		assert.ok(c.id.startsWith(`${c.family}-`), `${c.id} vs family ${c.family}`);
		assert.match(c.frame, /^frames\/.+\.(png|jpg)$/);
		assert.equal(c.frame, `frames/${c.id}${path.extname(c.frame)}`);
		const stat = fs.statSync(path.join(out, c.frame));
		assert.ok(stat.size > 0, `${c.frame} is empty`);

		for (const key of captureKeys) {
			assert.ok(key in c.capture, `${c.id} capture is missing ${key}`);
		}
		assert.ok(c.capture.frameWidth > 200 && c.capture.frameHeight > 280);
		assert.ok(c.capture.jpegQuality === null || c.capture.jpegQuality >= 70);

		if (c.family === "clean") {
			assert.deepEqual(c.defects, []);
			assert.deepEqual(c.expected, { pass: true, channels: [] });
			continue;
		}
		assert.equal(c.defects.length, 1);
		const gt = c.defects[0];
		assert.equal(gt.type, c.family);
		assert.ok(FAMILIES[gt.type].includes(gt.variant));
		assert.ok(SEVERITIES.includes(gt.severity));
		assert.ok(["print", "background", "both", "none"].includes(gt.channel));
		assert.equal(c.id, `${gt.type}-${gt.variant}-${gt.severity}-${c.id.slice(-4)}`);
		for (const k of ["x", "y", "w", "h"]) {
			assert.ok(Number.isInteger(gt.bbox[k]), `${c.id} bbox.${k}`);
		}
		assert.ok(gt.bbox.x + gt.bbox.w <= 200 && gt.bbox.y + gt.bbox.h <= 280);
		assert.ok(gt.printPixels >= 0 && gt.backgroundPixels >= 0);
		assert.equal(typeof gt.params, "object");

		// expected is derived from the channels, not from the family name
		const expectedChannels =
			gt.channel === "none"
				? []
				: gt.channel === "both"
					? ["background", "print"]
					: [gt.channel];
		assert.deepEqual(c.expected.channels, expectedChannels, c.id);
		assert.equal(c.expected.pass, gt.channel === "none", c.id);
	}

	// same seed, same set
	const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "synth-set-"));
	t.after(() => fs.rmSync(out2, { recursive: true, force: true }));
	const repeat = await generate({
		out: out2,
		seed: 4,
		perVariant: 1,
		preset: "typical",
		width: 200,
		height: 280,
		quiet: true,
	});
	assert.deepEqual(repeat, manifest);
	const first = manifest.cases[0];
	assert.ok(
		fs
			.readFileSync(path.join(out, first.frame))
			.equals(fs.readFileSync(path.join(out2, first.frame))),
		"the same seed produced different frame bytes",
	);
});
