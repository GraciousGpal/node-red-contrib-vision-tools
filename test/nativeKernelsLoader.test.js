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
const nativeKernels = require("../lib/nativeKernels.js");
const { loadNode } = require("./helpers/fakeRed.js");

const LOADER = path.join(__dirname, "..", "lib", "nativeKernels.js");

/** status() and whether withNative kept the JS table, in a fresh process. */
function probe(loader, { env = {}, before = "" } = {}) {
	const script = `${before}
		const k = require(${JSON.stringify(loader)});
		const js = { diff() {} };
		process.stdout.write(JSON.stringify({ status: k.status(), jsKept: k.withNative(js) === js }));`;
	const out = execFileSync(process.execPath, ["-e", script], {
		env: { ...process.env, VISION_TOOLS_KERNELS: "", ...env },
		encoding: "utf8",
	});
	return JSON.parse(out);
}

/** A package tree with only the loader and a binary of `bytes` where this host would look. */
function treeWithBinary(bytes) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vt-kernels-"));
	fs.mkdirSync(path.join(root, "lib"));
	fs.copyFileSync(LOADER, path.join(root, "lib", "nativeKernels.js"));
	const dir = path.join(root, "prebuilds", `${process.platform}-${process.arch}`);
	fs.mkdirSync(dir, { recursive: true });
	const tags = process.platform === "linux" ? [".glibc", ".musl"] : [""];
	for (const tag of tags) fs.writeFileSync(path.join(dir, `vision-kernels${tag}.node`), bytes);
	return root;
}

test("VISION_TOOLS_KERNELS=js keeps the JS kernels without loading anything", () => {
	const r = probe(LOADER, { env: { VISION_TOOLS_KERNELS: "JS" } });
	assert.deepEqual(r.status, { native: false, reason: "VISION_TOOLS_KERNELS=js", failed: false });
	assert.ok(r.jsKept);
});

test("a platform with no prebuilt binary keeps the JS kernels, and says which platform", () => {
	// this host's binaries in the tree, none for the platform asked about
	const root = treeWithBinary(Buffer.from("not a shared library"));
	try {
		const r = probe(path.join(root, "lib", "nativeKernels.js"), {
			before: `Object.defineProperty(process, "platform", { value: "aix" });`,
		});
		assert.equal(r.status.native, false);
		assert.equal(r.status.failed, false);
		assert.match(r.status.reason, new RegExp(`^no prebuilt binary for aix-${process.arch}`));
		assert.ok(r.jsKept);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a binary that will not load keeps the JS kernels, and is reported as a failure", () => {
	const root = treeWithBinary(Buffer.from("not a shared library"));
	try {
		const r = probe(path.join(root, "lib", "nativeKernels.js"));
		assert.equal(r.status.native, false);
		assert.equal(r.status.failed, true);
		assert.match(r.status.reason, /^prebuilds\/[^/]+\/vision-kernels(\.glibc|\.musl)?\.node: /);
		assert.ok(r.jsKept);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a binary built for another kernel ABI is refused", () => {
	const root = treeWithBinary(Buffer.alloc(0));
	try {
		// stands in for an addon from another version of the package
		const fake = `require.extensions[".node"] = (m) => { m.exports = { abi: 99, diff() {} }; };`;
		const r = probe(path.join(root, "lib", "nativeKernels.js"), { before: fake });
		assert.equal(r.status.failed, true);
		assert.match(r.status.reason, /kernel ABI 99, expected 1$/);
		assert.ok(r.jsKept);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
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
