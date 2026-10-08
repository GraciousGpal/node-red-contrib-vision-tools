/**
 * Per-golden profile store (lib/profileStore.js).
 *
 * What is worth pinning: that a flow-supplied name can never become a
 * path, that the id falls back from name to source file to content in that
 * order, that two kinds of training writing one file do not erase each
 * other - including when they arrive concurrently, which is what Node-RED
 * does with overlapping input handlers - and that a write leaves no
 * temporary files behind.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const store = require("../lib/profileStore.js");

const HEX = "0123456789abcdef0123456789abcdef01234567";
const KEY = `sha1:${HEX}`;

const made = [];
const tmpDir = async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "profile-store-"));
	made.push(dir);
	return dir;
};

test.after(() =>
	Promise.all(made.map((d) => fsp.rm(d, { recursive: true, force: true }))),
);

test("a profile name is lower-cased and stripped of anything path-like", () => {
	assert.equal(store.sanitizeProfileName("Line A"), "line_a");
	assert.equal(store.sanitizeProfileName("  Demo-60.v2  "), "demo-60.v2");
	assert.equal(store.sanitizeProfileName("../../etc/passwd"), "_.._etc_passwd");
	assert.equal(store.sanitizeProfileName("C:\\x\\y"), "c__x_y");
	assert.equal(store.sanitizeProfileName("...hidden"), "hidden");
	assert.equal(store.sanitizeProfileName("x".repeat(100)).length, 64);
});

test("Windows reserved base names are prefixed so the file can exist", () => {
	assert.equal(store.sanitizeProfileName("CON"), "_con");
	assert.equal(store.sanitizeProfileName("aux"), "_aux");
	assert.equal(store.sanitizeProfileName("com7"), "_com7");
	assert.equal(store.sanitizeProfileName("LPT1.v2"), "_lpt1.v2");
	// only the exact base names are reserved
	assert.equal(store.sanitizeProfileName("console"), "console");
	assert.equal(store.sanitizeProfileName("com10"), "com10");
});

test("a name with nothing usable left is treated as not given", () => {
	assert.equal(store.sanitizeProfileName(""), null);
	assert.equal(store.sanitizeProfileName("   "), null);
	assert.equal(store.sanitizeProfileName("...."), null);
	assert.equal(store.sanitizeProfileName(null), null);
	assert.equal(store.sanitizeProfileName(42), null);
	assert.equal(store.sanitizeProfileName({ path: "x" }), null);
});

test("the source stem comes from Windows and POSIX paths alike", () => {
	assert.equal(
		store.sourceStem("/data/Inspection/pdf/Demo_Good_60.pdf"),
		"demo_good_60",
	);
	assert.equal(
		store.sourceStem("C:\\Users\\op\\Inspection\\Demo_Good_60.pdf"),
		"demo_good_60",
	);
	// mixed separators, as a path typed on Windows and read in a container
	assert.equal(store.sourceStem("C:\\golden/sub\\Art.png"), "art");
});

test("only the last extension is stripped, whatever its case", () => {
	assert.equal(store.sourceStem("/g/label.pdf"), "label");
	assert.equal(store.sourceStem("/g/LABEL.PNG"), "label");
	assert.equal(store.sourceStem("/g/label.v2.pdf"), "label.v2");
	assert.equal(store.sourceStem("Demo_Good_60"), "demo_good_60");
	assert.equal(store.sourceStem("Demo_Good_60.pdf"), "demo_good_60");
	// a dotfile has no extension to strip, and its leading dot goes
	assert.equal(store.sourceStem("/g/.golden"), "golden");
});

test("a page suffix is appended only past page 1", () => {
	assert.equal(store.sourceStem("/g/art.pdf", 1), "art");
	assert.equal(store.sourceStem("/g/art.pdf", 17), "art-p17");
	assert.equal(store.sourceStem("/g/art.pdf", "3"), "art-p3");
	assert.equal(store.sourceStem("/g/art.pdf", 0), "art");
	assert.equal(store.sourceStem("/g/art.pdf", null), "art");
	assert.equal(store.sourceStem("/g/art.pdf", 2.5), "art");
	// a long stem is cut to leave room for the suffix, not the suffix cut off
	const long = store.sourceStem(`/g/${"x".repeat(80)}.pdf`, 12);
	assert.equal(long.length, 64);
	assert.ok(long.endsWith("-p12"));
});

test("no usable source gives no stem", () => {
	assert.equal(store.sourceStem(""), null);
	assert.equal(store.sourceStem("/data/golden/"), null);
	assert.equal(store.sourceStem(undefined), null);
	assert.equal(store.sourceStem(Buffer.from("x")), null);
});

test("the id comes from the content key, with the raw suffix when present", () => {
	assert.deepEqual(store.profileIdFor({ contentKey: KEY }), {
		id: "0123456789abcdef",
		namedBy: "content",
	});
	assert.deepEqual(store.profileIdFor({ contentKey: `${KEY}:2950x4250x4` }), {
		id: "0123456789abcdef-2950x4250x4",
		namedBy: "content",
	});
});

test("precedence is name, then source, then content", () => {
	const all = {
		name: "Line A",
		source: "/g/Art.pdf",
		page: 2,
		contentKey: KEY,
	};
	assert.deepEqual(store.profileIdFor(all), {
		id: "line_a",
		namedBy: "profile",
	});
	assert.deepEqual(store.profileIdFor({ ...all, name: undefined }), {
		id: "art-p2",
		namedBy: "source",
	});
	// an unusable name falls through rather than winning
	assert.deepEqual(store.profileIdFor({ ...all, name: "..." }), {
		id: "art-p2",
		namedBy: "source",
	});
	assert.deepEqual(store.profileIdFor({ contentKey: KEY, source: "" }), {
		id: "0123456789abcdef",
		namedBy: "content",
	});
});

test("nothing usable at all throws", () => {
	assert.throws(() => store.profileIdFor({}), /no usable profile name/);
	assert.throws(
		() => store.profileIdFor({ contentKey: "buf:abc" }),
		/no usable/,
	);
	assert.throws(
		() => store.profileIdFor({ name: "", contentKey: "sha1:12" }),
		/no usable/,
	);
});

test("profilePath joins the directory and the id", () => {
	assert.equal(
		store.profilePath("/data/p", "line_a"),
		path.join("/data/p", "line_a.json"),
	);
});

test("a section round-trips with the golden record and a matching stat", async () => {
	const file = store.profilePath(
		path.join(await tmpDir(), "nested", "dir"),
		"art",
	);
	const golden = {
		contentKey: KEY,
		key: "path:/g/art.pdf:1:2",
		label: null,
		source: "/g/art.pdf",
		page: null,
		namedBy: "source",
		nativeWidth: 2950,
		nativeHeight: 4250,
	};
	const wrote = await store.writeProfileSection(
		file,
		"transform",
		{ scaleX: 1.1 },
		golden,
	);
	assert.equal(wrote.profile.version, 1);
	assert.deepEqual(wrote.profile.golden, golden);
	assert.deepEqual(wrote.profile.transform, { scaleX: 1.1 });
	assert.ok(!Number.isNaN(Date.parse(wrote.profile.updatedAt)));

	const st = await fsp.stat(file);
	assert.deepEqual(wrote.stat, { mtimeMs: st.mtimeMs, size: st.size });

	const read = await store.readProfile(file);
	assert.deepEqual(read.profile, wrote.profile);
	assert.deepEqual(read.stat, wrote.stat);
});

test("two sections written separately keep each other, and golden merges", async () => {
	const file = store.profilePath(await tmpDir(), "art");
	await store.writeProfileSection(
		file,
		"transform",
		{ scaleX: 1.1 },
		{
			contentKey: KEY,
			key: "k1",
			source: "/g/art.pdf",
			page: 1,
			namedBy: "source",
		},
	);
	const second = await store.writeProfileSection(
		file,
		"nuisance",
		{ frames: 40 },
		{ key: "k2", page: undefined, label: "Line A" },
	);
	assert.deepEqual(second.profile.transform, { scaleX: 1.1 });
	assert.deepEqual(second.profile.nuisance, { frames: 40 });
	assert.deepEqual(second.profile.golden, {
		contentKey: KEY,
		key: "k2",
		source: "/g/art.pdf",
		page: 1,
		namedBy: "source",
		label: "Line A",
	});
	// rewriting one section replaces it and leaves the other alone
	const third = await store.writeProfileSection(file, "transform", {
		scaleX: 2.2,
	});
	assert.deepEqual(third.profile.transform, { scaleX: 2.2 });
	assert.deepEqual(third.profile.nuisance, { frames: 40 });
	assert.equal(third.profile.golden.key, "k2");
	assert.deepEqual((await store.readProfile(file)).profile, third.profile);
});

// Node-RED runs input handlers concurrently. Without the per-path chain
// every one of these would read the empty file, add its own section and
// rename over the others: one section would survive out of ten.
test("ten concurrent writes of different sections all land", async () => {
	const dir = await tmpDir();
	const file = store.profilePath(dir, "art");
	const results = await Promise.all(
		Array.from({ length: 10 }, (_, i) =>
			store.writeProfileSection(file, `s${i}`, { i }, { contentKey: KEY }),
		),
	);
	const { profile } = await store.readProfile(file);
	for (let i = 0; i < 10; i++) assert.deepEqual(profile[`s${i}`], { i });
	// writes were applied in call order, so the last result is the file
	assert.deepEqual(results[9].profile, profile);
	// and the same path spelled differently shares the chain: a redundant
	// "./" segment, and on Windows the other separator and another case
	const spellings = [path.join(dir, ".", "x", "..") + path.sep + "art.json"];
	if (process.platform === "win32") {
		spellings.push(file.split(path.sep).join("/"), file.toUpperCase());
	}
	await Promise.all([
		store.writeProfileSection(file, "a", 1),
		...spellings.map((p, i) => store.writeProfileSection(p, `b${i}`, i)),
	]);
	const after = (await store.readProfile(file)).profile;
	assert.equal(after.a, 1);
	spellings.forEach((_, i) => assert.equal(after[`b${i}`], i));
	assert.deepEqual(
		(await fsp.readdir(dir)).filter((n) => n.includes(".tmp-")),
		[],
		"no temporary file may be left behind",
	);
});

test("a failed write removes its temporary file and does not wedge the next", async () => {
	const dir = await tmpDir();
	const file = store.profilePath(dir, "art");
	await store.writeProfileSection(file, "transform", { ok: true });
	// fail the rename, after the tmp file has been written: a code that is
	// not retried, so the failure is final on every platform
	const fsPromises = require("node:fs").promises;
	const realRename = fsPromises.rename;
	let tmpSeen = null;
	fsPromises.rename = async (from) => {
		fsPromises.rename = realRename;
		tmpSeen = from;
		assert.ok(fs.existsSync(from), "the tmp file exists when rename runs");
		const err = new Error("EXDEV: cross-device link not permitted");
		err.code = "EXDEV";
		throw err;
	};
	try {
		await assert.rejects(
			store.writeProfileSection(file, "bad", { ok: false }),
			/EXDEV/,
		);
	} finally {
		fsPromises.rename = realRename;
	}
	assert.ok(tmpSeen && tmpSeen.includes(".tmp-"), "the rename was reached");
	assert.equal(fs.existsSync(tmpSeen), false, "the tmp file was removed");
	const next = await store.writeProfileSection(file, "nuisance", { ok: true });
	assert.deepEqual(next.profile.transform, { ok: true });
	assert.equal(next.profile.bad, undefined);
	assert.deepEqual(
		(await fsp.readdir(dir)).filter((n) => n.includes(".tmp-")),
		[],
	);
});

test("the store's own keys are not section names", async () => {
	const file = store.profilePath(await tmpDir(), "art");
	for (const bad of ["version", "golden", "updatedAt", "", null]) {
		await assert.rejects(
			store.writeProfileSection(file, bad, {}),
			/section name/,
		);
	}
	await assert.rejects(
		store.writeProfileSection("", "transform", {}),
		/no file path/,
	);
});

test("an unreadable profile is reported, never overwritten", async () => {
	const dir = await tmpDir();
	const cases = [
		["{ not json", /not readable JSON/],
		[JSON.stringify({ version: 2, transform: {} }), /version 2/],
		[JSON.stringify([1, 2]), /not a JSON object/],
		["null", /not a JSON object/],
	];
	for (const [i, [text, re]] of cases.entries()) {
		const file = path.join(dir, `p${i}.json`);
		await fsp.writeFile(file, text);
		const got = await store.readProfile(file);
		assert.match(got.error, re);
		assert.equal(got.profile, undefined);
		await assert.rejects(store.writeProfileSection(file, "transform", {}), re);
		assert.equal(await fsp.readFile(file, "utf8"), text, "left as it was");
	}
});

test("no file is simply absent, not an error", async () => {
	assert.equal(
		await store.readProfile(path.join(await tmpDir(), "nope.json")),
		null,
	);
	assert.equal(await store.readProfile(""), null);
});
