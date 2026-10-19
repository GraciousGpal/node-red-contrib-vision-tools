/**
 * text-inspect Node-RED node.
 *
 * Reads the printed text in rectangular regions of an image with
 * lib/ocr.js (PP-OCR line recognition) and reports what it read, with a
 * confidence per character. No grading: there is no expected text.
 *
 * Regions are { name, x, y, width, height, rotate } in pixels: rotate (0,
 * 90, 180 or 270, a number or numeric string, default 0) turns the crop
 * clockwise before reading, so 270 reads text running top to bottom and 90
 * text running bottom to top; any other value fails the message, naming
 * the region. msg.regions (an
 * array or its JSON string, in the incoming frame's pixels) replaces the
 * configured list; an empty or invalid msg.regions fails the message, it
 * never falls back to the configured list. An item with a kind string
 * (region-detect's output) is read only when kind is exactly "text"
 * (case-sensitive; a kind that is not a string counts as absent), a list
 * with items but none of kind text fails the message, and unnamed items
 * are named by their position in the whole list. Configured regions
 * are drawn on a frame of frameWidth x frameHeight; when both are > 0 and the frame
 * differs, they are scaled by the width and height ratios (0: unknown, no
 * scaling). Every region is then clamped to the frame; one left empty, or
 * with a coordinate that is not a number, fails the message, naming it.
 *
 * Input (msg.payload): Buffer / Uint8Array / ArrayBuffer with image bytes,
 * a file path string, or an object { data | buffer | path }; bare pixels
 * as { data, width, height, channels } or bytes plus msg.rawInfo.
 *
 * Output: one message per input, msg.payload and every other field as
 * they came, plus msg.ocr - one { name, roi, rotate, text, confidences,
 * lines } per region in order, roi in the frame's pixels after scaling,
 * confidences 0..1 at 3 decimals - and msg.timings. A region over several
 * printed lines is split into lines by its ink rows and each is read:
 * lines is [{ text, confidences, y0, y1 }] top to bottom, y0..y1 the rows
 * in the upright crop; text joins the line texts with "\n" and each "\n"
 * has confidence 1. Lines that read nothing are left out. Failures go to
 * done(err) only.
 *
 * msg.timings, ms with one decimal: inputMs (resolving and decoding
 * msg.payload), cropMs (cropping, turning and the ink profile of every
 * region), inferMs (resize, model run and decode of every band of every
 * region), totalMs (message in to message out, a first
 * frame's wait for the model included). The status shows totalMs.
 *
 * GET /text-inspect/last-frame/:id (permission text-inspect.read) serves
 * the last frame through the node for the editor: 404 before any input,
 * then the bytes as they came (a raw frame as PNG) with X-Frame-Width,
 * X-Frame-Height, X-Frame-Received and Cache-Control: no-store. The frame
 * is kept across a redeploy and deleted when the node is removed.
 */

const sharp = require("sharp");
const { performance } = require("node:perf_hooks");
const ocr = require("./lib/ocr.js");
const { resolveImage, rawGeometry, assertRawFits, asView, clampInt } = require("./lib/nodeInput.js");
const { formatMs } = require("./lib/formatMs.js");

// regions are clamped to the frame later; this only keeps the arithmetic sane
const LIMIT = 1e6;

/**
 * An error as status badge text: no "text-inspect: " prefix, at most 60
 * characters, and no file paths or names (done(err) keeps them). Every
 * quoted string, single or double, holding / or \ becomes "…" in its own
 * quotes; a msg.payload message only ever quotes the payload path, so all
 * its double-quoted strings go too.
 */
function statusText(err) {
	let text = String(err && err.message ? err.message : err).replace(/^text-inspect: /, "");
	if (text.startsWith("msg.payload")) text = text.replace(/"[^"]*"/g, '"…"');
	text = text.replace(/"[^"]*[/\\][^"]*"/g, '"…"').replace(/'[^']*[/\\][^']*'/g, "'…'");
	return text.slice(0, 60);
}

module.exports = (RED) => {
	/** The last frame through each node, by id: { payload, width, height, receivedAt, png }. */
	const lastFrames = new Map();

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

	/** A coordinate as a finite number (numeric strings read as numbers), else NaN. */
	function finite(v) {
		const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
		return Number.isFinite(n) ? n : NaN;
	}

	/**
	 * An array or its JSON string to [{ name, x, y, width, height, rotate }].
	 * Not JSON, not an array, an entry that is not an object, a coordinate
	 * that is not a finite number or a rotate other than 0, 90, 180 or 270
	 * (absent is 0): an error naming `label`, the region and
	 * the field, so a bad list never reads the wrong area.
	 */
	function normalizeRegions(list, label) {
		let items = list;
		if (typeof items === "string") {
			// an empty field is no regions (the caller says so), not bad JSON
			if (items.trim() === "") return [];
			try {
				items = JSON.parse(items);
			} catch (err) {
				throw new Error(`text-inspect: ${label} is not valid JSON: ${err.message}`);
			}
		}
		if (items == null) return [];
		if (!Array.isArray(items)) throw new Error(`text-inspect: ${label} is not an array of regions`);
		// region-detect's output: only its text boxes are for reading; names
		// and errors keep each item's position in the whole list
		const out = [];
		items.forEach((r, i) => {
			if (typeof (r && r.kind) === "string" && r.kind !== "text") return;
			if (!r || typeof r !== "object") throw new Error(`text-inspect: ${label}[${i}] is not a region object`);
			const name = String(r.name == null ? "" : r.name).trim() || `region${i + 1}`;
			const region = { name };
			for (const key of ["x", "y", "width", "height"]) {
				const n = finite(r[key]);
				if (Number.isNaN(n)) {
					throw new Error(`text-inspect: region "${name}" has ${key} ${JSON.stringify(r[key])}, not a number`);
				}
				region[key] = Math.min(LIMIT, Math.max(-LIMIT, n));
			}
			const rotate = r.rotate == null || r.rotate === "" ? 0 : finite(r.rotate);
			if (![0, 90, 180, 270].includes(rotate)) {
				throw new Error(`text-inspect: region "${name}" has rotate ${JSON.stringify(r.rotate)}, not 0, 90, 180 or 270`);
			}
			region.rotate = rotate;
			out.push(region);
		});
		if (items.length && !out.length) throw new Error(`text-inspect: no text regions in ${label}`);
		return out;
	}

	/** A region scaled from the drawing-time frame and clamped to this one, in whole pixels. */
	function placeRegion(r, sx, sy, width, height) {
		const x = r.x * sx;
		const y = r.y * sy;
		const w = r.width * sx;
		const h = r.height * sy;
		const x0 = Math.max(0, Math.round(x));
		const y0 = Math.max(0, Math.round(y));
		const x1 = Math.min(width, Math.round(x + w));
		const y1 = Math.min(height, Math.round(y + h));
		if (!(x1 > x0 && y1 > y0)) {
			const d = (v) => Math.round(v * 10) / 10;
			throw new Error(
				`text-inspect: region "${r.name}" (x ${d(x)}, y ${d(y)}, width ${d(w)}, height ${d(h)}) ` +
					`is empty inside the ${width}x${height} frame`,
			);
		}
		return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
	}

	function TextInspectNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		// checked per message, so a bad list fails the message that uses it
		const configRegions = config.regions;
		node.frameWidth = clampInt(config.frameWidth, 0, [0, 1e6]);
		node.frameHeight = clampInt(config.frameHeight, 0, [0, 1e6]);

		// load the model at deploy rather than on the first frame; a frame
		// arriving first waits for it, and the failure reaches that frame too
		ocr.loadModel().catch((err) => {
			node.warn(`text-inspect: the OCR model did not load: ${err.message}`);
			node.status({ fill: "red", shape: "ring", text: "model did not load" });
		});

		node.on("input", async (msg, send, done) => {
			const started = performance.now();
			const ms = (from) => Math.round((performance.now() - from) * 10) / 10;
			try {
				// read-only: no copy of a raw frame's bytes
				const buffer = await resolveImage(msg.payload, "msg.payload", { copy: false });
				const geometry = rawGeometry(msg, msg.payload);
				assertRawFits(buffer, geometry, "msg.payload");
				let frame;
				if (geometry) {
					frame = { data: buffer, ...geometry };
				} else {
					const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
					frame = { data, width: info.width, height: info.height, channels: info.channels };
				}
				lastFrames.set(node.id, {
					payload: geometry ? frame : buffer,
					width: frame.width,
					height: frame.height,
					receivedAt: Date.now(),
					png: null,
				});
				const inputMs = ms(started);

				const fromMsg = msg.regions !== undefined;
				const regions = fromMsg
					? normalizeRegions(msg.regions, "msg.regions")
					: normalizeRegions(configRegions, "the configured regions");
				if (!regions.length) throw new Error("text-inspect: no regions to read");
				// msg.regions are already in this frame's pixels; only drawn ones scale
				const scaled = !fromMsg && node.frameWidth > 0 && node.frameHeight > 0;
				const sx = scaled ? frame.width / node.frameWidth : 1;
				const sy = scaled ? frame.height / node.frameHeight : 1;
				const rois = regions.map((r) => placeRegion(r, sx, sy, frame.width, frame.height));

				node.status({ fill: "blue", shape: "dot", text: `reading ${regions.length} region${regions.length === 1 ? "" : "s"}…` });

				let cropMs = 0;
				let inferMs = 0;
				const read = [];
				for (let i = 0; i < regions.length; i++) {
					const r = await ocr.recognise(frame, rois[i], { rotate: regions[i].rotate });
					cropMs += r.cropMs;
					inferMs += r.inferMs;
					read.push({ name: regions[i].name, roi: rois[i], rotate: regions[i].rotate, text: r.text, confidences: r.confidences, lines: r.lines });
				}

				const timings = {
					inputMs,
					cropMs: Math.round(cropMs * 10) / 10,
					inferMs: Math.round(inferMs * 10) / 10,
					totalMs: 0,
				};
				msg.ocr = read;
				msg.timings = timings;
				timings.totalMs = ms(started);
				send(msg);
				node.status({
					fill: "green",
					shape: "dot",
					text: `${regions.length} region${regions.length === 1 ? "" : "s"} · ${formatMs(timings.totalMs)}`,
				});
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: statusText(err) });
				// done(err) reports through node.error once; don't also call it
				done(err);
			}
		});

		node.on("close", (removed, done) => {
			// a deleted node takes its frame with it; a redeploy keeps it, so
			// the editor still has a picture to draw on after Deploy
			if (removed) lastFrames.delete(node.id);
			done();
		});
	}

	RED.nodes.registerType("text-inspect", TextInspectNode);

	RED.httpAdmin.get("/text-inspect/last-frame/:id", RED.auth.needsPermission("text-inspect.read"), async (req, res) => {
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
};

// pure, for the tests
module.exports.statusText = statusText;
