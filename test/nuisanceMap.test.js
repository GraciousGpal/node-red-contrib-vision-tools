/**
 * Trained nuisance map (lib/nuisanceMap.js).
 *
 * The properties worth pinning are the ones a wrong answer would be
 * expensive for: that a recurring artifact is actually suppressed, that a
 * blemish on clean substrate is not, that one contaminated training frame
 * cannot blind a cell, and that a map which does not belong to this
 * comparison is refused rather than quietly applied.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const nuisance = require("../lib/nuisanceMap.js");

const GW = 6;
const GH = 4;
const cells = GW * GH;

function grid(fill = 0) {
	return new Float32Array(cells).fill(fill);
}

/** A grid with a fixed artifact at `artifactIdx` and nothing else. */
function withArtifact(idx, value) {
	const g = grid();
	g[idx] = value;
	return g;
}

function trainOn(frames) {
	const acc = nuisance.createAccumulator(GW, GH);
	for (const f of frames) nuisance.accumulate(acc, f);
	return nuisance.finalize(acc);
}

test("a recurring artifact is suppressed, a novel blemish is not", () => {
	// 20 good frames, all dirty at cell 5 and nowhere else
	const baseline = trainOn(Array.from({ length: 20 }, () => withArtifact(5, 0.25)));

	// the same artifact on a new frame scores ~0
	const same = nuisance.excessOver(withArtifact(5, 0.25), baseline);
	assert.ok(
		same.worst < 0.01,
		`recurring artifact should score ~0, got ${same.worst}`,
	);

	// an identical density somewhere clean scores its full value
	const novel = nuisance.excessOver(withArtifact(11, 0.25), baseline);
	assert.ok(
		novel.worst > 0.24,
		`novel blemish should score its density, got ${novel.worst}`,
	);
});

test("a defect darker than the artifact still scores its excess", () => {
	const baseline = trainOn(Array.from({ length: 20 }, () => withArtifact(5, 0.25)));
	// the same location, but markedly worse than it has ever been
	const worse = nuisance.excessOver(withArtifact(5, 0.9), baseline);
	assert.ok(
		Math.abs(worse.worst - 0.65) < 0.01,
		`expected ~0.65 of excess, got ${worse.worst}`,
	);
});

test("one contaminated training frame cannot blind a cell", () => {
	// 19 clean frames and one that carries a defect at cell 7
	const frames = Array.from({ length: 19 }, () => grid());
	frames.push(withArtifact(7, 0.8));
	const baseline = trainOn(frames);
	// DEFAULT_DROP discards the single worst frame per cell, so cell 7's
	// baseline comes from the clean frames and the defect is still visible
	assert.ok(
		baseline[7] < 0.01,
		`one bad frame should not raise the baseline, got ${baseline[7]}`,
	);
	const seen = nuisance.excessOver(withArtifact(7, 0.8), baseline);
	assert.ok(seen.worst > 0.79, `defect should remain visible, got ${seen.worst}`);
});

test("two contaminated frames do raise it - the limit is documented, not hidden", () => {
	const frames = Array.from({ length: 18 }, () => grid());
	frames.push(withArtifact(7, 0.8));
	frames.push(withArtifact(7, 0.8));
	const baseline = trainOn(frames);
	assert.ok(
		baseline[7] > 0.79,
		`the second bad frame is expected to set the baseline, got ${baseline[7]}`,
	);
});

test("with no baseline at all, excess is just the density", () => {
	const g = withArtifact(3, 0.4);
	const { worst } = nuisance.excessOver(g, null);
	assert.equal(worst, Math.fround(0.4));
});

test("a very short training run still produces a usable baseline", () => {
	// frames <= drop would read an empty slot and suppress nothing
	const baseline = trainOn([withArtifact(2, 0.5)]);
	assert.ok(baseline[2] > 0.49, `single-frame training should still fill, got ${baseline[2]}`);
});

test("accumulate refuses a grid that is not the shape it was created for", () => {
	const acc = nuisance.createAccumulator(GW, GH);
	assert.throws(
		() => nuisance.accumulate(acc, new Float32Array(cells - 1)),
		/expected a 6x4 density grid/,
	);
});

test("a baseline survives the encode/decode round trip within a byte", () => {
	const baseline = trainOn([withArtifact(4, 0.375), withArtifact(4, 0.375)]);
	const decoded = nuisance.decodeBaseline(
		nuisance.encodeBaseline(baseline),
		cells,
	);
	for (let i = 0; i < cells; i++) {
		assert.ok(
			Math.abs(decoded[i] - baseline[i]) <= 1 / 255,
			`cell ${i}: ${decoded[i]} vs ${baseline[i]}`,
		);
	}
});

test("a truncated baseline is refused, not silently padded", () => {
	assert.equal(nuisance.decodeBaseline("AAAA", cells), null);
});

// ---- the map file -------------------------------------------------------
// The identity guards (blockSize, workingSize, grid, golden, version) are
// one table in test/nuisanceValidate.test.js, run through both
// readNuisanceMap and validateNuisanceRecord. What only the file read does
// stays here.

const made = [];
test.after(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

test("no file at all is simply absent, not an error", async () => {
	assert.equal(
		await nuisance.readNuisanceMap(path.join(os.tmpdir(), "nope-xyz.json"), {}),
		null,
	);
	assert.equal(await nuisance.readNuisanceMap("", {}), null);
});

test("corrupt JSON is reported, not thrown", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuisance-"));
	made.push(dir);
	const file = path.join(dir, "map.json");
	fs.writeFileSync(file, "{not json");
	const got = await nuisance.readNuisanceMap(file, {});
	assert.match(got.error, /not readable JSON/);
});

test("the density transport round-trips within a byte", () => {
	const g = grid();
	for (let i = 0; i < cells; i++) g[i] = i / cells;
	const back = nuisance.dequantizeDensity(nuisance.quantizeDensity(g));
	for (let i = 0; i < cells; i++) {
		assert.ok(Math.abs(back[i] - g[i]) <= 1 / 255, `cell ${i}`);
	}
});
