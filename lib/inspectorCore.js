/**
 * The inspection pipeline behind one small request/response surface,
 * plus the prepared-golden store it needs.
 *
 * This module is called two ways: directly, on the Node-RED thread, when
 * worker threads or SharedArrayBuffer are unavailable; and from inside
 * `lib/inspectorWorker.js`, which is where it runs in production. Both
 * paths call these same functions, so a verdict cannot depend on which
 * one ran - the same discipline `lib/parallel.js` uses for its kernels,
 * and for the same reason.
 *
 * It deliberately does no file I/O. Structured clone drops an error's
 * own properties - a cloned ENOENT arrives with `err.code === undefined`,
 * and `golden-compare.js` branches on exactly that - so every path that
 * needs to tell "missing" from "refused" stays on the calling thread.
 */

"use strict";

const { prepareGolden, compareFrame } = require("./compare.js");
const { measureCheckerboard } = require("./checkerboard.js");

/**
 * How many prepared goldens to keep.
 *
 * There has to be a bound. The store lives for the life of the process
 * (like the worker pool, and for the same reason - re-preparing costs
 * ~280ms), and it is keyed by everything baked into the golden, which
 * includes settings a *message* can override: threshold, thresholdMode,
 * sauvolaRadius, sauvolaK, inkMargin, backgroundTolerance, debugStages.
 * A flow sweeping msg.threshold would otherwise add an entry per frame,
 * each holding five masks - around 84MB at workingSize 4096.
 *
 * Four covers the cases that are actually concurrent: a couple of nodes
 * with different goldens, plus a settings change being tuned.
 */
const MAX_GOLDENS = 4;

// cacheKey -> { promise }, in insertion order, so the first key is the
// least recently used.
const goldens = new Map();

function touch(cacheKey, entry) {
	goldens.delete(cacheKey);
	goldens.set(cacheKey, entry);
	while (goldens.size > MAX_GOLDENS) {
		goldens.delete(goldens.keys().next().value);
	}
}

/** A SharedArrayBuffer handle back to a Buffer view over the same bytes.
 * `Buffer.from(view)` would copy the whole frame again. */
function view(handle) {
	return handle == null ? null : Buffer.from(handle, 0, handle.byteLength);
}

/**
 * Everything the calling thread still needs to know about a prepared
 * golden: the two warnings it raises, the trained-transform record, and
 * the threshold level. mmPerWorkingPx is not read on that side today -
 * it is here so the reply is a complete description of the golden rather
 * than a list of current callers, which is the thing that rots.
 */
function goldenMeta(golden) {
	return {
		nativeWidth: golden.nativeWidth,
		nativeHeight: golden.nativeHeight,
		width: golden.width,
		height: golden.height,
		thresholdLevel: golden.thresholdLevel,
		mmPerWorkingPx: golden.mmPerWorkingPx,
	};
}

/**
 * Make sure the store holds a golden for `cacheKey`.
 *
 * Answers `{ needGolden: true }` rather than throwing when it does not
 * have the key and was not given the bytes, so the caller can send them
 * only when they are actually needed - a golden the store already holds
 * must not be re-read from disk just to be discarded as a duplicate.
 */
async function prepare({ cacheKey, cfg, golden }) {
	let entry = goldens.get(cacheKey);
	if (!entry) {
		if (!golden) return { needGolden: true };
		entry = {};
		entry.promise = prepareGolden(view(golden), cfg).catch((err) => {
			// Drop the entry so the next message retries, instead of every
			// later frame inheriting one transient failure for the life of
			// the process. golden-compare.js does the same for its own
			// cache; both are needed, since they are two caches.
			if (goldens.get(cacheKey) === entry) goldens.delete(cacheKey);
			throw err;
		});
		goldens.set(cacheKey, entry);
	}
	touch(cacheKey, entry);
	return { goldenMeta: goldenMeta(await entry.promise) };
}

/**
 * Compare one frame. `{ needGolden: true }` here means the golden was
 * evicted between prepare and inspect; the caller re-prepares and retries
 * exactly once.
 */
async function inspect({ cacheKey, cfg, frame }) {
	const entry = goldens.get(cacheKey);
	if (!entry) return { needGolden: true };
	touch(cacheKey, entry);
	const golden = await entry.promise;
	const result = await compareFrame(view(frame), golden, cfg);
	return { result, goldenMeta: goldenMeta(golden) };
}

/** checkerboard-calibrate's measurement, which is otherwise ~59ms of
 * synchronous work on the event loop at full sensor resolution. */
async function calibrate({ cfg, image }) {
	return { result: await measureCheckerboard(view(image), cfg) };
}

/** Testing seam: the store is process-wide and deliberately survives a
 * redeploy, so only tests should ever clear it. */
function clear() {
	goldens.clear();
}

module.exports = { prepare, inspect, calibrate, clear, MAX_GOLDENS };
