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
 *    reported box is checked against the changed pixels found here by a
 *    plain scan, because a generator that mislabels its own output
 *    produces a benchmark that is confidently wrong;
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

const { makePrng } = require("../lib/synth/prng.js");
const { syntheticLabelRaster } = require("../lib/synth/label.js");
const {
	applyDefect,
	applyDefects,
	FAMILIES,
	SEVERITIES,
	CHANGE_FLOOR,
} = require("../lib/synth/defects.js");
const { capture, capturePresets } = require("../lib/synth/capture.js");
const { generate } = require("../bench/synth/generate.js");

const W = 300;
const H = 420;

let goldenPromise = null;
function smallGolden() {
	if (!goldenPromise) goldenPromise = syntheticLabelRaster(W, H, 3);
	return goldenPromise;
}

/** Every pixel index where `after` differs from `before`. */
function changedPixels(before, after) {
	const out = [];
	for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) out.push(i);
	return out;
}

/**
 * The reported box must hold every changed pixel, and must not be larger
 * than they are: slack 0, so each of its four edges has a changed pixel
 * on it. Checked by containment and by edge, not by recomputing the box.
 */
function assertBoxFits(box, changed, width, where) {
	let top = false;
	let bottom = false;
	let left = false;
	let right = false;
	for (const i of changed) {
		const x = i % width;
		const y = (i - x) / width;
		assert.ok(
			x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h,
			`${where}: changed pixel ${x},${y} is outside the box ${JSON.stringify(box)}`,
		);
		if (y === box.y) top = true;
		if (y === box.y + box.h - 1) bottom = true;
		if (x === box.x) left = true;
		if (x === box.x + box.w - 1) right = true;
	}
	assert.ok(top && bottom && left && right, `${where}: box ${JSON.stringify(box)} is looser than its pixels`);
}

/** What each channel label promises about the two counts. */
const CHANNEL_COUNTS = {
	print: (p, b) => p > 0 && b === 0,
	background: (p, b) => p === 0 && b > 0,
	both: (p, b) => p > 0 && b > 0,
	none: (p, b) => p === 0 && b === 0,
};

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
});

test("every defect's ground truth is what it did to the pixels", async () => {
	const golden = await smallGolden();
	for (const [type, variant] of everyVariant) {
		for (const severity of ["small", "large"]) {
			const spec = { type, variant, severity };
			const result = applyDefect(golden, spec, makePrng(91));
			const changed = changedPixels(golden.data, result.data);
			const where = `${type}/${variant}/${severity}`;
			// score.js groups its results by these three
			assert.deepEqual([result.gt.type, result.gt.variant, result.gt.severity], [type, variant, severity], where);
			assert.ok(changed.length > 0, `${where} changed nothing`);
			assertBoxFits(result.gt.bbox, changed, W, where);
			assert.equal(result.gt.params.changedPixels, changed.length, `${where} changed count`);
			const { printPixels: p, backgroundPixels: b, channel } = result.gt;
			// the channel counts are a subset of the changed pixels
			// The golden is two-level (0 ink, 255 paper - the label test pins
			// that), so the plain reading: an ink pixel made lighter by at
			// least the change floor is print lost, a paper pixel made darker
			// by at least the floor is background ink. Smaller moves are
			// neither, which is what a faint stain does.
			let ownPrint = 0;
			let ownBackground = 0;
			for (const i of changed) {
				const was = golden.data[i];
				const now = result.data[i];
				if (was === 0 && now - was >= CHANGE_FLOOR) ownPrint++;
				if (was === 255 && was - now >= CHANGE_FLOOR) ownBackground++;
			}
			assert.equal(p, ownPrint, `${where}: printPixels ${p}, but ${ownPrint} ink pixels lightened by >= ${CHANGE_FLOOR}`);
			assert.equal(b, ownBackground, `${where}: backgroundPixels ${b}, but ${ownBackground} paper pixels darkened by >= ${CHANGE_FLOOR}`);
			assert.ok(CHANNEL_COUNTS[channel](p, b), `${where}: channel ${channel} with print ${p}, background ${b}`);
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
	// the same two defects applied by hand, one prng shared as applyDefects does
	const prng = makePrng(11);
	const first = applyDefect(golden, list[0], prng);
	const second = applyDefect(first, list[1], prng);
	assert.deepEqual(stacked.data, second.data, "the stack is the second defect on the first's output");

	const firstChanged = changedPixels(golden.data, first.data);
	assertBoxFits(stacked.gt[0].bbox, firstChanged, W, "ink");
	assert.equal(stacked.gt[0].params.changedPixels, firstChanged.length);
	// the second is diffed against the first's output, not the original
	const secondChanged = changedPixels(first.data, stacked.data);
	assertBoxFits(stacked.gt[1].bbox, secondChanged, W, "streak");
	assert.equal(stacked.gt[1].params.changedPixels, secondChanged.length);
	assert.notEqual(
		secondChanged.length,
		changedPixels(golden.data, stacked.data).length,
		"fixture: the two diffs must differ for this to tell them apart",
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
	}
});

test("the same seed generates the same set", async (t) => {
	const run = async () => {
		const out = fs.mkdtempSync(path.join(os.tmpdir(), "synth-seed-"));
		t.after(() => fs.rmSync(out, { recursive: true, force: true }));
		const manifest = await generate({ out, seed: 9, perVariant: 1, preset: "clean-rig", width: 80, height: 112, quiet: true });
		return { out, manifest };
	};
	const a = await run();
	const b = await run();
	assert.deepEqual(b.manifest, a.manifest);
	for (const file of ["golden.png", ...a.manifest.cases.map((c) => c.frame)]) {
		assert.ok(
			fs.readFileSync(path.join(a.out, file)).equals(fs.readFileSync(path.join(b.out, file))),
			`the same seed wrote different bytes for ${file}`,
		);
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
		for (const k of ["x", "y", "w", "h"]) {
			assert.ok(Number.isInteger(gt.bbox[k]), `${c.id} bbox.${k}`);
		}
		assert.ok(gt.bbox.x + gt.bbox.w <= 200 && gt.bbox.y + gt.bbox.h <= 280);
		assert.ok(gt.printPixels >= 0 && gt.backgroundPixels >= 0);

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
});
