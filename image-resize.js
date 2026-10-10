/**
 * image-resize Node-RED node ("resize" in the palette).
 *
 * Scale a frame by a factor or to a size, on the OpenCV engine lib/engine.js
 * picks (@graciousstar/opencv5, else opencv.js): INTER_LINEAR, the filter
 * label-crop and golden-compare's own working copies use. It replaces the
 * rp-resize node of @rosepetal/node-red-contrib-image-tools, which flows
 * used to bring frames and goldens to the inspection scale; its width and
 * height rules are rp-resize's for the modes this node keeps:
 *
 *   multiply  round(side x factor)
 *   set       that many pixels
 *   auto      from the other side, keeping the aspect ratio:
 *             round(otherOut x side / otherIn)
 *
 * Input (at the configured path, msg.payload by default): a raw
 * { data, width, height, channels, colorSpace } object, a bare raw Buffer
 * with msg.rawInfo (or pdf-to-image's msg.images), an encoded image Buffer
 * (decoded by sharp at its own channel count), or a file path. Output (at
 * the configured path): the same raw object shape, or an encoded png/jpg
 * Buffer.
 *
 * A bad input or an impossible size is this message's error: done(err),
 * red status, nothing sent - a frame at the wrong scale downstream would
 * be graded against the wrong golden scale, which is worse than a gap.
 */

"use strict";

const sharp = require("sharp");
const { formatMs } = require("./lib/formatMs.js");
const {
	clampInt,
	pickMode,
	isBytes,
	assertUnderCap,
	readRegularFile,
	rawGeometry,
	assertRawFits,
} = require("./lib/nodeInput.js");

// the editor's defaults (image-resize.html), and what a config missing a
// key falls back to
const SETTINGS = {
	inputPath: { value: "payload" },
	outputPath: { value: "payload" },
	widthMode: { value: "multiply" },
	widthValue: { value: "0.5" },
	heightMode: { value: "auto" },
	heightValue: { value: "" },
	outputFormat: { value: "raw" },
	outputQuality: { value: 90 },
};

const SIZE_MODES = ["multiply", "set", "auto"];
const OUTPUT_FORMATS = ["raw", "png", "jpg"];
const COLOR_SPACES = { 1: "GRAY", 3: "RGB", 4: "RGBA" };

/** A dotted msg path ("payload", "frame.image"); no brackets. */
function getPath(msg, p) {
	return String(p)
		.split(".")
		.reduce((o, k) => (o == null ? undefined : o[k]), msg);
}

function setPath(msg, p, value) {
	const keys = String(p).split(".");
	let o = msg;
	for (const k of keys.slice(0, -1)) {
		if (o[k] == null || typeof o[k] !== "object") o[k] = {};
		o = o[k];
	}
	o[keys[keys.length - 1]] = value;
}

function asBuffer(v) {
	if (Buffer.isBuffer(v)) return v;
	if (v instanceof ArrayBuffer) return Buffer.from(v);
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** The input as a raw descriptor the engine takes; `decoded` when it came
 * through sharp. */
async function resolveRaw(msg, source, label) {
	if (source == null || source === "") throw new Error(`${label} is empty`);
	let bytes;
	let geometry;
	let colorSpace;
	if (typeof source === "string") {
		bytes = await readRegularFile(source, label);
		if (!bytes) throw new Error(`${label} does not exist on disk: "${source}"`);
	} else if (isBytes(source)) {
		assertUnderCap(source, label);
		bytes = asBuffer(source);
		geometry = rawGeometry(msg, source);
	} else if (typeof source === "object" && isBytes(source.data)) {
		assertUnderCap(source.data, label);
		bytes = asBuffer(source.data);
		geometry = rawGeometry(msg, source);
		if (!geometry) throw new Error(`${label} has data but no usable width/height/channels`);
		colorSpace = typeof source.colorSpace === "string" ? source.colorSpace.toUpperCase() : undefined;
		if (source.dtype !== undefined && source.dtype !== "uint8") {
			throw new Error(`${label} is ${source.dtype}; only uint8 images are supported`);
		}
	} else {
		throw new Error(`${label} must be an image object, a Buffer or a file path`);
	}
	if (geometry) {
		assertRawFits(bytes, geometry, label);
		if (geometry.channels === 2) throw new Error(`${label} has 2 channels; give it 1, 3 or 4`);
		const need = geometry.width * geometry.height * geometry.channels;
		return {
			image: {
				data: bytes.subarray(0, need),
				...geometry,
				colorSpace: colorSpace || COLOR_SPACES[geometry.channels],
				dtype: "uint8",
			},
			decoded: false,
		};
	}
	let { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
	if (info.channels === 2) {
		({ data, info } = await sharp(bytes).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
	}
	return {
		image: {
			data,
			width: info.width,
			height: info.height,
			channels: info.channels,
			colorSpace: COLOR_SPACES[info.channels],
			dtype: "uint8",
		},
		decoded: true,
	};
}

/**
 * The output size, as rp-resize computed it. Throws on a size that cannot
 * be made (both sides auto, a non-positive factor or size).
 */
function targetSize(width, height, { widthMode, widthValue, heightMode, heightValue }) {
	const side = (mode, value, input, name) => {
		if (mode === "auto") return null;
		const n = Number(value);
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`${name} ${mode === "multiply" ? "factor" : "size"} must be a positive number, got "${value}"`);
		}
		return mode === "multiply" ? Math.round(input * n) : Math.round(n);
	};
	let w = side(widthMode, widthValue, width, "width");
	let h = side(heightMode, heightValue, height, "height");
	if (w === null && h === null) throw new Error("width and height cannot both be auto");
	if (w === null) w = Math.round((h * width) / height);
	if (h === null) h = Math.round((w * height) / width);
	if (w < 1 || h < 1) throw new Error(`the output would be ${w}x${h}`);
	if (w * h > 64 * 1024 * 1024) throw new Error(`the output would be ${w}x${h}, past 64 megapixels`);
	return { width: w, height: h };
}

module.exports = (RED) => {
	function ImageResizeNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const get = (k) => (config[k] === undefined ? SETTINGS[k].value : config[k]);
		node.inputPath = String(get("inputPath") || SETTINGS.inputPath.value);
		node.outputPath = String(get("outputPath") || SETTINGS.outputPath.value);
		node.size = {
			widthMode: pickMode(get("widthMode"), SETTINGS.widthMode.value, SIZE_MODES),
			widthValue: get("widthValue"),
			heightMode: pickMode(get("heightMode"), SETTINGS.heightMode.value, SIZE_MODES),
			heightValue: get("heightValue"),
		};
		node.outputFormat = pickMode(get("outputFormat"), SETTINGS.outputFormat.value, OUTPUT_FORMATS);
		node.outputQuality = clampInt(get("outputQuality"), SETTINGS.outputQuality.value, [1, 100]);
		// a size the configuration can never make is a setup error, said once
		// at deploy rather than on every message
		try {
			targetSize(100, 100, node.size);
		} catch (err) {
			node.status({ fill: "red", shape: "ring", text: err.message.slice(0, 60) });
		}

		node.on("input", async (msg, send, done) => {
			send =
				send ||
				function () {
					node.send.apply(node, arguments);
				};
			const t0 = performance.now();
			try {
				const selected = await require("./lib/engine.js").resolve();
				if (!selected.engine) {
					throw new Error(
						"no OpenCV engine - no @graciousstar/opencv5 binary loads here and " +
							"@techstark/opencv-js is not installed" +
							(selected.error ? ` (${selected.error.message})` : ""),
					);
				}
				const label = `msg.${node.inputPath}`;
				const { image } = await resolveRaw(msg, getPath(msg, node.inputPath), label);
				const size = targetSize(image.width, image.height, node.size);
				const fmt = node.outputFormat === "jpg" ? "jpg" : node.outputFormat;
				const out = await selected.engine.resize(image, "num", size.width, "num", size.height, fmt, node.outputQuality);
				const result = out.image;
				if (node.outputFormat === "raw") {
					setPath(msg, node.outputPath, {
						data: Buffer.isBuffer(result.data) ? result.data : asBuffer(result.data),
						width: result.width,
						height: result.height,
						channels: result.channels,
						colorSpace: result.colorSpace || COLOR_SPACES[result.channels],
						dtype: "uint8",
					});
				} else {
					setPath(msg, node.outputPath, result);
				}
				node.status({
					fill: "green",
					shape: "dot",
					text: `${image.width}×${image.height} → ${size.width}×${size.height} · ${selected.name} · ${formatMs(performance.now() - t0)}`,
				});
				send(msg);
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: err.message.slice(0, 60) });
				done(err);
			}
		});
	}

	RED.nodes.registerType("image-resize", ImageResizeNode);
};

module.exports.targetSize = targetSize;
