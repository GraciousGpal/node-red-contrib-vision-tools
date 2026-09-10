/**
 * Which OpenCV engine backs lib/labelCrop.js and lib/nativeSeed.js.
 *
 * Two implementations of the same op surface:
 *
 *   "native"    - @rosepetal/node-red-contrib-image-tools' cpp-bridge, a
 *                 native OpenCV addon. Fastest, threads properly, and the
 *                 only one benchmarked on the rig; prebuilt for linux-x64,
 *                 linux-arm64, linuxmusl-x64, darwin-x64 and darwin-arm64,
 *                 and unavailable anywhere else (notably win32).
 *   "opencv-js" - lib/cvjs.js, the stock opencv.js WASM build. Loads
 *                 anywhere Node does, needs no toolchain and no prebuilt
 *                 binary, but runs single-threaded on the event loop.
 *
 * Default is "auto": native where it actually works, opencv-js otherwise,
 * so an existing Linux deployment keeps the engine it was measured with
 * and a machine without a native build still runs. Set VISION_TOOLS_ENGINE
 * to "native" or "opencv-js" to pin one - pinning is how you benchmark the
 * two against each other on the same host.
 *
 * DETECTING THE NATIVE ENGINE IS ASYNCHRONOUS. Its require() always
 * succeeds and returns a full set of functions; the addon is loaded behind
 * a promise, and on an unsupported platform every op rejects at call time
 * instead. So there are two answers here:
 *
 *   candidate()  - synchronous, best effort. Gates native on the platform
 *                  list, which is what catches win32 before anything is
 *                  called. Use where an answer is needed now (a node's
 *                  status, a test skip).
 *   resolve()    - asynchronous and authoritative. Probes the addon (see
 *                  probeNative) and demotes to opencv-js if it did not
 *                  load - the case of a supported platform whose optional
 *                  binary was never installed. Use on the op path.
 */

"use strict";

const NATIVE_PATH =
	"@rosepetal/node-red-contrib-image-tools/node-red-contrib-image-tools/lib/cpp-bridge.js";

const MODES = new Set(["auto", "native", "opencv-js"]);

// Mirrors SUPPORTED_PLATFORMS in the bridge. musl is not distinguishable
// synchronously, so linuxmusl-x64 rides on linux-x64 here and, if the
// binary turns out to be missing, resolve() demotes it.
const NATIVE_PLATFORMS = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
]);

let candidateCache;
let resolvedCache;
let resolvePromise;

function mode() {
	const raw = String(process.env.VISION_TOOLS_ENGINE || "auto").toLowerCase();
	return MODES.has(raw) ? raw : "auto";
}

function loadNative({ gatePlatform }) {
	const platformId = `${process.platform}-${process.arch}`;
	if (gatePlatform && !NATIVE_PLATFORMS.has(platformId)) {
		throw new Error(
			`no prebuilt native addon for ${platformId} ` +
				`(supported: ${[...NATIVE_PLATFORMS].join(", ")}, linuxmusl-x64)`,
		);
	}
	// eslint-disable-next-line global-require
	const bridge = require(NATIVE_PATH);
	if (!bridge || typeof bridge.resize !== "function") {
		throw new Error(
			"the engine loaded but exposes no resize() - is @rosepetal/" +
				"node-red-contrib-image-tools the expected package?",
		);
	}
	return bridge;
}

/**
 * Does the native addon actually work? Its require() succeeds even when
 * the binary for this platform is missing; the failure only surfaces later.
 *
 * cpp-bridge 1.7 exposes ready(), which resolves or rejects with the load
 * result. 1.6.4 - which our own ^1.6.4 range still allows, and which is
 * what a Node-RED image built a while ago will have - does not, so asking
 * for it there throws TypeError and would demote a perfectly good native
 * engine. Fall back to the cheapest real op instead: a 1x1 resize either
 * comes back or proves the addon is not there.
 */
async function probeNative(bridge) {
	if (typeof bridge.ready === "function") {
		await bridge.ready();
		return;
	}
	await bridge.resize(
		{
			data: Buffer.alloc(4),
			width: 2,
			height: 2,
			channels: 1,
			colorSpace: "GRAY",
			dtype: "uint8",
		},
		"num",
		1,
		"num",
		1,
		"raw",
	);
}

function loadCvjs() {
	// eslint-disable-next-line global-require
	const cvjs = require("./cvjs.js");
	if (!cvjs.available()) {
		throw new Error(
			"@techstark/opencv-js is not installed (npm i @techstark/opencv-js)",
		);
	}
	// eslint-disable-next-line global-require
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

function select(order, gatePlatform) {
	const errors = [];
	for (const name of order) {
		try {
			const engine =
				name === "native" ? loadNative({ gatePlatform }) : loadCvjs();
			return { engine, name, error: null };
		} catch (err) {
			errors.push(`${name}: ${err.message}`);
		}
	}
	return { engine: null, name: null, error: new Error(errors.join("; ")) };
}

function order() {
	const want = mode();
	return want === "auto" ? ["native", "opencv-js"] : [want];
}

/**
 * The engine as far as a synchronous caller can tell. Cached.
 *
 * @returns {{engine: object|null, name: string|null, error: Error|null}}
 */
function candidate() {
	if (resolvedCache !== undefined) return resolvedCache;
	if (candidateCache === undefined) candidateCache = select(order(), true);
	return candidateCache;
}

/**
 * The engine, having confirmed the native addon really loaded. Cached, and
 * the answer candidate() gives from then on.
 *
 * @returns {Promise<{engine: object|null, name: string|null, error: Error|null}>}
 */
function resolve() {
	if (resolvedCache !== undefined) return Promise.resolve(resolvedCache);
	if (resolvePromise) return resolvePromise;
	resolvePromise = (async () => {
		const first = candidate();
		if (first.name === "native") {
			try {
				await probeNative(first.engine);
			} catch (err) {
				// The addon never loaded. Fall through to the WASM engine
				// unless the caller pinned native, in which case they want
				// the failure, not a substitution.
				const demoted =
					mode() === "native"
						? { engine: null, name: null, error: err }
						: select(["opencv-js"], true);
				resolvedCache = demoted.engine
					? demoted
					: { engine: null, name: null, error: err };
				return resolvedCache;
			}
		}
		resolvedCache = first;
		return resolvedCache;
	})();
	resolvePromise.catch(() => {
		resolvePromise = null;
	});
	return resolvePromise;
}

/** The engine object a synchronous caller can see, or null. */
function engine() {
	return candidate().engine;
}

/** "native", "opencv-js", or null when neither loads. */
function engineName() {
	return candidate().name;
}

/** Why nothing loaded, listing what each candidate said. */
function engineError() {
	return candidate().error;
}

/**
 * Settle the choice and initialise whatever the engine needs before its
 * first op: the native addon's dlopen, or the WASM instantiate (~200ms).
 * Calling this at node startup keeps both off the first frame. Safe to
 * call repeatedly, and safe when no engine loaded.
 *
 * @returns {Promise<string|null>} the engine name that will serve ops
 */
async function warmup() {
	const selected = await resolve();
	if (selected.engine && typeof selected.engine.ready === "function") {
		try {
			await selected.engine.ready();
		} catch {
			/* resolve() already accounted for this */
		}
	}
	return selected.name;
}

/** Test seam: forget the cached selection. */
function _reset() {
	candidateCache = undefined;
	resolvedCache = undefined;
	resolvePromise = null;
}

module.exports = {
	engine,
	engineName,
	engineError,
	warmup,
	candidate,
	resolve,
	probeNative,
	NATIVE_PATH,
	NATIVE_PLATFORMS,
	_reset,
};
