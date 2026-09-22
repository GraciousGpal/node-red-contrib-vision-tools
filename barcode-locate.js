/**
 * barcode-locate Node-RED node.
 *
 * Finds and decodes barcodes (1D and 2D) in an image using zxing-wasm, a
 * WebAssembly build of the zxing-cpp engine. Detection and decode logic
 * lives in lib/locate.js so it can be exercised outside Node-RED.
 *
 * The point of this node over just calling zxing-wasm directly on the full
 * image every time: on a fixed camera rig (same assumption
 * golden-compare/checkerboard-calibrate already make - see their docs),
 * barcodes land in roughly the same place shot to shot, so pre-defining
 * where to look and scanning only those regions is 1-2 orders of magnitude
 * faster than scanning the whole frame. "Regions, then full image if
 * nothing found" keeps the whole-image scan available as a safety net
 * (label repositioned, region mis-measured, etc.) without paying its cost
 * on every normal run.
 *
 * Input (msg.payload): Buffer / Uint8Array / ArrayBuffer with image bytes,
 * a file path string, or an object { data | buffer | path }.
 * Optional per-message overrides: msg.regions (array), msg.mode.
 *
 * Output: one message per barcode found, in the order regions were scanned
 * (then, if used, the full-image fallback) - msg.text, msg.format,
 * msg.roi, msg.regionLabel, msg.source ("region"|"fullImage"),
 * msg.decodeMs, msg.timings, msg.payload (a preview crop of that barcode's
 * region). If nothing is found at all, sends one message with
 * msg.text = null.
 */

const { locateBarcodes, DEFAULT_FORMATS } = require("./lib/locate.js");
const { resolveImage } = require("./lib/nodeInput.js");

module.exports = (RED) => {
	function normalizeRegions(regions) {
		if (!Array.isArray(regions)) return [];
		return regions
			.map((r) => ({
				label: String(r.label || "").trim(),
				x: parseInt(r.x, 10) || 0,
				y: parseInt(r.y, 10) || 0,
				width: parseInt(r.width, 10) || 0,
				height: parseInt(r.height, 10) || 0,
			}))
			.filter((r) => r.width > 0 && r.height > 0);
	}

	function totalMs(timings) {
		return (timings.regionsMs || 0) + (timings.fullImageMs || 0);
	}

	function BarcodeLocateNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.mode = config.mode === "regionsOnly" || config.mode === "autoOnly" ? config.mode : "regionsThenAuto";
		node.regions = normalizeRegions(config.regions);

		const enabledFormats = DEFAULT_FORMATS.concat(["EAN8"]).filter((f) => config[f]);
		node.readerOptions = {
			tryHarder: config.tryHarder !== false,
			tryRotate: config.tryRotate !== false,
			maxNumberOfSymbols: 20,
			formats: enabledFormats.length ? enabledFormats : DEFAULT_FORMATS,
		};

		node.on("input", async (msg, send, done) => {
			send = send || function () { node.send.apply(node, arguments); };
			try {
				const buffer = await resolveImage(msg.payload, "msg.payload");
				const regions = msg.regions !== undefined ? normalizeRegions(msg.regions) : node.regions;
				const mode = msg.mode || node.mode;

				node.status({ fill: "blue", shape: "dot", text: `scanning ${regions.length} region${regions.length === 1 ? "" : "s"}…` });

				const { results, timings, usedFullImage } = await locateBarcodes(buffer, {
					regions,
					mode,
					readerOptions: node.readerOptions,
				});

				if (results.length === 0) {
					const noneMsg = Object.assign({}, msg, {
						barcodeIndex: 0,
						barcodeCount: 0,
						text: null,
						format: null,
						roi: null,
						regionLabel: null,
						source: usedFullImage ? "fullImage" : "region",
						timings,
					});
					send(noneMsg);
					node.status({ fill: "yellow", shape: "ring", text: `none found (${totalMs(timings)}ms)` });
					done();
					return;
				}

				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					const outMsg = Object.assign({}, msg, {
						barcodeIndex: i,
						barcodeCount: results.length,
						text: r.text,
						format: r.format,
						roi: r.roi,
						regionLabel: r.regionLabel,
						source: r.source,
						decodeMs: r.decodeMs,
						timings,
						payload: r.previewBuffer,
					});
					send(outMsg);
				}

				node.status({
					fill: "green",
					shape: "dot",
					text: `${results.length} found (${usedFullImage ? "full image" : "regions"}, ${totalMs(timings)}ms)`,
				});
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: "error" });
				// done(err) routes the failure through node.error exactly
				// once; an explicit node.error here reported every failure
				// twice (double log lines, Catch nodes firing twice)
				done(err);
			}
		});
	}

	RED.nodes.registerType("barcode-locate", BarcodeLocateNode);
};
