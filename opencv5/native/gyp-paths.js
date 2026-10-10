// binding.gyp's view of OPENCV_PREFIX (a static OpenCV from
// build-opencv.sh): `include` prints its header directory, `libs` its
// OpenCV and zlib static libraries - nothing else that may sit there.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const prefix = process.env.OPENCV_PREFIX;
if (!prefix || !fs.existsSync(prefix)) {
	console.error("binding.gyp: set OPENCV_PREFIX to a static OpenCV from native/build-opencv.sh");
	process.exit(1);
}
const slash = (p) => p.split(path.sep).join("/");
if (process.argv[2] === "include") {
	// include/opencv5 on Unix, include on Windows
	const unix = path.join(prefix, "include", "opencv5");
	console.log(slash(fs.existsSync(unix) ? unix : path.join(prefix, "include")));
} else {
	const walk = (d) =>
		fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
		);
	const libs = walk(prefix).filter((f) => /^(lib)?(opencv_\w+|zlib)\.(lib|a)$/.test(path.basename(f)));
	console.log(libs.map((f) => JSON.stringify(slash(f))).join(" "));
}
