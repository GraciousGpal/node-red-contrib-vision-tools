/**
 * Which OpenCV engine backs lib/labelCrop.js and lib/nativeSeed.js.
 *
 * Two implementations of the same op surface:
 *
 *   "own"       - @graciousstar/opencv5 (lib/opencv5.js): our N-API addon
 *                 over a minimal static OpenCV 5, its own package with a
 *                 prebuilt binary per platform (built so far: linux-x64
 *                 glibc and musl, win32-x64), each checked against its
 *                 manifest before it is opened. Built for the arch's
 *                 baseline only (x86-64-v2, NEON), so it runs on any CPU of
 *                 its arch and gives the same bytes on all of them.
 *   "opencv-js" - lib/cvjs.js, the stock opencv.js WASM build. Loads
 *                 anywhere Node does, but runs single-threaded on the event
 *                 loop: about 4x slower on a bare alignment, 30x inside
 *                 golden-compare.
 *
 * Default is "auto": own where its binary loads, opencv-js otherwise.
 * VISION_TOOLS_ENGINE=own or =opencv-js pins one, and a pinned engine that
 * cannot load is an error, never a substitution. "native" - the rosepetal
 * addon this package used up to 1.2 - is read as "auto": a setting that
 * asked for the old addon gets the new one where it loads and keeps its
 * fallback where it does not.
 *
 * Both engines load synchronously, so candidate() is the answer; resolve()
 * and warmup() remain for callers written when one engine loaded behind a
 * promise.
 */

"use strict";

const MODES = new Set(["auto", "own", "opencv-js"]);
// what an older configuration may still say
const ALIASES = { native: "auto" };

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
			// `passedOver`: why an engine before this one did not load
			return { engine: LOADERS[name](), name, error: null, passedOver: errors.join("; ") || null };
		} catch (err) {
			errors.push(`${name}: ${err.message}`);
		}
	}
	return { engine: null, name: null, error: new Error(errors.join("; ")), passedOver: null };
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

/** What a log or a status calls an engine. */
function label(name) {
	return name === "own" ? "opencv5" : name === "opencv-js" ? "opencv.js" : "none";
}

const logged = new Set();

/**
 * One line, once per process and caller, saying which OpenCV engine
 * serves `who` (a node type): info for opencv5; a warning when opencv.js
 * answers because opencv5 did not load - slower, and its alignment is a
 * different implementation, so verdicts near a threshold can differ from
 * the ones a rig was tuned on; a warning when there is none.
 */
function logEngine(log, who) {
	if (!log || logged.has(who)) return;
	logged.add(who);
	const s = candidate();
	const say = (level, text) => {
		if (typeof log[level] === "function") log[level](text);
	};
	if (!s.engine) {
		say("warn", `${who}: no OpenCV engine - ${s.error.message}`);
	} else if (s.name === "own") {
		say("info", `${who}: OpenCV engine opencv5`);
	} else if (s.passedOver) {
		say(
			"warn",
			`${who}: OpenCV engine opencv.js, because opencv5 did not load (${s.passedOver}) - ` +
				"slower, and its alignment differs from opencv5's, so verdicts near a threshold can change",
		);
	} else {
		say("info", `${who}: OpenCV engine opencv.js (VISION_TOOLS_ENGINE=${mode()})`);
	}
}

/** Test seam: forget the cached selection. */
function _reset() {
	candidateCache = undefined;
	logged.clear();
}

module.exports = { engine, warmup, candidate, resolve, mode, label, logEngine, _reset };
