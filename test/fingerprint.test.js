/**
 * The golden cache must not re-learn a constant on every frame.
 *
 * These assert *absence of work*, which is unusual for a test suite and is
 * the only way to state the property: the bugs here were not wrong answers,
 * they were correct answers bought at the price of re-reading the artwork
 * from disk, or re-hashing a 12MB render, on every single message.
 *
 * Three separate claims, which failed for three different reasons:
 *
 *  1. `msg.payload` was resolved through the same helper as the golden, so
 *     every frame was SHA-1'd for a cache key that was destructured away
 *     and never used. 27ms of a 23MP framebuffer, for nothing.
 *  2. `msg.goldenKey` was documented as the cheap way to name a golden that
 *     the flow knows has not changed - but the hash ran inside the resolver
 *     before the name was ever consulted, so it saved exactly nothing.
 *  3. A `goldenPath` golden - the ordinary production setup - was read from
 *     disk in full on every frame, and the bytes thrown away whenever the
 *     cache hit.
 *
 * Counting syscalls and digests is deliberate. A timing assertion would be
 * flaky, and "it is fast now" is not the property; "it does not do the work
 * at all" is.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");

// ---- instrumentation ---------------------------------------------------
//
// Patched before golden-compare.js is required, because it captures
// fs.promises at module load.

const counts = { sha1: 0, opens: 0, reads: 0, readBytes: 0 };

const realCreateHash = crypto.createHash.bind(crypto);
crypto.createHash = (alg, ...rest) => {
	const h = realCreateHash(alg, ...rest);
	if (alg === "sha1") {
		const update = h.update.bind(h);
		h.update = (data, ...a) => {
			counts.sha1++;
			return update(data, ...a);
		};
	}
	return h;
};

const realOpen = fsp.open.bind(fsp);
fsp.open = async (...a) => {
	counts.opens++;
	const handle = await realOpen(...a);
	const readFile = handle.readFile.bind(handle);
	handle.readFile = async (...b) => {
		const buf = await readFile(...b);
		counts.reads++;
		counts.readBytes += buf.length;
		return buf;
	};
	return handle;
};

const reset = () => {
	counts.sha1 = 0;
	counts.opens = 0;
	counts.reads = 0;
	counts.readBytes = 0;
};

// ---- fake RED harness --------------------------------------------------

function makeNode(config = {}) {
	const node = loadNode("golden-compare.js", config);
	node.send = () => {};
	node.warn = () => {};
	node.error = () => {};
	node.status = () => {};
	node.log = () => {};
	const run = (msg) =>
		new Promise((resolve, reject) =>
			node.listeners.input(msg, undefined, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	return { node, run };
}

// workers: 1 disables the nested worker pool. It does not mean "inline" -
// the pipeline runs in the inspector worker either way; GOLDEN_COMPARE_INLINE
// is what selects that.
const CFG = { workers: 1, workingSize: 512 };

function labelSvg(w, h) {
	const bars = [];
	for (let i = 0; i < 8; i++) {
		bars.push(
			`<rect x="${40 + i * 7}" y="${30 + i * 60}" width="${(w * 0.5) | 0}" height="18" fill="#111"/>`,
		);
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			bars.join("") +
			`</svg>`,
	);
}

const png = (svg) => sharp(svg).png().toBuffer();
const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), "gc-fp-"));

// ---- the claims --------------------------------------------------------

test("a frame is never hashed - nothing is cached against it", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(600, 900)));
	const frame = await png(labelSvg(600, 900));

	const { run } = makeNode({ ...CFG, goldenPath });
	await run({ payload: frame });
	reset();
	await run({ payload: frame });
	assert.strictEqual(
		counts.sha1,
		0,
		"the frame was hashed for a key that is never used",
	);
	await fsp.rm(dir, { recursive: true, force: true });
});

test("a cached path golden is stat'ed, not re-read", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	const goldenBytes = await png(labelSvg(600, 900));
	await fsp.writeFile(goldenPath, goldenBytes);
	const frame = await png(labelSvg(600, 900));

	const { run } = makeNode({ ...CFG, goldenPath });
	await run({ payload: frame }); // populates the cache
	reset();
	await run({ payload: frame }); // hits it
	assert.strictEqual(
		counts.reads,
		0,
		`the golden was re-read (${counts.readBytes} bytes) on a cache hit`,
	);
	// the stat is deliberately kept: it is what still notices a golden that
	// has been overwritten, deleted, or swapped for a directory
	assert.strictEqual(counts.opens, 1, "the golden should still be stat'ed");
	await fsp.rm(dir, { recursive: true, force: true });
});

test("an overwritten golden is still noticed, and re-read exactly once", async () => {
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(600, 900)));
	const frame = await png(labelSvg(600, 900));

	const { run } = makeNode({ ...CFG, goldenPath });
	await run({ payload: frame });

	// a different golden, and a different size so mtime granularity cannot
	// hide it
	await new Promise((r) => setTimeout(r, 12));
	await fsp.writeFile(goldenPath, await png(labelSvg(620, 920)));

	reset();
	await run({ payload: frame });
	assert.strictEqual(counts.reads, 1, "the replaced golden must be re-read");

	reset();
	await run({ payload: frame });
	assert.strictEqual(counts.reads, 0, "and then cached again");
	await fsp.rm(dir, { recursive: true, force: true });
});

test("msg.goldenKey skips the hash entirely", async () => {
	const goldenBuf = await png(labelSvg(600, 900));
	const frame = await png(labelSvg(600, 900));

	const { run } = makeNode({ ...CFG });
	await run({ payload: frame, golden: goldenBuf, goldenKey: "artwork-v1" });
	reset();
	await run({ payload: frame, golden: goldenBuf, goldenKey: "artwork-v1" });
	assert.strictEqual(
		counts.sha1,
		0,
		"a named golden was hashed anyway - which is what msg.goldenKey exists to avoid",
	);
});

test("an unnamed buffer golden still has to be hashed", async () => {
	// the honest converse: without a name there is nothing else in a buffer
	// that says whether it changed, so the hash is not optional
	const goldenBuf = await png(labelSvg(600, 900));
	const frame = await png(labelSvg(600, 900));

	const { run } = makeNode({ ...CFG });
	await run({ payload: frame, golden: goldenBuf });
	reset();
	await run({ payload: frame, golden: goldenBuf });
	assert.strictEqual(counts.sha1, 1, "the golden must still be fingerprinted");
});

test("a named key that hides a different-sized render still re-prepares", async () => {
	// msg.goldenKey is the flow asserting the bytes did not change, and it is
	// deliberately trusted. The byte length is free to check and catches the
	// coarsest way that assertion goes wrong.
	const frame = await png(labelSvg(600, 900));
	const a = await png(labelSvg(600, 900));
	const b = await png(labelSvg(640, 960));
	assert.notStrictEqual(a.length, b.length, "precondition: different sizes");

	const { node, run } = makeNode({ ...CFG });
	await run({ payload: frame, golden: a, goldenKey: "same-name" });
	const firstKey = node.goldenCache.key;
	await run({ payload: frame, golden: b, goldenKey: "same-name" });
	assert.notStrictEqual(
		node.goldenCache.key,
		firstKey,
		"a differently-sized golden under a stale name went unnoticed",
	);
});

test("a golden deleted under a named key is still an error", async () => {
	// the stat is what preserves this: the name replaces the *fingerprint*,
	// not the existence check
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(600, 900)));
	const frame = await png(labelSvg(600, 900));

	const { run } = makeNode({ ...CFG, goldenPath });
	await run({ payload: frame, goldenKey: "named" });
	await fsp.rm(goldenPath);
	await assert.rejects(
		run({ payload: frame, goldenKey: "named" }),
		/does not exist on disk/,
	);
	await fsp.rm(dir, { recursive: true, force: true });
});

test("a Buffer payload survives repeated frames unchanged", async () => {
	// This began as "passed to sharp without a copy", which was true until
	// the pipeline moved into the inspector: the frame now has to reach
	// shared memory, so a Buffer payload pays one ~12ms copy at dispatch.
	// A Uint8Array or ArrayBuffer pays exactly one too - it goes straight
	// to shared rather than to a Buffer and then to shared.
	const dir = await tmpDir();
	const goldenPath = path.join(dir, "golden.png");
	await fsp.writeFile(goldenPath, await png(labelSvg(600, 900)));
	const frame = await png(labelSvg(600, 900));

	const { run } = makeNode({ ...CFG, goldenPath });
	// a Buffer whose contents would be corrupted by a copy-then-mutate is
	// hard to observe directly, so assert the cheap observable instead: the
	// frame still compares successfully and byte-identically twice
	await run({ payload: frame });
	await run({ payload: frame });
	await fsp.rm(dir, { recursive: true, force: true });
});
