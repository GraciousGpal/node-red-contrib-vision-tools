/**
 * checkerboard-calibrate Node-RED node.
 *
 * A calibration step for a fixed camera rig:
 * photograph a printed checkerboard of known physical pitch, measure the
 * detected pixel pitch, and compare the resulting mm/px scale against a
 * previously-saved baseline. Detection/measurement lives in
 * lib/checkerboard.js so it can be exercised outside Node-RED.
 *
 * Run this once at commissioning and again after camera/mechanical
 * maintenance - not per production frame.
 *
 * Input (msg.payload): Buffer / Uint8Array / ArrayBuffer with image bytes,
 * a file path string, or an object { data | buffer | path } - a photo of
 * the printed checkerboard.
 * msg.save (bool): persist the freshly detected scale as the new
 * baseline (their "Match New Scale" + "Save").
 *
 * The same photo also yields the camera's plane homography - how far
 * off-axis it looks at the tray - which is saved alongside the scale for
 * perspective-rectify to apply per frame. See measurePerspective in
 * lib/checkerboard.js.
 */

const fs = require("fs");
const fsp = fs.promises;
const inspector = require("./lib/inspector.js");
const { toShared } = require("./lib/shared.js");
const { readScaleFile, writeScaleFile } = require("./lib/scaleFile.js");

module.exports = (RED) => {
	function clampInt(value, fallback, min, max) {
		const n = parseInt(value, 10);
		if (isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function clampFloat(value, fallback, min, max) {
		const n = parseFloat(value);
		if (isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	// Same input caps as golden-compare.js: an unbounded buffer would be
	// copied on every message for no measurement value, and an unbounded
	// path read would hang or OOM on a special file like /dev/zero.
	const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

	/**
	 * Read an image file through one handle: open -> fstat -> guards ->
	 * read. The guards are the point - see golden-compare.js's twin. A
	 * pathExists() then readFile() pair is a race, and an unguarded path
	 * read lets a flow point msg.payload at /dev/zero and hang the node.
	 * Returns null when the path does not exist, so callers can keep
	 * distinguishing "missing" from "refused".
	 */
	async function readRegularFile(p, label) {
		let fd;
		try {
			fd = await fsp.open(p, fs.constants.O_RDONLY);
		} catch (err) {
			if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
			throw err;
		}
		try {
			const stat = await fd.stat();
			if ((stat.mode & fs.constants.S_IFMT) !== fs.constants.S_IFREG) {
				throw new Error(
					`${label} is not a regular file: "${p}" - refusing to read it`,
				);
			}
			if (stat.size > MAX_IMAGE_BYTES) {
				throw new Error(
					`${label} is ${stat.size} bytes, above the ${MAX_IMAGE_BYTES}-byte cap: "${p}"`,
				);
			}
			return await fd.readFile();
		} finally {
			await fd.close();
		}
	}

	// same resolveImage contract as golden-compare.js
	async function resolveImage(source, label) {
		if (source == null || source === "") {
			throw new Error(`${label} is empty`);
		}
		if (
			Buffer.isBuffer(source) ||
			source instanceof Uint8Array ||
			source instanceof ArrayBuffer
		) {
			if (source.byteLength > MAX_IMAGE_BYTES) {
				throw new Error(
					`${label} is ${source.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte cap`,
				);
			}
			return Buffer.from(source);
		}
		if (typeof source === "string") {
			const file = await readRegularFile(source, label);
			if (!file) throw new Error(`${label} does not exist on disk: "${source}"`);
			return file;
		}
		if (typeof source === "object") {
			const data = source.data || source.buffer;
			if (
				Buffer.isBuffer(data) ||
				data instanceof Uint8Array ||
				data instanceof ArrayBuffer
			) {
				if (data.byteLength > MAX_IMAGE_BYTES) {
					throw new Error(
						`${label} is ${data.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte cap`,
					);
				}
				return Buffer.from(data);
			}
			if (typeof source.path === "string") {
				const file = await readRegularFile(source.path, label);
				if (file) return file;
			}
			throw new Error(
				`${label} object must contain "data"/"buffer" or an existing "path"`,
			);
		}
		throw new Error(`unsupported ${label} type: ${typeof source}`);
	}

	function round(v) {
		return Math.round(v * 1000) / 1000;
	}

	function fmtMs(ms) {
		return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
	}

	function CheckerboardCalibrateNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.targetPitchMm = clampFloat(config.targetPitchMm, 10, 0.01, 10000);
		node.checkerboardCols = clampInt(config.checkerboardCols, 4, 2, 100);
		node.checkerboardRows = clampInt(config.checkerboardRows, 6, 3, 100);
		node.allowedErrorPercent = clampFloat(config.allowedErrorPercent, 2, 0, 100);
		node.scaleFilePath = String(config.scaleFilePath || "").trim();

		node.on("input", async (msg, send, done) => {
			send =
				send ||
				function () {
					node.send.apply(node, arguments);
				};
			const totalStart = performance.now();
			try {
				if (!node.scaleFilePath) {
					throw new Error(
						"no scale file path configured - set where the calibration baseline should be saved/read",
					);
				}
				const cfg = {
					targetPitchMm: clampFloat(
						msg.targetPitchMm,
						node.targetPitchMm,
						0.01,
						10000,
					),
					checkerboardCols: clampInt(
						msg.checkerboardCols,
						node.checkerboardCols,
						2,
						100,
					),
					checkerboardRows: clampInt(
						msg.checkerboardRows,
						node.checkerboardRows,
						3,
						100,
					),
					allowedErrorPercent: clampFloat(
						msg.allowedErrorPercent,
						node.allowedErrorPercent,
						0,
						100,
					),
				};

				const buffer = await resolveImage(msg.payload, "msg.payload");

				node.status({
					fill: "blue",
					shape: "dot",
					text: "detecting checkerboard…",
				});
				// Off the event loop, like golden-compare: this runs at full
				// sensor resolution with no downscale, which measured ~59ms of
				// synchronous work on a 5520x4140 capture and more when a board
				// is actually found.
				const measured = (
					await inspector.calibrate({ cfg, image: toShared(buffer).buffer })
				).result;

				if (!measured.detected) {
					msg.payload = false;
					msg.result = {
						checkerboardDetected: false,
						reason: measured.reason,
						pass: false,
					};
					msg.timings = { totalMs: Math.round(performance.now() - totalStart) };
					send(msg);
					node.status({ fill: "red", shape: "ring", text: "not detected" });
					node.warn(`checkerboard-calibrate: not detected - ${measured.reason}`);
					done();
					return;
				}

				const baseline = await readScaleFile(node.scaleFilePath);
				const detectedScale = measured.mmPerPixel;
				const currentScale = baseline ? baseline.mmPerPixelNative : null;
				const bootstrap = currentScale == null;
				if (bootstrap && !msg.save) {
					// Bootstrap mode is informational only - nothing is persisted
					// unless the message says so. The status line reads like
					// success, so say plainly that the scale was not saved, or an
					// operator walks away thinking the rig is calibrated.
					node.warn(
						`checkerboard-calibrate: detected ${detectedScale.toFixed(5)}mm/px but nothing was saved - ` +
							`send msg.save:true to persist this as the baseline`,
					);
				}
				const deviationPercent = bootstrap
					? null
					: (Math.abs(detectedScale - currentScale) / currentScale) * 100;
				const pass = bootstrap || deviationPercent <= cfg.allowedErrorPercent;

				// The homography is stored as measured; whether it is worth
				// applying is the flow author's call, made on the
				// before/after pixels reported here. Rounded so the file
				// reads as a record rather than sixteen digits of float.
				const { homography, ...perspectiveStats } = measured.perspective;
				const perspective = {
					rmsBeforePx: round(perspectiveStats.rmsBeforePx),
					maxBeforePx: round(perspectiveStats.maxBeforePx),
					rmsAfterPx: round(perspectiveStats.rmsAfterPx),
					maxAfterPx: round(perspectiveStats.maxAfterPx),
					maxCornerShiftPx: round(perspectiveStats.maxCornerShiftPx),
					boardAngleDeg: round(perspectiveStats.boardAngleDeg),
					points: perspectiveStats.points,
				};

				let saved = false;
				if (msg.save) {
					await writeScaleFile(node.scaleFilePath, {
						mmPerPixelNative: detectedScale,
						nativeWidth: measured.width,
						nativeHeight: measured.height,
						homography,
						perspective,
						calibratedAt: new Date().toISOString(),
					});
					saved = true;
				}

				msg.payload = pass;
				msg.result = {
					checkerboardDetected: true,
					currentScale: saved ? detectedScale : currentScale,
					detectedScale,
					deviationPercent,
					bootstrap,
					pass,
					saved,
					pitchXPx: measured.pitchXPx,
					pitchYPx: measured.pitchYPx,
					nativeWidth: measured.width,
					nativeHeight: measured.height,
					perspective: { homography, ...perspective },
				};
				msg.timings = { totalMs: Math.round(performance.now() - totalStart) };
				send(msg);

				const statusText = bootstrap
					? `no baseline · ${detectedScale.toFixed(5)}mm/px${saved ? " · saved" : ""}`
					: `${pass ? "pass" : "fail"} · dev ${deviationPercent.toFixed(2)}%${saved ? " · saved" : ""}`;
				node.status({
					fill: bootstrap ? "blue" : pass ? "green" : "red",
					shape: bootstrap ? "dot" : pass ? "dot" : "ring",
					text: statusText,
				});
				node.log(
					`checkerboard-calibrate: detected=${detectedScale.toFixed(6)}mm/px ` +
						`current=${currentScale == null ? "none" : currentScale.toFixed(6)} ` +
						`deviation=${deviationPercent == null ? "n/a" : deviationPercent.toFixed(2) + "%"} ` +
						`pass=${pass} saved=${saved} ` +
						`keystone=${perspective.rmsBeforePx}px rms (${perspective.maxBeforePx}px max), ` +
						`${perspective.rmsAfterPx}px left after the homography · ` +
						`total ${fmtMs(msg.timings.totalMs)}`,
				);
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

	RED.nodes.registerType("checkerboard-calibrate", CheckerboardCalibrateNode);
};
