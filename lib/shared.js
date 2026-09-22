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

function allocU8(length) {
	return HAS_SAB
		? new Uint8Array(new SharedArrayBuffer(length))
		: new Uint8Array(length);
}

function allocU32(length) {
	return HAS_SAB
		? new Uint32Array(new SharedArrayBuffer(length * 4))
		: new Uint32Array(length);
}

function allocF32(length) {
	return HAS_SAB
		? new Float32Array(new SharedArrayBuffer(length * 4))
		: new Float32Array(length);
}

function allocF64(length) {
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

module.exports = {
	HAS_SAB,
	allocU8,
	allocU32,
	allocF32,
	allocF64,
	toShared,
};
