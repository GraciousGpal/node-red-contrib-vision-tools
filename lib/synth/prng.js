/**
 * The one source of randomness for the synthetic frame generator.
 *
 * Every random choice in lib/synth - glyph shapes, defect geometry,
 * camera parameters, sensor noise - goes through one of these, so a seed
 * reproduces a whole set byte for byte. That is the point: a benchmark
 * whose inputs move between runs cannot tell a detector regression from a
 * different set of frames.
 *
 * mulberry32: 32 bits of state, a period of 2^32, and no dependency. It is
 * deliberately *not* a cryptographic generator and not meant to be one -
 * nothing here needs unpredictability, only repeatability.
 *
 * Deliberately not offered: any "reseed from the clock" convenience, and
 * any global/singleton instance. A generator you did not pass in is a
 * generator whose sequence you cannot reproduce, so callers always thread
 * one through.
 */

"use strict";

function mulberry32(seed) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * @param {number} seed any integer; 0 is fine
 * @returns {{seed:number, next:()=>number, uniform:Function, int:Function,
 *            pick:Function, bool:Function, gaussian:Function,
 *            shuffle:Function, sign:Function}}
 */
function makePrng(seed) {
	const next = mulberry32(seed);
	const api = {
		seed,
		next,
		/** uniform in [min, max) */
		uniform(min, max) {
			return min + (max - min) * next();
		},
		/** integer in [min, max], both inclusive */
		int(min, max) {
			return min + Math.floor(next() * (max - min + 1));
		},
		pick(items) {
			return items[Math.floor(next() * items.length)];
		},
		bool(p = 0.5) {
			return next() < p;
		},
		sign() {
			return next() < 0.5 ? -1 : 1;
		},
		/**
		 * Box-Muller, discarding the second variate rather than caching it.
		 * The cache would halve the calls but makes the stream depend on how
		 * many gaussians a caller happened to want before it, which turns an
		 * unrelated edit into a different image set.
		 */
		gaussian(mean = 0, sd = 1) {
			const u = Math.max(1e-12, next());
			const v = next();
			return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
		},
		/** Fisher-Yates, in place, returning the same array. */
		shuffle(items) {
			for (let i = items.length - 1; i > 0; i--) {
				const j = Math.floor(next() * (i + 1));
				const t = items[i];
				items[i] = items[j];
				items[j] = t;
			}
			return items;
		},
	};
	return api;
}

module.exports = { makePrng, mulberry32 };
