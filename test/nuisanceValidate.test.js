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

test("validate agrees with read on accepted and refused maps", async () => {
	const cases = [
		[record(), EXPECT],
		[record({ blockSize: 16 }), EXPECT],
		[record({ workingSize: 2656 }), EXPECT],
		[record(), { ...EXPECT, gridW: 185, gridH: 266 }],
		[record({ goldenKey: "key:b", goldenContentKey: "sha1:bbbb" }), EXPECT],
		[record({ goldenKey: "buf:1" }), { ...EXPECT, goldenKey: "path:/x:1:2" }],
		[record({ version: 99 }), EXPECT],
		[record({ baseline: "AAAA" }), EXPECT],
		[record(), undefined],
		[
			record(),
			{ ...EXPECT, goldenContentKey: "sha1:other", strictContentKey: true },
		],
	];
	for (const [rec, expect] of cases) {
		const fromFile = await viaFile(rec, expect);
		const direct = await nuisance.validateNuisanceRecord(
			JSON.parse(JSON.stringify(rec)),
			expect,
		);
		assert.deepEqual(direct, fromFile);
	}
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
