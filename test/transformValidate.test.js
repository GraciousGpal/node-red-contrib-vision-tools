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

// One table for both entry points: readTransformFile is a JSON read in
// front of validateTransformRecord, so every row must give the same answer
// through each, and that answer is checked here once. `error: null` means
// accepted with the record's own scales.
const { goldenContentKey: _noContent, ...PRE_CONTENT } = RECORD;
const CASES = [
	{ name: "same golden, same working size", record: RECORD, expect: EXPECT, error: null },
	{ name: "no expectation at all", record: RECORD, expect: undefined, error: null },
	// Training through msg.golden and then running from goldenPath is the
	// documented flow; the cheap keys differ, the content settles it.
	{
		name: "same golden delivered a different way",
		record: { ...RECORD, goldenKey: "buf:0d93201f" },
		expect: {
			...EXPECT,
			goldenKey: "path:/data/golden/artwork.png:1788011451282:11070",
			goldenContentKey: async () => "sha1:aaaa",
		},
		error: null,
	},
	{
		name: "different golden, record predates content keys",
		record: { ...PRE_CONTENT, goldenKey: "buf:1" },
		expect: { ...EXPECT, goldenKey: "path:/x:1:2" },
		error: /different golden \(buf:1 vs path:\/x:1:2\).*predates content-keyed training/,
	},
	{
		name: "different golden, content resolver throws",
		record: { ...RECORD, goldenKey: "buf:1" },
		expect: {
			...EXPECT,
			goldenKey: "path:/x:1:2",
			goldenContentKey: async () => {
				throw new Error("golden vanished");
			},
		},
		error: /different golden \(buf:1 vs path:\/x:1:2\) - retrain it$/,
	},
	{
		name: "different golden content",
		record: { ...RECORD, goldenKey: "buf:1" },
		expect: {
			...EXPECT,
			goldenKey: "path:/x:1:2",
			goldenContentKey: async () => "sha1:bbbb",
		},
		error: /different golden content \(sha1:aaaa vs sha1:bbbb\) - retrain/,
	},
	{
		name: "trained at another working size",
		record: RECORD,
		expect: { ...EXPECT, workingSize: 3072 },
		error: /workingSize 2125, now running at 3072/,
	},
	{
		name: "scaleY missing",
		record: { scaleX: 1.9, goldenKey: "k" },
		expect: EXPECT,
		error: /no usable scaleX\/scaleY/,
	},
	{
		name: "zero and negative scales",
		record: { ...RECORD, scaleX: 0, scaleY: -1 },
		expect: EXPECT,
		error: /no usable scaleX\/scaleY/,
	},
	// Regression: 1e308 is a finite positive double. It was accepted, then
	// reached the pinned search as centerX = -Infinity and halfRange =
	// Infinity - a synchronous infinite loop that froze the whole process.
	{
		name: "absurd but finite scale (1e308), the freeze regression",
		record: { ...RECORD, scaleX: 1e308, scaleY: 1e308 },
		expect: EXPECT,
		error: /within 0\.05\.\.100/,
	},
	{
		name: "scale below the physical range",
		record: { ...RECORD, scaleX: 0.01, scaleY: 2 },
		expect: EXPECT,
		error: /within 0\.05\.\.100/,
	},
	{
		name: "scale above the physical range",
		record: { ...RECORD, scaleX: 2, scaleY: 500 },
		expect: EXPECT,
		error: /within 0\.05\.\.100/,
	},
	{
		name: "strict mode, same cheap key, other content",
		record: RECORD,
		expect: { ...EXPECT, goldenContentKey: "sha1:other", strictContentKey: true },
		error: /different golden content \(sha1:aaaa vs sha1:other\)/,
	},
];

test("read and validate give the same, expected answer for every record", async () => {
	const failures = [];
	for (const { name, record, expect, error } of CASES) {
		try {
			const fromFile = await viaFile(record, expect);
			const direct = await validateTransformRecord(
				JSON.parse(JSON.stringify(record)),
				expect,
			);
			assert.deepEqual(direct, fromFile, "read and validate disagree");
			if (error) {
				assert.match(String(direct.error), error);
				assert.equal(direct.scaleX, undefined, "refused but returned scales");
			} else {
				assert.equal(direct.error, undefined);
				assert.equal(direct.scaleX, record.scaleX);
				assert.equal(direct.scaleY, record.scaleY);
			}
		} catch (err) {
			failures.push(`${name}: ${err.message.split("\n")[0]}`);
		}
	}
	assert.deepEqual(failures, []);
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
