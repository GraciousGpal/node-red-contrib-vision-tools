/**
 * @graciousstar/opencv5: our OpenCV addon (colorConvert, resize, filter,
 * crop, rotate, imageAlign on raw buffers), the engine lib/engine.js picks
 * first. Its own package, with its own prebuilt binaries; required here
 * by name, and - until that package is published and the dependency is
 * a version range - from the opencv5/ directory it is developed in, so a
 * checkout whose node_modules predates the dependency still finds it.
 */

"use strict";

function load() {
	try {
		return require("@graciousstar/opencv5");
	} catch (err) {
		// only its absence falls through; a failure inside it is real
		if (err.code !== "MODULE_NOT_FOUND" || !String(err.message).includes("@graciousstar/opencv5")) throw err;
		return require("../opencv5");
	}
}

module.exports = load();
