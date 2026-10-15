/**
 * zxing-wasm's barcode writer, for tests that render their own barcode
 * fixtures.
 *
 * The writer ships inside zxing-wasm, which is a hard dependency of this
 * package (package.json "dependencies"), so it is always installed. A load
 * failure is a broken install: this module throws at require time and
 * every test file that needs the writer fails, rather than skipping its
 * tests and reading as a pass.
 *
 * It is made offline the way lib/locate.js makes the reader offline: the
 * .wasm is read from the package and handed over, so zxing never fetches
 * it from jsdelivr.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

let writer;
try {
	writer = require("zxing-wasm/writer");
	const root = path.resolve(path.dirname(require.resolve("zxing-wasm/writer")), "..", "..", "..");
	const wasmBinary = fs.readFileSync(path.join(root, "dist", "writer", "zxing_writer.wasm"));
	writer.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true }).catch(() => {});
} catch (err) {
	throw new Error(`zxing-wasm/writer failed to load (zxing-wasm is a hard dependency): ${err && err.stack ? err.stack : err}`);
}

module.exports = writer;
