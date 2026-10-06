/**
 * Shared-memory allocation for the buffers the worker pool operates on.
 *
 * Worker threads can only touch a typed array without copying it if its
 * backing store is a SharedArrayBuffer, and the per-frame buffers here
 * run to tens of megabytes - copying them into and out of workers would
 * cost more than the parallelism saves. So the large intermediates are
 * allocated shared from the start; a typed array over a SharedArrayBuffer
 * behaves identically to one over an ArrayBuffer for every operation in
 * this codebase, so nothing else has to know.
 *
 * If SharedArrayBuffer is unavailable the allocators fall back to ordinary
 * buffers and `HAS_SAB` is false, which is the signal for callers to stay
 * on the serial path rather than fail.
 */

const HAS_SAB = typeof SharedArrayBuffer !== "undefined";

// V8 collects on its own schedule, and the schedule is set by the heap -
// which a frame barely touches - not by the shared buffers a frame
// allocates, which it does by the tens of megabytes: a dropped shared
// buffer is not collected for its size before some 800 MB of them have
// piled up. With the pool it was worse: a shared buffer is freed only
// when every isolate that viewed it has let go, and nothing makes a pool
// worker's collector run. Measured: 70 MB retained per frame, 1.8 GB of
// shared buffers and 2.5 GB RSS after 25 frames at 3 MP, climbing. So
// the allocators here count what they hand out and collect every
// GC_EVERY_BYTES, and the pool workers count what they are handed
// (lib/poolWorker.js).
//
// The collection is a full one - the views are promoted by the time a
// frame is done, and a minor collection frees none of them - and it
// stops the thread for as long as its heap takes: 4-13 ms on a pool
// worker, a few on the inspector thread, 15-50 ms on a Node-RED main
// thread, which allocates once per frame when it copies the frame to
// shared memory for the inspector. V8's asynchronous collection is the
// same pause on a posted task, so there is no cheaper form. The backing
// stores are released by V8's concurrent sweeper, up to ~50 ms after the
// collection, not inside it.
//
// The collector is V8's `gc`. A host that started Node with --expose-gc
// (or --expose-gc-as=<name>) has it already, and that one is taken by
// its name and the flags left alone: switching them off would take the
// host's own gc away from every context and worker created after. Any
// other host gets the flag turned on from inside and off again straight
// after, so a context created later - a Function node's sandbox at the
// next deploy - does not find a `gc` global it never asked for; the
// function already taken keeps working. Because the flag is process-wide,
// fifteen pool workers, the inspector thread and the main thread taking
// theirs at once would un-expose it under each other - left to retries,
// one thread in a thousand ended with no collector and the leak back,
// silently - so the take is under one process-wide lock, shared through
// the worker environment data. A context Node-RED itself creates during
// another thread's take, a 3-30 ms window once per thread, can still see
// the flag on; accepted. A host whose gc cannot be taken gets a
// collector that does nothing, and one warning for the process.
const v8 = require("node:v8");
const vm = require("node:vm");
const {
	isMainThread,
	getEnvironmentData,
	setEnvironmentData,
} = require("node:worker_threads");
const GC_EVERY_BYTES = 256 * 1024 * 1024;
const GC_LOCK_KEY = "@graciousstar/node-red-contrib-vision-tools:gc-flag-lock";
// a holder terminated inside the critical section never unlocks; steal
// after this rather than hang every later taker, Node-RED's main thread
// included
const GC_LOCK_STEAL_MS = 1000;
// slots of the lock buffer: [0] the lock, [1] whether the warning went
const LOCK = 0;
const WARNED = 1;

function gcLock() {
	let lock = getEnvironmentData(GC_LOCK_KEY);
	if (lock instanceof Int32Array) return lock;
	if (!HAS_SAB) return null;
	lock = new Int32Array(new SharedArrayBuffer(8));
	// workers spawned from here on inherit it; a worker that loaded this
	// module before its parent did gets a lock of its own, which only
	// means it is unprotected against siblings in that one arrangement
	if (isMainThread) setEnvironmentData(GC_LOCK_KEY, lock);
	return lock;
}

// published now, not on first use: the pool is spawned long before the
// first collection, and a worker spawned before the lock exists makes a
// private one that protects nothing
gcLock();

function underGcLock(fn) {
	const lock = gcLock();
	if (lock === null) return fn();
	const deadline = Date.now() + GC_LOCK_STEAL_MS;
	while (Atomics.compareExchange(lock, LOCK, 0, 1) !== 0) {
		if (Date.now() > deadline) break;
		Atomics.wait(lock, LOCK, 1, 50);
	}
	try {
		return fn();
	} finally {
		Atomics.store(lock, LOCK, 0);
		Atomics.notify(lock, LOCK);
	}
}

const isNative = (fn) =>
	typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn));

/** The name the host exposed gc under on its command line, if it did. */
function hostExposedGcName() {
	const argv = [...process.execArgv, ...(process.env.NODE_OPTIONS || "").split(/\s+/)];
	for (const arg of argv) {
		const m = /^--expose[-_]gc(?:[-_]as=(\S+))?$/.exec(arg);
		if (m) return m[1] || "gc";
	}
	return null;
}

function warnOnce() {
	const lock = gcLock();
	if (lock !== null && Atomics.compareExchange(lock, WARNED, 0, 1) !== 0) return;
	process.emitWarning(
		"could not take V8's gc; shared buffers from finished frames will be released on V8's own schedule only",
		{ code: "VISION_TOOLS_NO_GC" },
	);
}

let collect = null;
function collector() {
	if (collect !== null) return collect;
	// a host started with --expose-gc; not a `gc` some script installed
	if (isNative(globalThis.gc)) {
		collect = globalThis.gc;
		return collect;
	}
	const hostName = hostExposedGcName();
	if (hostName !== null) {
		try {
			const fn = vm.runInNewContext(hostName);
			if (isNative(fn)) {
				collect = fn;
				return collect;
			}
		} catch {
			// fall through to taking our own
		}
	}
	collect = underGcLock(() => {
		try {
			v8.setFlagsFromString("--expose-gc");
			const fn = vm.runInNewContext("gc");
			return isNative(fn) ? fn : null;
		} catch {
			return null;
		} finally {
			v8.setFlagsFromString("--no-expose-gc");
		}
	});
	if (collect === null) {
		warnOnce();
		collect = () => {};
	}
	return collect;
}

/** Collect now, synchronously: a full collection on this thread. */
function collectGarbage() {
	collector()();
}

let bytesSinceGc = 0;
let bytesEver = 0;
/** Count shared bytes allocated on this thread; collects at the interval. */
function accountShared(bytes) {
	bytesSinceGc += bytes;
	bytesEver += bytes;
	if (bytesSinceGc < GC_EVERY_BYTES) return;
	bytesSinceGc = 0;
	collectGarbage();
}

function allocU8(length) {
	if (HAS_SAB) accountShared(length);
	return HAS_SAB
		? new Uint8Array(new SharedArrayBuffer(length))
		: new Uint8Array(length);
}

function allocU32(length) {
	if (HAS_SAB) accountShared(length * 4);
	return HAS_SAB
		? new Uint32Array(new SharedArrayBuffer(length * 4))
		: new Uint32Array(length);
}

function allocF32(length) {
	if (HAS_SAB) accountShared(length * 4);
	return HAS_SAB
		? new Float32Array(new SharedArrayBuffer(length * 4))
		: new Float32Array(length);
}

function allocF64(length) {
	if (HAS_SAB) accountShared(length * 8);
	return HAS_SAB
		? new Float64Array(new SharedArrayBuffer(length * 8))
		: new Float64Array(length);
}

/** Copy into shared memory only when it is not already there. */
function toShared(array) {
	if (!HAS_SAB) return array;
	if (
		array.buffer instanceof SharedArrayBuffer &&
		array.byteOffset === 0 &&
		array.byteLength === array.buffer.byteLength
	) {
		return array;
	}
	return copyToShared(array);
}

/**
 * Copy `array`'s bytes into a fresh zero-offset SharedArrayBuffer-backed
 * view with the same element type. Workers rebuild their side as
 * `new Uint8Array(buffer)` from offset 0 (poolWorker.js), so a view that
 * is a slice of a larger buffer (byteOffset > 0) must be copied or the
 * workers would read the wrong bytes - silently.
 */
function copyToShared(array) {
	accountShared(array.byteLength);
	const store = new SharedArrayBuffer(array.byteLength);
	// Buffer's `new Buffer(SAB)` form is deprecated (DEP0005) and sharp's
	// decodeGray hands us Buffers on every parallel frame; build those as
	// a plain Uint8Array over the store instead. The element type only
	// matters for the other typed arrays, which callers index as such.
	const Ctor = array.constructor === Buffer ? Uint8Array : array.constructor;
	const out = new Ctor(store);
	out.set(array);
	return out;
}

/** Shared bytes this thread has allocated so far; for sizing a test. */
function sharedAllocated() {
	return bytesEver;
}

module.exports = {
	HAS_SAB,
	GC_EVERY_BYTES,
	accountShared,
	collectGarbage,
	sharedAllocated,
	allocU8,
	allocU32,
	allocF32,
	allocF64,
	toShared,
};
