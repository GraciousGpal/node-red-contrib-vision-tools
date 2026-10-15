/**
 * validateNuisanceRecord (lib/nuisanceMap.js): the checks readNuisanceMap
 * applies, usable on the `nuisance` section of a profile, plus the strict
 * content-key mode. Same reasoning as test/transformValidate.test.js: a
 * named golden re-rendered under its old name agrees on the cheap key, and
 * only the content can tell the map no longer belongs to it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const nuisance = require("../lib/nuisanceMap.js");

const GW = 6;
const GH = 4;

function record(overrides = {}) {
	const acc = nuisance.createAccumulator(GW, GH);
	const g = new Float32Array(GW * GH);
	g[5] = 0.25;
	nuisance.accumulate(acc, g);
	return {
		...nuisance.buildRecord(nuisance.finalize(acc), acc, {
			blockSize: 8,
			workingSize: 2125,
			goldenKey: "key:demo",
			goldenContentKey: "sha1:aaaa",
		}),
		...overrides,
	};
}

const EXPECT = {
	goldenKey: "key:demo",
	goldenContentKey: "sha1:aaaa",
	workingSize: 2125,
	blockSize: 8,
};

const made = [];
test.after(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

async function viaFile(rec, expect) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuisance-validate-"));
	made.push(dir);
	const file = path.join(dir, "map.json");
	await nuisance.writeNuisanceMap(file, rec);
	return nuisance.readNuisanceMap(file, expect);
}

// One table for both entry points: readNuisanceMap is a JSON read in front
// of validateNuisanceRecord, so every row must give the same answer through
// each, and that answer is checked here once. `error: null` means accepted
// with a full baseline.
const CASES = [
	{ name: "matching map", rec: record(), expect: EXPECT, error: null },
	{ name: "no expectation at all", rec: record(), expect: undefined, error: null },
	{
		name: "trained at another blockSize",
		rec: record({ blockSize: 16 }),
		expect: EXPECT,
		error: /trained at blockSize 16, now running at 8/,
	},
	{
		name: "trained at another workingSize",
		rec: record({ workingSize: 2656 }),
		expect: EXPECT,
		error: /trained at workingSize 2656, now running at 2125/,
	},
	{
		name: "grid does not fit this comparison",
		rec: record(),
		expect: { ...EXPECT, gridW: 185, gridH: 266 },
		error: /grid is 6x4, this comparison needs 185x266/,
	},
	{
		name: "trained against a different golden",
		rec: record({ goldenKey: "key:b", goldenContentKey: "sha1:bbbb" }),
		expect: EXPECT,
		error: /different golden \(key:b vs key:demo\)/,
	},
	// cheap keys disagree - one arrived as a buffer, one as a path - but
	// the content hash settles it, exactly as the trained transform does
	{
		name: "same golden delivered another way",
		rec: record({ goldenKey: "buf:1" }),
		expect: {
			...EXPECT,
			goldenKey: "path:/x:1:2",
			goldenContentKey: async () => "sha1:aaaa",
		},
		error: null,
	},
	{
		name: "future map version",
		rec: record({ version: 99 }),
		expect: EXPECT,
		error: /version 99/,
	},
	{
		name: "truncated baseline",
		rec: record({ baseline: "AAAA" }),
		expect: EXPECT,
		error: /baseline is truncated or corrupt/,
	},
	{
		name: "strict mode, same cheap key, other content",
		rec: record(),
		expect: { ...EXPECT, goldenContentKey: "sha1:other", strictContentKey: true },
		error: /different golden content \(sha1:aaaa vs sha1:other\)/,
	},
];

test("read and validate give the same, expected answer for every map", async () => {
	const failures = [];
	for (const { name, rec, expect, error } of CASES) {
		try {
			const fromFile = await viaFile(rec, expect);
			const direct = await nuisance.validateNuisanceRecord(
				JSON.parse(JSON.stringify(rec)),
				expect,
			);
			assert.deepEqual(direct, fromFile, "read and validate disagree");
			if (error) {
				assert.match(String(direct.error), error);
				assert.equal(direct.baseline, undefined, "refused but returned a baseline");
			} else {
				assert.equal(direct.error, undefined);
				assert.equal(direct.baseline.length, GW * GH);
			}
		} catch (err) {
			failures.push(`${name}: ${err.message.split("\n")[0]}`);
		}
	}
	assert.deepEqual(failures, []);
});

test("a non-object record is refused, not thrown on", async () => {
	for (const bad of [null, [], "x", 3]) {
		const got = await nuisance.validateNuisanceRecord(bad, EXPECT);
		assert.match(got.error, /not a JSON object/);
	}
});

test("by default a matching cheap key is trusted without comparing content", async () => {
	const got = await nuisance.validateNuisanceRecord(record(), {
		...EXPECT,
		goldenContentKey: "sha1:new-render",
	});
	assert.ok(got && !got.error, got && got.error);
	assert.equal(got.baseline.length, GW * GH);
});

test("strict mode refuses the same cheap key with different content", async () => {
	const got = await nuisance.validateNuisanceRecord(record(), {
		...EXPECT,
		goldenContentKey: async () => "sha1:new-render",
		strictContentKey: true,
	});
	assert.match(got.error, /different golden content/);
	assert.equal(got.baseline, undefined);
});

test("strict mode accepts matching content and keeps the other checks", async () => {
	const ok = await nuisance.validateNuisanceRecord(record(), {
		...EXPECT,
		strictContentKey: true,
	});
	assert.ok(ok && !ok.error, ok && ok.error);

	const block = await nuisance.validateNuisanceRecord(
		record({ blockSize: 16 }),
		{
			...EXPECT,
			strictContentKey: true,
		},
	);
	assert.match(block.error, /blockSize 16/);
});

test("strict mode refuses when content cannot be established", async () => {
	const old = await nuisance.validateNuisanceRecord(
		record({ goldenContentKey: undefined }),
		{ ...EXPECT, strictContentKey: true },
	);
	assert.match(old.error, /no goldenContentKey/);

	const unresolved = await nuisance.validateNuisanceRecord(record(), {
		...EXPECT,
		goldenContentKey: async () => {
			throw new Error("golden vanished");
		},
		strictContentKey: true,
	});
	assert.match(unresolved.error, /could not be resolved/);
});
