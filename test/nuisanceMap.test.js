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

// ---- identity guards ----------------------------------------------------

function tmpFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuisance-"));
	return path.join(dir, "map.json");
}

async function writeMap(overrides = {}) {
	const file = tmpFile();
	const acc = nuisance.createAccumulator(GW, GH);
	nuisance.accumulate(acc, withArtifact(5, 0.25));
	const baseline = nuisance.finalize(acc);
	const record = {
		...nuisance.buildRecord(baseline, acc, {
			blockSize: 8,
			workingSize: 2125,
			goldenKey: "key:a",
			goldenContentKey: "sha:aaa",
		}),
		...overrides,
	};
	await nuisance.writeNuisanceMap(file, record);
	return file;
}

const EXPECT = {
	goldenKey: "key:a",
	goldenContentKey: "sha:aaa",
	workingSize: 2125,
	blockSize: 8,
};

test("a matching map loads", async () => {
	const file = await writeMap();
	const got = await nuisance.readNuisanceMap(file, EXPECT);
	assert.ok(got && !got.error, got && got.error);
	assert.equal(got.baseline.length, cells);
});

test("no file at all is simply absent, not an error", async () => {
	assert.equal(
		await nuisance.readNuisanceMap(path.join(os.tmpdir(), "nope-xyz.json"), EXPECT),
		null,
	);
	assert.equal(await nuisance.readNuisanceMap("", EXPECT), null);
});

test("a map trained at another blockSize is refused", async () => {
	const file = await writeMap({ blockSize: 16 });
	const got = await nuisance.readNuisanceMap(file, EXPECT);
	assert.match(got.error, /trained at blockSize 16/);
});

test("a map trained at another workingSize is refused", async () => {
	const file = await writeMap({ workingSize: 2656 });
	const got = await nuisance.readNuisanceMap(file, EXPECT);
	assert.match(got.error, /trained at workingSize 2656/);
});

test("a map whose grid does not fit this comparison is refused", async () => {
	const file = await writeMap();
	const got = await nuisance.readNuisanceMap(file, {
		...EXPECT,
		gridW: 185,
		gridH: 266,
	});
	assert.match(got.error, /grid is 6x4/);
});

test("a map trained against a different golden is refused", async () => {
	const file = await writeMap({ goldenKey: "key:b", goldenContentKey: "sha:bbb" });
	const got = await nuisance.readNuisanceMap(file, EXPECT);
	assert.match(got.error, /different golden/);
});

test("the same golden delivered another way is recognised by content", async () => {
	// cheap keys disagree - one arrived as a buffer, one as a path - but the
	// content hash settles it, exactly as the trained transform does
	const file = await writeMap({ goldenKey: "buf:1", goldenContentKey: "sha:aaa" });
	const got = await nuisance.readNuisanceMap(file, {
		...EXPECT,
		goldenKey: "path:/x:1:2",
		goldenContentKey: async () => "sha:aaa",
	});
	assert.ok(got && !got.error, got && got.error);
});

test("a future map version is refused rather than misread", async () => {
	const file = await writeMap({ version: 99 });
	const got = await nuisance.readNuisanceMap(file, EXPECT);
	assert.match(got.error, /version 99/);
});

test("corrupt JSON is reported, not thrown", async () => {
	const file = tmpFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{not json");
	const got = await nuisance.readNuisanceMap(file, EXPECT);
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
