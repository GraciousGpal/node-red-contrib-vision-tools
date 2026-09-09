/**
 * Shared calibration-baseline file helpers, used by both golden-compare
 * (reads the calibrated mm/px scale) and checkerboard-calibrate (reads
 * and writes it).
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

async function pathExists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

function isFinitePositive(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// Physical sanity bound for mm/px. A vision lens maps a few mm onto many
// pixels, so a value past 1000 mm/px is a corrupt file, not a real rig -
// and so is 0, a negative, or an Infinity that JSON.parse happily accepts
// from "1e999". Any of those flow downstream into NaN and a sharp.resize
// that errors every frame (or a silent pass when the sizes happen to
// match), so refuse with a reason instead of applying them.
const MM_PER_PX_MAX = 1000;

/**
 * Read the calibration baseline, returning null when there is nothing
 * configured or on disk. A file that exists but is unreadable, corrupt,
 * or out of physical range comes back as { error } rather than null so
 * the caller can say so instead of silently running uncalibrated.
 *
 * nativeWidth/nativeHeight (the calibration photo's own size, written by
 * checkerboard-calibrate) are validated when present; files written
 * before the geometry was recorded simply omit them and keep working
 * with the golden-native fallback in prepareGolden.
 */
async function readScaleFile(scaleFilePath) {
	if (!scaleFilePath || !(await pathExists(scaleFilePath))) return null;
	let parsed;
	try {
		parsed = JSON.parse(await fsp.readFile(scaleFilePath, "utf8"));
	} catch (err) {
		return { error: `calibration file is not readable JSON: ${err.message}` };
	}
	if (
		!isFinitePositive(parsed.mmPerPixelNative) ||
		parsed.mmPerPixelNative > MM_PER_PX_MAX
	) {
		return {
			error:
				`calibration mmPerPixelNative must be a finite positive number <= ` +
				`${MM_PER_PX_MAX} (got ${parsed.mmPerPixelNative}) - re-run ` +
				`checkerboard-calibrate`,
		};
	}
	const w = parsed.nativeWidth;
	const h = parsed.nativeHeight;
	if (w != null || h != null) {
		if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
			return {
				error:
					`calibration nativeWidth/nativeHeight must be positive integers ` +
					`(got ${w}/${h}) - re-run checkerboard-calibrate`,
			};
		}
	}
	return parsed;
}

async function writeScaleFile(scaleFilePath, record) {
	await fsp.mkdir(path.dirname(scaleFilePath), { recursive: true });
	await fsp.writeFile(scaleFilePath, JSON.stringify(record, null, 2));
}

module.exports = { readScaleFile, writeScaleFile, pathExists };
