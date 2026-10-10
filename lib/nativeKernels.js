/**
 * The optional native twins of golden-compare's hottest pool kernels
 * (native/kernels.cc): localField, localApply, binarize, toneCompare and
 * diff. Same arithmetic in the same order, so the same bytes; they only
 * make a frame faster - on the rig a good frame's median went from 67 to
 * 54 ms with them alone.
 *
 * Shipped prebuilt inside the package, in prebuildify's layout:
 *
 *   prebuilds/<platform>-<arch>/vision-kernels[.glibc|.musl].node
 *
 * so there is no install script, nothing to compile, and Node-RED's
 * palette manager and `npm install --ignore-scripts` get the same files.
 * Each binary's size and SHA-256 are in prebuilds/manifest.json, and a
 * binary that does not match is never loaded: dlopen of a truncated
 * shared object can take the process down with SIGBUS before any error
 * reaches JavaScript, and this runs at Node-RED's startup.
 *
 * Anything that stops it loading - no binary for this platform, one that
 * fails its checksum, a Node without N-API 8, a binary from another
 * version of the kernels - leaves the JS kernels in charge, which are the
 * reference anyway. So does VISION_TOOLS_KERNELS=js, for checking the two
 * against each other on one host. VISION_TOOLS_KERNELS=source loads a
 * build from source instead (native/build/Release, `npx node-gyp
 * rebuild`), unchecked, and only then: a stale local build is never
 * picked up by accident. Each pool worker loads its own instance
 * (lib/poolWorker.js); golden-compare.js logs which kernels run, once,
 * from status().
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PREBUILDS = path.join(ROOT, "prebuilds");
const SOURCE_BUILD = path.join(ROOT, "native", "build", "Release", "vision_kernels.node");
// native/kernels.cc VT_KERNELS_ABI: the ctx contract the binary reads
const ABI = 1;
const NAMES = ["localField", "localApply", "binarize", "toneCompare", "diff"];

/** VISION_TOOLS_KERNELS: "js", "source", or "auto" (anything else). */
function mode() {
	const m = String(process.env.VISION_TOOLS_KERNELS || "auto").toLowerCase();
	return m === "js" || m === "source" ? m : "auto";
}

// musl's dynamic loader is where a musl binary's interpreter lives: its
// presence says which of the two Linux builds to try first. Only first -
// a glibc host can have musl installed beside its own libc.
function libc() {
	if (process.platform !== "linux") return "";
	const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
	return fs.existsSync(`/lib/ld-musl-${arch}.so.1`) ? "musl" : "glibc";
}

/** The prebuilds this host could load, best first. */
function candidates() {
	if (mode() === "source") return [SOURCE_BUILD];
	const dir = path.join(PREBUILDS, `${process.platform}-${process.arch}`);
	const tag = libc();
	const tags = tag === "" ? [""] : tag === "musl" ? [".musl", ".glibc"] : [".glibc", ".musl"];
	return tags.map((t) => path.join(dir, `vision-kernels${t}.node`));
}

const shown = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/** Why a prebuild must not be loaded, or null: its size and SHA-256
 * against prebuilds/manifest.json, before dlopen ever sees it. */
function unverified(file) {
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(PREBUILDS, "manifest.json"), "utf8"));
	} catch (err) {
		return `prebuilds/manifest.json: ${err.code || err.message}`;
	}
	const key = path.relative(PREBUILDS, file).split(path.sep).join("/");
	const want = manifest[key];
	if (!want) return "not in prebuilds/manifest.json";
	const bytes = fs.readFileSync(file);
	if (bytes.length !== want.size) return `${bytes.length} bytes, the manifest says ${want.size}`;
	const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== want.sha256) return "its SHA-256 is not the manifest's";
	return null;
}

let loaded;
let reason = null;
// a binary was there and would not load, against there being none
let failed = false;

/**
 * The addon, or null (with the reason in status()). Once per thread: a
 * pool worker is its own thread and loads its own instance.
 */
function load() {
	if (loaded !== undefined) return loaded;
	loaded = null;
	if (mode() === "js") {
		reason = "VISION_TOOLS_KERNELS=js";
		return null;
	}
	const files = candidates().filter((f) => fs.existsSync(f));
	if (files.length === 0) {
		reason =
			mode() === "source"
				? `VISION_TOOLS_KERNELS=source, and no ${shown(SOURCE_BUILD)}`
				: `no prebuilt binary for ${process.platform}-${process.arch}${libc() ? ` (${libc()})` : ""}`;
		return null;
	}
	// the first that loads; the first failure is the one worth reporting
	for (const file of files) {
		try {
			const bad = mode() === "source" ? null : unverified(file);
			if (bad) throw new Error(bad);
			const addon = require(file);
			if (addon.abi !== ABI) throw new Error(`kernel ABI ${addon.abi}, expected ${ABI}`);
			loaded = { addon, file: shown(file) };
			failed = false;
			reason = null;
			return loaded;
		} catch (err) {
			if (!failed) reason = `${shown(file)}: ${err.message.split("\n")[0]}`;
			failed = true;
		}
	}
	return null;
}

/** { native: true, file } or { native: false, reason, failed }: for one
 * log line, a warning when `failed`. */
function status() {
	const k = load();
	return k ? { native: true, file: k.file } : { native: false, reason, failed };
}

// The ctx keys whose buffers are not Uint8Array, by element type: the
// addon checks each view's type, so a key missing here is refused, not
// misread.
const F32 = new Set(["fx", "fy", "spans", "expected"]);
const I16 = new Set(["lo", "hi", "speckLo", "speckHi"]);
const U32 = new Set([
	"next",
	"grey",
	"histP",
	"histK",
	"rowSpecks",
	"blocks",
	"counts",
	"toneCounts",
	"printBlocks",
	"backgroundBlocks",
]);

/** A dispatch's ctx with each shared buffer as the typed view it holds. */
function views(ctx) {
	const out = {};
	for (const key of Object.keys(ctx)) {
		const v = ctx[key];
		if (v instanceof SharedArrayBuffer) {
			const Ctor = F32.has(key) ? Float32Array : I16.has(key) ? Int16Array : U32.has(key) ? Uint32Array : Uint8Array;
			out[key] = new Ctor(v);
		} else if (Array.isArray(v) && v.length > 0 && v[0] instanceof SharedArrayBuffer) {
			out[key] = v.map((b) => new Uint8Array(b));
		} else {
			out[key] = v;
		}
	}
	return out;
}

/**
 * `js` (lib/poolWorker.js's kernels) with the five native ones in place,
 * when the addon loads; else `js` itself. A dispatch the addon refuses -
 * it checks every index it will make before it claims a chunk - runs on
 * the JS kernel, which it has left untouched.
 */
function withNative(js, addon = load() && load().addon) {
	if (!addon) return js;
	const out = { ...js };
	for (const name of NAMES) {
		const fallback = js[name];
		out[name] = (ctx, lo, hi, index) => {
			try {
				addon[name](views(ctx), lo, hi, index);
			} catch (err) {
				if (err.code !== "ERR_VT_KERNEL_CTX") throw err;
				fallback(ctx, lo, hi, index);
			}
		};
	}
	return out;
}

/** Forget the load, for tests that change VISION_TOOLS_KERNELS. */
function _reset() {
	loaded = undefined;
	reason = null;
	failed = false;
}

module.exports = { load, status, withNative, views, candidates, mode, NAMES, ABI, _reset };
