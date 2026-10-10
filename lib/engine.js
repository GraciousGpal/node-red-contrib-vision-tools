/**
 * Which OpenCV engine backs lib/labelCrop.js and lib/nativeSeed.js.
 *
 * Two implementations of the same op surface:
 *
 *   "own"       - @graciousstar/opencv5 (lib/opencv5.js): our N-API addon
 *                 over a minimal static OpenCV 5, its own package with
 *                 prebuilt binaries for linux x64/arm64 (glibc 2.17+ and
 *                 musl), win32-x64 and darwin x64/arm64, each checked
 *                 against its manifest before it is opened. Built for the
 *                 arch's baseline only (x86-64-v2, NEON), so it runs on any
 *                 CPU of its arch and gives the same bytes on all.
 *   "opencv-js" - lib/cvjs.js, the stock opencv.js WASM build. Loads
 *                 anywhere Node does, but runs single-threaded on the event
 *                 loop and is 20-30x slower at golden-compare's alignment.
 *
 * Default is "auto": own where its binary loads, opencv-js otherwise.
 * VISION_TOOLS_ENGINE=own or =opencv-js pins one, and a pinned engine that
 * cannot load is an error, never a substitution. "native" - the rosepetal
 * addon this package used up to 1.2 - is read as "own", its replacement.
 *
 * Both engines load synchronously, so candidate() is the answer; resolve()
 * and warmup() remain for callers written when one engine loaded behind a
 * promise.
 */

"use strict";

const MODES = new Set(["auto", "own", "opencv-js"]);
// what an older configuration may still say
const ALIASES = { native: "own" };

let candidateCache;

/** VISION_TOOLS_ENGINE, normalised: "auto", "own" or "opencv-js". */
function mode() {
	const raw = String(process.env.VISION_TOOLS_ENGINE || "auto").toLowerCase();
	const name = ALIASES[raw] || raw;
	return MODES.has(name) ? name : "auto";
}

function loadOwn() {
	const own = require("./opencv5.js");
	own.load(); // throws with the reason when no binary loads
	return own;
}

function loadCvjs() {
	const cvjs = require("./cvjs.js");
	if (!cvjs.available()) {
		throw new Error(
			"@techstark/opencv-js is not installed (npm i @techstark/opencv-js)",
		);
	}
	const { imageAlign } = require("./cvjsAlign.js");
	return {
		colorConvert: cvjs.colorConvert,
		resize: cvjs.resize,
		filter: cvjs.filter,
		crop: cvjs.crop,
		rotate: cvjs.rotate,
		imageAlign,
		ready: cvjs.ready,
	};
}

const LOADERS = { own: loadOwn, "opencv-js": loadCvjs };

function select(order) {
	const errors = [];
	for (const name of order) {
		try {
			return { engine: LOADERS[name](), name, error: null };
		} catch (err) {
			errors.push(`${name}: ${err.message}`);
		}
	}
	return { engine: null, name: null, error: new Error(errors.join("; ")) };
}

/**
 * The engine. Cached.
 *
 * @returns {{engine: object|null, name: string|null, error: Error|null}}
 */
function candidate() {
	if (candidateCache === undefined) {
		const want = mode();
		candidateCache = select(want === "auto" ? ["own", "opencv-js"] : [want]);
	}
	return candidateCache;
}

/** candidate(), as a promise. */
function resolve() {
	return Promise.resolve(candidate());
}

/** The engine object, or null. */
function engine() {
	return candidate().engine;
}

/**
 * Settle the choice and initialise whatever the engine needs before its
 * first op (the WASM instantiate is ~200ms), so a node calling this at
 * startup keeps it off the first frame. Safe to call repeatedly, and when
 * no engine loaded.
 *
 * @returns {Promise<string|null>} the engine name that will serve ops
 */
async function warmup() {
	const selected = candidate();
	if (selected.engine && typeof selected.engine.ready === "function") {
		try {
			await selected.engine.ready();
		} catch {
			/* reported at the first op */
		}
	}
	return selected.name;
}

/** Test seam: forget the cached selection. */
function _reset() {
	candidateCache = undefined;
}

module.exports = { engine, warmup, candidate, resolve, mode, _reset };
