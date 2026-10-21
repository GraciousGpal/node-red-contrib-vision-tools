/**
 * region-detect Node-RED node.
 *
 * Finds the regions of interest on a printed label - text blocks,
 * barcodes and graphics - with lib/regionDetect.js and emits them for the
 * nodes downstream (text-inspect and barcode-locate take msg.regions as
 * it comes). One-off: run it when a new golden image is chosen, not per
 * frame; a label takes 0.3 to 3 s, most of it the barcode decode and,
 * with orientation "auto", two model reads per text block.
 *
 * Config, each overridable per message by the same key in msg.detect (an
 * object, any subset; it wins over the config for that message only):
 * orientation ("auto", 0, 90, 180 or 270: "auto" reads each text block
 * both ways with lib/ocr.js and keeps the better; a number is used as it
 * is, nothing is read and the model is not loaded), minTextHeight px (8,
 * thinner text is not text), minScore 0..1 (0.7, with "auto" a text block
 * read below it is dropped), graphics (true), barcodes (true) and pad px
 * (4, added around every box). In msg.detect, graphics and barcodes take
 * true, false, "true" or "false" only; a bad msg.detect value fails the
 * message, naming it.
 *
 * Input (msg.payload): Buffer / Uint8Array / ArrayBuffer with image bytes,
 * a file path string, or an object { data | buffer | path }; bare pixels
 * as { data, width, height, channels } or bytes plus msg.rawInfo.
 *
 * Output: one message per input, msg.payload and every other field as
 * they came, plus msg.regions - [{ name, label, kind, x, y, width, height,
 * rotate, score }] in the frame's pixels, kind "text", "barcode" or
 * "graphic", sorted by y then x, named per kind ("text1", "barcode1") -
 * msg.detect - { frameWidth, frameHeight, charHeight, counts: { text,
 * barcode, graphic } } - and msg.timings. Failures go to done(err) only.
 *
 * msg.timings, ms with one decimal: inputMs (resolving and decoding
 * msg.payload), then the library's thresholdMs, componentsMs, barcodeMs,
 * textMs, orientMs and graphicsMs, and totalMs (message in to message
 * out). The status shows the counts and totalMs.
 *
 * GET /region-detect/last-frame/:id (permission region-detect.read)
 * serves the last frame through the node for the editor: 404 before any
 * input, then the bytes as they came (a raw frame as PNG) with
 * X-Frame-Width, X-Frame-Height, X-Frame-Received and Cache-Control:
 * no-store. GET /region-detect/last-regions/:id (same permission) serves
 * { regions, detect, received } of the last message sent, 404 before
 * any. Both are written together after a successful detection, so a
 * failed message leaves the last good pair; both are kept across a
 * redeploy and deleted when the node is removed.
 */

const sharp = require("sharp");
const { performance } = require("node:perf_hooks");
const { detectRegions } = require("./lib/regionDetect.js");
const { resolveImage, rawGeometry, assertRawFits, asView, asBoolean, clampInt, clampFloat, pickMode, sharpInput } = require("./lib/nodeInput.js");
const { formatMs } = require("./lib/formatMs.js");

const DETECT_KEYS = ["orientation", "minTextHeight", "minScore", "graphics", "barcodes", "pad"];

/**
 * An error as status badge text: no "region-detect: " prefix, at most 60
 * characters, and no file paths or names (done(err) keeps them). Every
 * quoted string, single or double, holding / or \ becomes "…" in its own
 * quotes; a msg.payload message only ever quotes the payload path, so all
 * its double-quoted strings go too.
 */
function statusText(err) {
	let text = String(err && err.message ? err.message : err).replace(/^region-detect: /, "");
	if (text.startsWith("msg.payload")) text = text.replace(/"[^"]*"/g, '"…"');
	text = text.replace(/"[^"]*[/\\][^"]*"/g, '"…"').replace(/'[^']*[/\\][^']*'/g, "'…'");
	return text.slice(0, 60);
}

/** The node's config as detectRegions options. */
function configOptions(config) {
	const orientation = pickMode(String(config.orientation), "auto", ["auto", "0", "90", "180", "270"]);
	return {
		orientation: orientation === "auto" ? "auto" : Number(orientation),
		minTextHeight: clampInt(config.minTextHeight, 8, [1, 1e6]),
		minScore: clampFloat(config.minScore, 0.7, [0, 1]),
		graphics: asBoolean(config.graphics, true),
		barcodes: asBoolean(config.barcodes, true),
		pad: clampInt(config.pad, 4, [0, 1e6]),
	};
}

/** The config options with msg.detect's keys over them; detectRegions checks the values. */
function messageOptions(base, override) {
	if (override === undefined || override === null) return base;
	if (typeof override !== "object" || Array.isArray(override)) {
		throw new Error(`region-detect: msg.detect must be an object, got ${Array.isArray(override) ? "an array" : typeof override}`);
	}
	const opts = { ...base };
	for (const key of DETECT_KEYS) {
		const v = override[key];
		if (v === undefined) continue;
		if (key === "graphics" || key === "barcodes") {
			// "false" from a change node is off, as a checkbox would be
			if (v !== true && v !== false && v !== "true" && v !== "false") {
				throw new Error(`region-detect: msg.detect.${key} is ${JSON.stringify(v)}, not true or false`);
			}
			opts[key] = v === true || v === "true";
		} else opts[key] = v;
	}
	return opts;
}

module.exports = (RED) => {
	/** The last frame through each node, by id: { payload, width, height, receivedAt, png }. */
	const lastFrames = new Map();
	/** The last regions sent by each node, by id: { regions, detect, received }. */
	const lastRegions = new Map();

	function sniffImageType(buf) {
		if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
		if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
			return "image/png";
		}
		if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
			return "image/webp";
		}
		return "application/octet-stream";
	}

	/** An encoded payload as it came; a raw one as PNG, encoded once on the first request. */
	function frameBytes(entry) {
		const p = entry.payload;
		if (Buffer.isBuffer(p)) return Promise.resolve({ bytes: p, contentType: sniffImageType(p) });
		if (!entry.png) {
			entry.png = sharp(asView(p.data), { raw: { width: p.width, height: p.height, channels: p.channels } })
				.png({ compressionLevel: 1 })
				.toBuffer()
				.catch((err) => {
					entry.png = null;
					throw err;
				});
		}
		return entry.png.then((bytes) => ({ bytes, contentType: "image/png" }));
	}

	function RegionDetectNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const base = configOptions(config);

		node.on("input", async (msg, send, done) => {
			const started = performance.now();
			const ms = (from) => Math.round((performance.now() - from) * 10) / 10;
			try {
				const opts = messageOptions(base, msg.detect);
				// read-only: no copy of a raw frame's bytes
				const geometry = rawGeometry(msg, msg.payload);
				const buffer = await resolveImage(msg.payload, "msg.payload", { copy: false, raw: !!geometry });
				assertRawFits(buffer, geometry, "msg.payload");
				let frame;
				if (geometry) {
					frame = { data: buffer.subarray(0, geometry.width * geometry.height * geometry.channels), ...geometry };
				} else {
					const { data, info } = await (await sharpInput(buffer, "msg.payload")).raw().toBuffer({ resolveWithObject: true });
					frame = { data, width: info.width, height: info.height, channels: info.channels };
				}
				const receivedAt = Date.now();
				const inputMs = ms(started);

				node.status({ fill: "blue", shape: "dot", text: "detecting…" });
				const result = await detectRegions(frame, opts);

				const counts = { text: 0, barcode: 0, graphic: 0 };
				for (const r of result.regions) counts[r.kind]++;
				const detect = { frameWidth: frame.width, frameHeight: frame.height, charHeight: result.charHeight, counts };
				const timings = { inputMs, ...result.timings };
				msg.regions = result.regions;
				msg.detect = detect;
				msg.timings = timings;
				// together, so the editor never pairs a frame with another's regions;
				// copies, so a node downstream painting msg.payload or changing
				// msg.regions does not reach the endpoints
				lastFrames.set(node.id, {
					payload: geometry ? { ...frame, data: Buffer.from(frame.data) } : Buffer.from(buffer),
					width: frame.width,
					height: frame.height,
					receivedAt,
					png: null,
				});
				lastRegions.set(node.id, structuredClone({ regions: result.regions, detect, received: new Date(receivedAt).toISOString() }));
				timings.totalMs = ms(started);
				send(msg);
				node.status({
					fill: "green",
					shape: "dot",
					text: `${counts.text} text · ${counts.barcode} barcode · ${counts.graphic} graphic · ${formatMs(timings.totalMs)}`,
				});
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: statusText(err) });
				// done(err) reports through node.error once; don't also call it
				done(err);
			}
		});

		node.on("close", (removed, done) => {
			// a deleted node takes its frame and regions with it; a redeploy
			// keeps them, so the editor still has them after Deploy
			if (removed) {
				lastFrames.delete(node.id);
				lastRegions.delete(node.id);
			}
			done();
		});
	}

	RED.nodes.registerType("region-detect", RegionDetectNode);

	RED.httpAdmin.get("/region-detect/last-frame/:id", RED.auth.needsPermission("region-detect.read"), async (req, res) => {
		const entry = lastFrames.get(req.params.id);
		if (!entry) {
			res.status(404).json({ ok: false, error: "no frame yet" });
			return;
		}
		try {
			const { bytes, contentType } = await frameBytes(entry);
			res.setHeader("Content-Type", contentType);
			// the next frame replaces it, so the browser must not keep this one
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Frame-Width", String(entry.width));
			res.setHeader("X-Frame-Height", String(entry.height));
			res.setHeader("X-Frame-Received", new Date(entry.receivedAt).toISOString());
			res.end(bytes);
		} catch (err) {
			res.status(500).json({ ok: false, error: err.message });
		}
	});

	RED.httpAdmin.get("/region-detect/last-regions/:id", RED.auth.needsPermission("region-detect.read"), (req, res) => {
		const entry = lastRegions.get(req.params.id);
		if (!entry) {
			res.status(404).json({ ok: false, error: "no regions yet" });
			return;
		}
		res.setHeader("Cache-Control", "no-store");
		res.json(entry);
	});
};

// pure, for the tests
module.exports.statusText = statusText;
