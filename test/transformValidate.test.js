/**
 * validateTransformRecord (lib/transformFile.js): the checks readTransformFile
 * applies, usable on a record that came out of a profile instead of its own
 * file, plus the strict content-key mode a profile reader uses.
 *
 * The case strict mode exists for: under a named golden (`key:<n>`) a new
 * render keeps its name, so the cheap keys agree and the old record used to
 * be accepted unchecked against new artwork.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const {
	readTransformFile,
	validateTransformRecord,
	writeTransformFile,
} = require("../lib/transformFile.js");

const RECORD = {
	scaleX: 1.1284,
	scaleY: 0.9671,
	goldenKey: "key:demo",
	goldenContentKey: "sha1:aaaa",
	workingSize: 2125,
};

const EXPECT = {
	goldenKey: "key:demo",
	goldenContentKey: "sha1:aaaa",
	workingSize: 2125,
};

const made = [];
test.after(() =>
	Promise.all(made.map((d) => fsp.rm(d, { recursive: true, force: true }))),
);

async function viaFile(record, expect) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xform-validate-"));
	made.push(dir);
	const file = path.join(dir, "transform.json");
	await writeTransformFile(file, record);
	return readTransformFile(file, expect);
}

test("validate agrees with read on accepted and refused records", async () => {
	const cases = [
		[RECORD, EXPECT],
		[RECORD, { ...EXPECT, workingSize: 3072 }],
		[
			{ ...RECORD, goldenKey: "buf:1" },
			{ ...EXPECT, goldenKey: "path:/x:1:2" },
		],
		[
			{ ...RECORD, goldenKey: "buf:1" },
			{
				...EXPECT,
				goldenKey: "path:/x:1:2",
				goldenContentKey: async () => "sha1:bbbb",
			},
		],
		[{ ...RECORD, scaleX: 1e308 }, EXPECT],
		[{ ...RECORD, scaleY: 0 }, EXPECT],
		[RECORD, undefined],
		[
			RECORD,
			{ ...EXPECT, goldenContentKey: "sha1:other", strictContentKey: true },
		],
	];
	for (const [record, expect] of cases) {
		const fromFile = await viaFile(record, expect);
		const direct = await validateTransformRecord(
			JSON.parse(JSON.stringify(record)),
			expect,
		);
		assert.deepEqual(direct, fromFile);
	}
});

test("a non-object record is refused, not thrown on", async () => {
	for (const bad of [null, [], "x", 3]) {
		const got = await validateTransformRecord(bad, EXPECT);
		assert.match(got.error, /not a JSON object/);
	}
});

test("by default a matching cheap key is trusted without comparing content", async () => {
	// today's behaviour, pinned: same name, different bytes, accepted
	const got = await validateTransformRecord(RECORD, {
		...EXPECT,
		goldenContentKey: "sha1:new-render",
	});
	assert.equal(got.error, undefined);
	assert.equal(got.scaleX, RECORD.scaleX);
});

test("strict mode refuses the same cheap key with different content", async () => {
	const got = await validateTransformRecord(RECORD, {
		...EXPECT,
		goldenContentKey: async () => "sha1:new-render",
		strictContentKey: true,
	});
	assert.match(got.error, /different golden content/);
	assert.match(got.error, /sha1:aaaa vs sha1:new-render/);
	assert.equal(got.scaleX, undefined);
});

test("strict mode accepts matching content and still checks working size", async () => {
	const ok = await validateTransformRecord(RECORD, {
		...EXPECT,
		strictContentKey: true,
	});
	assert.equal(ok.error, undefined);
	assert.equal(ok.scaleY, RECORD.scaleY);
	assert.equal(ok.record, RECORD);

	const size = await validateTransformRecord(RECORD, {
		...EXPECT,
		workingSize: 3072,
		strictContentKey: true,
	});
	assert.match(size.error, /workingSize/);
});

test("strict mode refuses when content cannot be established on either side", async () => {
	const { goldenContentKey: _drop, ...noContent } = RECORD;
	const old = await validateTransformRecord(noContent, {
		...EXPECT,
		strictContentKey: true,
	});
	assert.match(old.error, /no goldenContentKey/);

	const unresolved = await validateTransformRecord(RECORD, {
		...EXPECT,
		goldenContentKey: async () => {
			throw new Error("golden vanished");
		},
		strictContentKey: true,
	});
	assert.match(unresolved.error, /could not be resolved/);

	// no cheap key on either side: strict still compares content
	const { goldenKey: _k, ...noKey } = RECORD;
	const bare = await validateTransformRecord(noKey, {
		goldenContentKey: "sha1:other",
		strictContentKey: true,
	});
	assert.match(bare.error, /different golden content/);
});

test("strict mode with differing cheap keys behaves as the default does", async () => {
	const record = { ...RECORD, goldenKey: "buf:1" };
	const expect = { ...EXPECT, goldenKey: "path:/x:1:2" };
	assert.deepEqual(
		await validateTransformRecord(record, {
			...expect,
			strictContentKey: true,
		}),
		await validateTransformRecord(record, expect),
	);
});
