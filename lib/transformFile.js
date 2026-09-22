/**
 * Trained-transform file helpers.
 *
 * The alignment transform splits cleanly into two halves by what
 * physically varies between frames:
 *
 *   - magnification (mx) and stretch (my/mx) come from the camera's
 *     standoff and the press's pull on the media. Neither changes from
 *     one part to the next, so both are measured once and reused - the
 *     same reasoning as the mm/px calibration next door.
 *   - translation and rotation are where the part happens to be sitting
 *     this time, and have to be solved every frame.
 *
 * Reusing the first half is not primarily a speed optimization. A search
 * that is free to re-solve magnification per frame can pick wrong, and it
 * is likeliest to pick wrong on a badly printed label - the case the
 * inspection exists for - because a poor print gives the search poor
 * evidence to fit. Pinning removes that whole class of failure.
 *
 * A trained record is tied to the golden it was measured against and to
 * the working size it was measured at, because the numbers are meaningless
 * against a different golden or at a different resolution. Both are
 * checked on load and a mismatch is rejected rather than silently applied.
 *
 * "The golden it was measured against" has to mean the *image*, not the
 * way the image arrived. `goldenKey` is the caller's cheap fingerprint,
 * and its form follows the delivery: `buf:<sha1>` for a golden sent on the
 * message, `path:<file>:<mtime>:<size>` for one read from disk, `key:<n>`
 * for one the flow named. Training through msg.golden and then producing
 * frames from the configured goldenPath - the documented "train from any
 * two images" flow - therefore compared `buf:...` against `path:...` and
 * refused a perfectly good record on every frame, silently falling back
 * to the full search. So a record also carries `goldenContentKey`, a hash
 * of the golden's bytes, and the cheap keys disagreeing only means
 * "resolve it against the content" rather than "refuse". Computing that
 * hash means reading the golden, which is the one thing the cheap keys
 * exist to avoid, so the caller passes a resolver that is consulted only
 * on a cheap-key mismatch and never on the hot path.
 */

"use strict";

const fsp = require("fs").promises;
const path = require("path");
const { pathExists, isFinitePositive } = require("./scaleFile.js");

// The physical range a trained magnification can plausibly take. A
// standoff a few cm further out changes a scale by a few percent; nothing
// in this rig produces a 1000x or 1e-4x relationship between the golden's
// working pixels and the frame's. The bound is not about being right at
// the edges - a huge but finite scaleX like 1e308 flows through the
// pinned search into centerX = (tW - mx*gW)/2 = -Infinity and an infinite
// halfRange, which makes the sweep loop forever and freezes the Node-RED
// process. Refuse the record instead, the same way a golden/workingSize
// mismatch is refused, and let the caller fall back to searching.
const SCALE_MIN = 0.05;
const SCALE_MAX = 100;

/**
 * Read a trained transform, returning null when there is nothing usable.
 * `expect` is { goldenKey, workingSize, goldenContentKey }, where
 * goldenContentKey is a hash of the golden's bytes or a function
 * returning one; a record trained against a different golden or working
 * size is refused with a reason rather than applied, since applying it
 * would misalign every frame in a way that looks like a print fault.
 */
async function readTransformFile(filePath, expect) {
	if (!filePath || !(await pathExists(filePath))) return null;
	let parsed;
	try {
		parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
	} catch (err) {
		return { error: `trained transform is not readable JSON: ${err.message}` };
	}
	if (!isFinitePositive(parsed.scaleX) || !isFinitePositive(parsed.scaleY)) {
		return { error: "trained transform has no usable scaleX/scaleY" };
	}
	if (
		parsed.scaleX < SCALE_MIN ||
		parsed.scaleX > SCALE_MAX ||
		parsed.scaleY < SCALE_MIN ||
		parsed.scaleY > SCALE_MAX
	) {
		return {
			error:
				`trained transform scaleX/scaleY must be within ${SCALE_MIN}..${SCALE_MAX} ` +
				`(got ${parsed.scaleX}/${parsed.scaleY}) - retrain it`,
		};
	}
	if (expect) {
		if (
			expect.goldenKey &&
			parsed.goldenKey &&
			parsed.goldenKey !== expect.goldenKey
		) {
			// The cheap keys record how the golden was delivered, so they
			// disagree both when the golden really changed and when the same
			// image simply arrived a different way. Only the content can tell
			// those apart; resolving it costs a read, so it happens here and
			// nowhere else.
			const mine = await resolveContentKey(expect);
			if (!parsed.goldenContentKey || !mine) {
				return {
					error:
						`trained transform was measured against a different golden ` +
						`(${parsed.goldenKey} vs ${expect.goldenKey}) - retrain it` +
						(parsed.goldenContentKey
							? ""
							: ` (this record predates content-keyed training, so the same ` +
								`golden delivered a different way cannot be recognised)`),
				};
			}
			if (parsed.goldenContentKey !== mine) {
				return {
					error:
						`trained transform was measured against different golden content ` +
						`(${parsed.goldenContentKey} vs ${mine}) - retrain it`,
				};
			}
		}
		if (
			expect.workingSize &&
			parsed.workingSize &&
			parsed.workingSize !== expect.workingSize
		) {
			return {
				error:
					`trained transform was measured at workingSize ${parsed.workingSize}, ` +
					`now running at ${expect.workingSize} - retrain it`,
			};
		}
	}
	return { scaleX: parsed.scaleX, scaleY: parsed.scaleY, record: parsed };
}

// expect.goldenContentKey may be a string or a function returning one
// (sync or async); a resolver that throws - an unreadable golden, say -
// leaves the mismatch unresolved, which refuses the record and falls back
// to searching, the same as before it existed.
async function resolveContentKey(expect) {
	const c = expect.goldenContentKey;
	if (typeof c === "string") return c || null;
	if (typeof c !== "function") return null;
	try {
		return (await c()) || null;
	} catch {
		return null;
	}
}

async function writeTransformFile(filePath, record) {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, JSON.stringify(record, null, 2));
}

module.exports = { readTransformFile, writeTransformFile };
