/**
 * perspective-rectify Node-RED node.
 *
 * Apply the plane homography checkerboard-calibrate measured to every
 * production frame, so a camera that looks at the tray a little off-axis
 * hands label-crop and golden-compare the flat view a square-on camera
 * would. Sits between the camera and label-crop.
 *
 * The homography is a property of the rig, measured once from the
 * checkerboard photo and read back from the same scale file the mm/px
 * baseline lives in. Nothing is detected per frame - a document-scanner
 * style "find the quad and warp it" would re-solve the camera geometry on
 * every part, and would be likeliest to solve it wrongly on exactly the
 * damaged label the inspection exists to catch.
 *
 * The warp runs on the inspector's worker pool, split by rows like
 * golden-compare's own warp: ~20ms on a 1500x1850 RGB frame against
 * ~130ms serial. The native cpp-bridge has no warpPerspective and
 * opencv.js's single WASM thread measured no faster than the serial loop.
 *
 * Input (msg.payload): an encoded image Buffer, a file path string, or a
 * raw { data, width, height, channels } object (a bare raw Buffer with
 * msg.rawInfo is accepted too). Output: the rectified frame, raw by
 * default or jpg/png, plus msg.rectify with the geometry applied and the
 * timings.
 *
 * Two kinds of failure, handled differently on purpose:
 *  - setup: no scale file path, no calibration, a calibration without a
 *    homography, a corrupt file. No frame could ever pass, so done(err)
 *    - a Catch node sees it and the status goes red.
 *  - this frame: an unreadable payload, or a frame whose aspect ratio is
 *    not the calibration photo's (a different crop of the sensor). The
 *    original frame goes through unchanged with msg.rectify.applied
 *    false and a reason, the way label-crop passes a miss through, so
 *    the inspection behind this node still runs and grades it. Stalling
 *    the line on one odd frame is the wrong failure mode.
 */

const fs = require("fs");
const fsp = fs.promises;
const sharp = require("sharp");
const inspector = require("./lib/inspector.js");
const { toShared } = require("./lib/shared.js");
const { readScaleFile } = require("./lib/scaleFile.js");
const { rescaleHomography, isIdentityLike } = require("./lib/homography.js");

module.exports = (RED) => {
	const OUTPUT_FORMATS = ["raw", "jpg", "png"];
	const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

	function clampInt(value, fallback, min, max) {
		const n = parseInt(value, 10);
		if (isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function pickMode(value, fallback, allowed) {
		return allowed.includes(value) ? value : fallback;
	}

	// The guarded single-handle read golden-compare.js and
	// checkerboard-calibrate.js use, for the same reasons (see there).
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

	function isBytes(v) {
		return Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof ArrayBuffer;
	}

	// A Buffer over the same memory, never a copy: a 24MP frame is copied
	// once into shared memory for the worker and that is enough.
	function asBuffer(v) {
		if (Buffer.isBuffer(v)) return v;
		if (v instanceof ArrayBuffer) return Buffer.from(v);
		return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
	}

	function rawGeometry(source) {
		if (!source || typeof source !== "object") return undefined;
		const width = Number(source.width);
		const height = Number(source.height);
		const channels = Number(source.channels || (source.colorSpace === "GRAY" ? 1 : 0));
		if (!Number.isInteger(width) || width <= 0) return undefined;
		if (!Number.isInteger(height) || height <= 0) return undefined;
		if (!Number.isInteger(channels) || channels < 1 || channels > 4)
			return undefined;
		if (width * height > 64 * 1024 * 1024) return undefined;
		return { width, height, channels };
	}

	function checkBytes(data, label) {
		if (data.byteLength > MAX_IMAGE_BYTES) {
			throw new Error(
				`${label} is ${data.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte cap`,
			);
		}
	}

	/**
	 * Resolve msg.payload to raw pixels: { data, width, height, channels }.
	 * Raw input is used as-is (no copy beyond what shared memory needs);
	 * everything else is decoded by sharp at its native channel count.
	 */
	async function resolveRaw(msg) {
		const source = msg.payload;
		const label = "msg.payload";
		if (source == null || source === "") throw new Error(`${label} is empty`);

		let geometry;
		let bytes;
		if (isBytes(source)) {
			checkBytes(source, label);
			bytes = asBuffer(source);
			geometry = rawGeometry(msg.rawInfo);
		} else if (typeof source === "string") {
			bytes = await readRegularFile(source, label);
			if (!bytes) throw new Error(`${label} does not exist on disk: "${source}"`);
		} else if (typeof source === "object") {
			const data = source.data || source.buffer;
			if (isBytes(data)) {
				checkBytes(data, label);
				bytes = asBuffer(data);
				geometry = rawGeometry(source);
			} else if (typeof source.path === "string") {
				bytes = await readRegularFile(source.path, label);
				if (!bytes) {
					throw new Error(`${label} does not exist on disk: "${source.path}"`);
				}
			} else {
				throw new Error(
					`${label} object must contain "data"/"buffer" or an existing "path"`,
				);
			}
		} else {
			throw new Error(`unsupported ${label} type: ${typeof source}`);
		}

		if (geometry) {
			const need = geometry.width * geometry.height * geometry.channels;
			if (bytes.byteLength < need) {
				throw new Error(
					`${label} raw data is shorter than ` +
						`${geometry.width}x${geometry.height}x${geometry.channels}`,
				);
			}
			return { data: bytes.subarray(0, need), ...geometry, decoded: false };
		}
		const { data, info } = await sharp(bytes)
			.raw()
			.toBuffer({ resolveWithObject: true });
		return {
			data,
			width: info.width,
			height: info.height,
			channels: info.channels,
			decoded: true,
		};
	}

	function colorSpaceFor(channels) {
		return channels === 1 ? "GRAY" : channels === 4 ? "RGBA" : "RGB";
	}

	function PerspectiveRectifyNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.scaleFilePath = String(config.scaleFilePath || "").trim();
		node.outputFormat = pickMode(config.outputFormat, "raw", OUTPUT_FORMATS);
		node.outputQuality = clampInt(config.outputQuality, 90, 1, 100);
		// same meaning as golden-compare's: pool size for the row split,
		// 0 = one per core
		node.workers = clampInt(config.workers, 0, 0, 64);

		node.on("input", async (msg, send, done) => {
			send =
				send ||
				function () {
					node.send.apply(node, arguments);
				};
			const t0 = performance.now();
			try {
				if (!node.scaleFilePath) {
					throw new Error(
						"no scale file path configured - point this node at the file " +
							"checkerboard-calibrate saved",
					);
				}
				const scale = await readScaleFile(node.scaleFilePath);
				if (scale && scale.error) throw new Error(scale.error);
				if (!scale) {
					throw new Error(
						`no calibration at "${node.scaleFilePath}" - run ` +
							`checkerboard-calibrate with msg.save:true first`,
					);
				}
				if (!scale.homography) {
					throw new Error(
						`calibration at "${node.scaleFilePath}" has no homography - it was ` +
							`saved by an older checkerboard-calibrate; re-run it with msg.save:true`,
					);
				}

				// From here on a failure is this frame's, not the rig's: pass
				// the frame through and say why, once per distinct reason.
				const passThrough = (reason, err) => {
					msg.rectify = {
						applied: false,
						reason,
						error: err.message,
						homography: null,
						timings: { totalMs: Math.round(performance.now() - t0) },
					};
					node.status({
						fill: "yellow",
						shape: "ring",
						text: `not rectified (${reason})`,
					});
					if (node.lastPassWarning !== reason) {
						node.lastPassWarning = reason;
						node.warn(`perspective-rectify: ${err.message} - frame passed through unrectified`);
					}
					send(msg);
					done();
				};

				let frame;
				try {
					frame = await resolveRaw(msg);
				} catch (err) {
					return passThrough("input", err);
				}
				const decodeMs = performance.now() - t0;

				// The homography is in the calibration photo's pixels. A frame
				// at another resolution of the same field of view is fine; a
				// different aspect ratio is a different crop of the sensor and
				// cannot be rectified with this calibration.
				let homography;
				try {
					homography = rescaleHomography(
						scale.homography,
						{ width: scale.nativeWidth, height: scale.nativeHeight },
						{ width: frame.width, height: frame.height },
					);
				} catch (err) {
					return passThrough("aspect-mismatch", err);
				}
				node.lastPassWarning = null;
				const identity = isIdentityLike(homography, 1e-12);

				const tWarp = performance.now();
				let out;
				if (identity) {
					out = frame;
				} else {
					const shared = toShared(frame.data);
					out = (
						await inspector.rectify({
							frame: shared,
							width: frame.width,
							height: frame.height,
							channels: frame.channels,
							homography,
							workers: clampInt(msg.workers, node.workers, 0, 64),
						})
					).result;
				}
				const warpMs = performance.now() - tWarp;

				const tEncode = performance.now();
				const outputFormat = pickMode(msg.outputFormat, node.outputFormat, OUTPUT_FORMATS);
				if (outputFormat === "raw") {
					msg.payload = {
						data: Buffer.isBuffer(out.data)
							? out.data
							: Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength),
						width: out.width,
						height: out.height,
						channels: out.channels,
						colorSpace: colorSpaceFor(out.channels),
						dtype: "uint8",
					};
				} else {
					let pipeline = sharp(out.data, {
						raw: { width: out.width, height: out.height, channels: out.channels },
					});
					pipeline =
						outputFormat === "jpg"
							? pipeline.jpeg({ quality: node.outputQuality })
							: pipeline.png();
					msg.payload = await pipeline.toBuffer();
				}
				const encodeMs = performance.now() - tEncode;

				msg.rectify = {
					applied: !identity,
					reason: identity ? "identity" : "ok",
					homography,
					width: out.width,
					height: out.height,
					channels: out.channels,
					rescaledFrom:
						scale.nativeWidth === frame.width && scale.nativeHeight === frame.height
							? null
							: { width: scale.nativeWidth, height: scale.nativeHeight },
					perspective: scale.perspective || null,
					timings: {
						decodeMs: Math.round(decodeMs),
						warpMs: Math.round(warpMs),
						encodeMs: Math.round(encodeMs),
						totalMs: Math.round(performance.now() - t0),
					},
				};
				node.status({
					fill: "green",
					shape: "dot",
					text: identity
						? `identity · ${out.width}×${out.height}`
						: `rectified ${out.width}×${out.height} · ${msg.rectify.timings.warpMs}ms`,
				});
				send(msg);
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: "error" });
				done(err);
			}
		});
	}

	RED.nodes.registerType("perspective-rectify", PerspectiveRectifyNode);
};
