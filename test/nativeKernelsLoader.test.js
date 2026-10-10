/**
 * The native kernels are optional: whatever stops them loading must leave
 * the JS kernels running, with one line saying why, and nothing else. Each
 * case runs in its own process, since the loader decides once per thread.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const nativeKernels = require("../lib/nativeKernels.js");
const { loadNode } = require("./helpers/fakeRed.js");

const LOADER = path.join(__dirname, "..", "lib", "nativeKernels.js");

// stands in for dlopen: a .node "loads" as an addon of this ABI, and
// every attempt is counted, so a test can tell a file was never opened
const FAKE_DLOPEN = (abi) =>
	`globalThis.dlopened = 0; require.extensions[".node"] = (m) => { globalThis.dlopened++; m.exports = { abi: ${abi}, diff() {} }; };`;

/** status(), whether withNative kept the JS table, and how many .node
 * files were opened (with FAKE_DLOPEN), in a fresh process. */
function probe(loader, { env = {}, before = "" } = {}) {
	const script = `${before}
		const k = require(${JSON.stringify(loader)});
		const js = { diff() {} };
		process.stdout.write(JSON.stringify({ status: k.status(), jsKept: k.withNative(js) === js, dlopened: globalThis.dlopened }));`;
	const out = execFileSync(process.execPath, ["-e", script], {
		env: { ...process.env, VISION_TOOLS_KERNELS: "", ...env },
		encoding: "utf8",
	});
	return JSON.parse(out);
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * A package tree with only the loader and a binary of `bytes` where this
 * host would look, listed in prebuilds/manifest.json as `listed` (the
 * same bytes by default; null leaves it out).
 */
function treeWithBinary(bytes, listed = bytes) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vt-kernels-"));
	fs.mkdirSync(path.join(root, "lib"));
	fs.copyFileSync(LOADER, path.join(root, "lib", "nativeKernels.js"));
	const sub = `${process.platform}-${process.arch}`;
	fs.mkdirSync(path.join(root, "prebuilds", sub), { recursive: true });
	const tags = process.platform === "linux" ? [".glibc", ".musl"] : [""];
	const manifest = {};
	for (const tag of tags) {
		fs.writeFileSync(path.join(root, "prebuilds", sub, `vision-kernels${tag}.node`), bytes);
		if (listed) manifest[`${sub}/vision-kernels${tag}.node`] = { size: listed.length, sha256: sha256(listed) };
	}
	fs.writeFileSync(path.join(root, "prebuilds", "manifest.json"), JSON.stringify(manifest));
	return root;
}

function inTree(bytes, listed, fn) {
	const root = treeWithBinary(bytes, listed);
	try {
		return fn(path.join(root, "lib", "nativeKernels.js"), root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("VISION_TOOLS_KERNELS=js keeps the JS kernels without loading anything", () => {
	const r = probe(LOADER, { env: { VISION_TOOLS_KERNELS: "JS" } });
	assert.deepEqual(r.status, { native: false, reason: "VISION_TOOLS_KERNELS=js", failed: false });
	assert.ok(r.jsKept);
});

test("a platform with no prebuilt binary keeps the JS kernels, and says which platform", () => {
	// this host's binaries in the tree, none for the platform asked about
	inTree(Buffer.from("not a shared library"), undefined, (loader) => {
		const r = probe(loader, { before: `Object.defineProperty(process, "platform", { value: "aix" });` });
		assert.equal(r.status.native, false);
		assert.equal(r.status.failed, false);
		assert.match(r.status.reason, new RegExp(`^no prebuilt binary for aix-${process.arch}`));
		assert.ok(r.jsKept);
	});
});

test("a binary that will not load keeps the JS kernels, and is reported as a failure", () => {
	inTree(Buffer.from("not a shared library"), undefined, (loader) => {
		const r = probe(loader);
		assert.equal(r.status.native, false);
		assert.equal(r.status.failed, true);
		assert.match(r.status.reason, /^prebuilds\/[^/]+\/vision-kernels(\.glibc|\.musl)?\.node: /);
		assert.ok(r.jsKept);
	});
});

test("a binary that is not the manifest's is never opened", () => {
	// dlopen of a truncated shared object can SIGBUS the whole process
	const good = crypto.randomBytes(4096);
	for (const [bytes, listed, why] of [
		[good.subarray(0, 1000), good, /: 1000 bytes, the manifest says 4096$/],
		[Buffer.from(good).fill(1, 100, 200), good, /: its SHA-256 is not the manifest's$/],
		[good, null, /: not in prebuilds\/manifest\.json$/],
	]) {
		inTree(bytes, listed, (loader) => {
			const r = probe(loader, { before: FAKE_DLOPEN(1) });
			assert.equal(r.dlopened, 0, "opened");
			assert.equal(r.status.failed, true);
			assert.match(r.status.reason, why);
			assert.ok(r.jsKept);
		});
	}
	// and the same bytes, listed, are
	inTree(good, good, (loader) => {
		const r = probe(loader, { before: FAKE_DLOPEN(1) });
		assert.equal(r.dlopened, 1);
		assert.equal(r.status.native, true);
		assert.equal(r.jsKept, false);
	});
});

test("a binary built for another kernel ABI is refused", () => {
	inTree(Buffer.alloc(0), undefined, (loader) => {
		const r = probe(loader, { before: FAKE_DLOPEN(99) });
		assert.equal(r.status.failed, true);
		assert.match(r.status.reason, /kernel ABI 99, expected 1$/);
		assert.ok(r.jsKept);
	});
});

test("a build from source is loaded only when VISION_TOOLS_KERNELS=source asks for it", () => {
	inTree(Buffer.from("x"), null, (loader, root) => {
		fs.mkdirSync(path.join(root, "native", "build", "Release"), { recursive: true });
		fs.writeFileSync(path.join(root, "native", "build", "Release", "vision_kernels.node"), "local");
		// not by default: the prebuild, unlisted here, is all it looks at
		const plain = probe(loader, { before: FAKE_DLOPEN(1) });
		assert.equal(plain.dlopened, 0);
		assert.match(plain.status.reason, /not in prebuilds\/manifest\.json$/);
		const source = probe(loader, { before: FAKE_DLOPEN(1), env: { VISION_TOOLS_KERNELS: "source" } });
		assert.deepEqual(source.status, { native: true, file: "native/build/Release/vision_kernels.node" });
		fs.rmSync(path.join(root, "native"), { recursive: true });
		const none = probe(loader, { env: { VISION_TOOLS_KERNELS: "source" } });
		assert.match(none.status.reason, /^VISION_TOOLS_KERNELS=source, and no native\/build\/Release\/vision_kernels\.node$/);
	});
});

test("the shipped manifest lists every shipped binary at its size and hash", () => {
	const dir = path.join(__dirname, "..", "prebuilds");
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
	const shipped = [];
	for (const sub of fs.readdirSync(dir)) {
		if (!fs.statSync(path.join(dir, sub)).isDirectory()) continue;
		for (const name of fs.readdirSync(path.join(dir, sub))) shipped.push(`${sub}/${name}`);
	}
	assert.deepEqual(Object.keys(manifest).sort(), shipped.sort());
	for (const key of shipped) {
		const bytes = fs.readFileSync(path.join(dir, key));
		assert.deepEqual(manifest[key], { size: bytes.length, sha256: sha256(bytes) }, key);
	}
});

test("withNative runs the addon, falls back on a refused dispatch only, and rethrows anything else", () => {
	const calls = [];
	const js = {};
	for (const name of nativeKernels.NAMES) js[name] = () => calls.push(`js ${name}`);
	js.histogram = () => calls.push("js histogram");
	const refused = Object.assign(new Error("bad ctx"), { code: "ERR_VT_KERNEL_CTX" });
	const addon = {
		localField: () => calls.push("native localField"),
		localApply: () => {
			throw refused;
		},
		binarize: () => {
			throw new Error("crashed");
		},
		toneCompare: () => calls.push("native toneCompare"),
		diff: (ctx, lo, hi, index) => calls.push(`native diff ${index}`),
	};
	const run = nativeKernels.withNative(js, addon);
	const ctx = { width: 3, gray: new SharedArrayBuffer(4), fx: new SharedArrayBuffer(8) };
	run.localField(ctx, 0, 1, 0);
	run.localApply(ctx, 0, 1, 0);
	run.diff(ctx, 0, 1, 2);
	run.histogram(ctx, 0, 1, 0);
	assert.throws(() => run.binarize(ctx, 0, 1, 0), /crashed/);
	assert.deepEqual(calls, ["native localField", "js localApply", "native diff 2", "js histogram"]);
});

test("the addon is handed each buffer as the typed view it holds", () => {
	const ctx = {
		fx: new SharedArrayBuffer(8),
		lo: new SharedArrayBuffer(4),
		counts: new SharedArrayBuffer(8),
		gray: new SharedArrayBuffer(3),
		darkest: [new SharedArrayBuffer(2)],
		width: 7,
		golden: null,
	};
	const v = nativeKernels.views(ctx);
	assert.ok(v.fx instanceof Float32Array && v.fx.length === 2);
	assert.ok(v.lo instanceof Int16Array && v.lo.length === 2);
	assert.ok(v.counts instanceof Uint32Array && v.counts.length === 2);
	assert.ok(v.gray instanceof Uint8Array && v.gray.length === 3);
	assert.ok(v.darkest[0] instanceof Uint8Array);
	assert.equal(v.width, 7);
	assert.equal(v.golden, null);
});

test("golden-compare says once which kernels it runs", () => {
	const lines = [];
	const log = { info: (m) => lines.push(["info", m]), warn: (m) => lines.push(["warn", m]) };
	loadNode("golden-compare.js", {}, { log });
	assert.equal(lines.length, 1, JSON.stringify(lines));
	const k = nativeKernels.status();
	const [level, text] = lines[0];
	assert.equal(level, k.failed ? "warn" : "info");
	assert.ok(text.includes(k.native ? k.file : k.reason), text);
});
