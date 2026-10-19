/**
 * barcode-locate with msg.regions from region-detect: items with a kind
 * are scanned only when kind is "barcode"; items without one as before.
 * The frame holds two Code128s, one under a "text" box and one under a
 * "barcode" box, so a read of the first proves the filter is missing.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");
const writer = require("./helpers/barcodeWriter.js");

const IN_TEXT = "VT-TEXT-BOX";
const IN_BARCODE = "VT-CODE-BOX";

let framePromise = null;
function frame() {
	if (!framePromise) {
		framePromise = (async () => {
			const code = async (text) => {
				const r = await writer.writeBarcode(text, { format: "Code128", scale: 3, addQuietZones: false });
				if (r.error) throw new Error(`writeBarcode: ${r.error}`);
				return Buffer.from(await r.image.arrayBuffer());
			};
			const [a, b] = await Promise.all([code(IN_TEXT), code(IN_BARCODE)]);
			const [ma, mb] = await Promise.all([sharp(a).metadata(), sharp(b).metadata()]);
			assert.ok(ma.width < 540 && mb.width < 540, `codes fit their half: ${ma.width}, ${mb.width}`);
			return sharp({ create: { width: 1200, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } } })
				.composite([
					{ input: a, left: 40, top: 100 },
					{ input: b, left: 640, top: 100 },
				])
				.png()
				.toBuffer();
		})();
	}
	return framePromise;
}

// region-detect's output: { name, label, kind, x, y, width, height, rotate, score }
const TEXT_BOX = { name: "t1", label: "text", kind: "text", x: 10, y: 60, width: 580, height: 300, rotate: 0, score: 0.8 };
const CODE_BOX = { name: "b1", label: "barcode", kind: "barcode", x: 610, y: 60, width: 580, height: 300, rotate: 0, score: 0.9 };
const GRAPHIC_BOX = { name: "g1", label: "graphic", kind: "graphic", x: 0, y: 0, width: 600, height: 400, rotate: 0, score: 0.7 };

async function run(regions) {
	const node = loadNode("barcode-locate.js", { mode: "regionsOnly", regions: [] });
	const sent = [];
	const errors = [];
	await node.listeners.input({ payload: await frame(), regions }, (m) => sent.push(m), (err) => err && errors.push(String(err.message || err)));
	assert.deepEqual(errors, []);
	return sent;
}

test("precondition: without kinds both boxes are scanned and both codes read", async () => {
	const strip = ({ kind, ...r }) => r;
	const sent = await run([TEXT_BOX, CODE_BOX].map(strip));
	assert.deepEqual(sent.map((m) => m.text).sort(), [IN_BARCODE, IN_TEXT].sort());
});

test("msg.regions with kinds, as an array or a JSON string: only the barcode box is scanned", async () => {
	const kinded = [TEXT_BOX, CODE_BOX, GRAPHIC_BOX];
	for (const regions of [kinded, JSON.stringify(kinded)]) {
		const sent = await run(regions);
		assert.deepEqual(sent.map((m) => [m.text, m.regionLabel, m.source, m.regionSource]), [[IN_BARCODE, "barcode", "region", "msg"]], typeof regions);
	}
});

test("msg.regions with no barcode kind is an empty list: regionsOnly reads nothing", async () => {
	const sent = await run([TEXT_BOX, GRAPHIC_BOX]);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].text, null);
});

test("msg.regions that is not valid JSON fails the message rather than scanning", async () => {
	const node = loadNode("barcode-locate.js", { mode: "regionsThenAuto", regions: [] });
	const sent = [];
	const errors = [];
	const nodeErrors = [];
	const statuses = [];
	node.error = (e) => nodeErrors.push(e);
	node.status = (s) => statuses.push(s);
	await node.listeners.input({ payload: await frame(), regions: "[" }, (m) => sent.push(m), (err) => err && errors.push(String(err.message || err)));
	assert.equal(errors.length, 1);
	assert.match(errors[0], /^barcode-locate: msg\.regions is not valid JSON: /);
	assert.deepEqual(sent, []);
	assert.deepEqual(nodeErrors, []);
	assert.equal(statuses.at(-1).fill, "red");
});
