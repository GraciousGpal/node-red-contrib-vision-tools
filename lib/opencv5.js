/**
 * @graciousstar/opencv5: our OpenCV addon (colorConvert, resize, filter,
 * crop, rotate, imageAlign on raw buffers), the engine lib/engine.js picks
 * first. Its own package, with its own prebuilt binaries, developed for
 * now in this repository's opencv5/ directory: required by name when it
 * is installed, else from that directory. Until the package is published
 * and added to package.json's dependencies, an installed copy of this
 * package has neither, and lib/engine.js falls back to opencv.js.
 */

"use strict";

const path = require("node:path");

function load() {
	let resolved;
	try {
		resolved = require.resolve("@graciousstar/opencv5");
	} catch {
		resolved = path.join(__dirname, "..", "opencv5", "index.js");
	}
	return require(resolved);
}

module.exports = load();
