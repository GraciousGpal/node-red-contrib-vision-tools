/**
 * label-crop: deskew-and-crop a physical label out of a camera frame.
 *
 * Input (msg.payload): an encoded image Buffer or a raw
 * { data, width, height, channels } object - the same image shapes the
 * golden-compare node accepts.
 *
 * Output: on a successful detection, msg.payload is replaced with the
 * deskewed, tightly cropped label (raw by default, or jpg/png/webp) and
 * msg.labelCrop carries the detection metadata. On a normal detection
 * miss the original payload passes through unchanged with
 * msg.labelCrop.detected === false, so a flow downstream keeps working
 * while the detection is getting tuned.
 *
 * The heavy pixel work runs in OpenCV (decoded once, low-res Otsu,
 * ROI-only rotation, final crop in the engine): either the
 * @rosepetal/node-red-contrib-image-tools native addon or the
 * @techstark/opencv-js WASM build, whichever lib/engine.js finds. If
 * neither can be loaded, this is a **setup error** (done(err)), never a
 * silent pass-through - otherwise a missing binary would look like "no
 * label found" on every frame.
 */

const { performance } = require("node:perf_hooks");

module.exports = (RED) => {
	const { labelCrop, available, getBridge } = require("./lib/labelCrop.js");

	// Settle the engine choice and pay its start-up cost now rather than on
	// the first frame: the WASM build takes ~200ms to instantiate, and the
	// native addon's own load result is only knowable asynchronously.
	require("./lib/engine.js")
		.warmup()
		.catch(() => {
			// availability is reported per message, where it can reach a flow
		});

	const POLARITIES = ["auto", "light", "dark"];
	const BOUNDARY_MODES = ["blob", "calipers"];
	const OUTPUT_FORMATS = ["raw", "jpg", "png", "webp"];
	const BOUNDS = {
		maxEdge: [64, 4096],
		minAreaFraction: [0.001, 0.9],
		maxAreaFraction: [0.01, 0.999],
		minRectangularity: [0.05, 1],
		maxBorderContact: [0, 1],
		minDominance: [1.01, 100],
		minConfidence: [0.01, 1],
		aspectRatio: [0.05, 20],
		aspectTolerance: [0.01, 1],
		expectedSizeFraction: [0.001, 0.99],
		sizeTolerance: [0.01, 1],
		cropMargin: [0, 0.25],
		minRotateAngleDeg: [0, 10],
		outputQuality: [1, 100],
		previewWidth: [80, 600],
	};

	function clampInt(value, fallback, [min, max]) {
		const n = parseInt(value, 10);
		if (Number.isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function clampFloat(value, fallback, [min, max]) {
		const n = parseFloat(value);
		if (Number.isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function pickMode(value, fallback, allowed) {
		return allowed.includes(value) ? value : fallback;
	}

	function asBoolean(value, fallback = false) {
		if (value == null || value === "") return fallback;
		return value === true || value === "true";
	}

	async function previewJpeg(image, width) {
		const result = await getBridge().resize(
			image,
			"num",
			width,
			"num",
			0,
			"jpg",
			75,
			false,
		);
		if (!Buffer.isBuffer(result.image)) {
			throw new Error("preview resize did not return a JPEG Buffer");
		}
		return result.image.toString("base64");
	}

	async function publishPreview(node, beforeImage, afterImage, width) {
		if (!RED.comms || typeof RED.comms.publish !== "function") return;
		const before = await previewJpeg(beforeImage, width);
		const after =
			afterImage === beforeImage ? before : await previewJpeg(afterImage, width);
		RED.comms.publish("label-crop-preview", {
			id: node.id,
			before,
			after,
			mimeType: "jpeg",
			previewWidth: width,
		});
	}

	function LabelCropNode(config) {
		RED.nodes.createNode(this, config);

		// The four search regions are stored as JSON in the editor because
		// they are a nested structure, not a scalar; a parse failure is a
		// configuration error worth surfacing at deploy rather than on the
		// first frame.
		let configuredRegions = null;
		if (config.edgeRegions && String(config.edgeRegions).trim()) {
			try {
				configuredRegions = JSON.parse(config.edgeRegions);
			} catch (err) {
				this.error(`label-crop: edgeRegions is not valid JSON - ${err.message}`);
			}
		}

		const defaults = {
			boundaryMode: pickMode(config.boundaryMode, "blob", BOUNDARY_MODES),
			edgeRegions: configuredRegions,
			maxEdge: clampInt(config.maxEdge, 640, BOUNDS.maxEdge),
			polarity: pickMode(config.polarity, "auto", POLARITIES),
			minAreaFraction: clampFloat(
				config.minAreaFraction,
				0.05,
				BOUNDS.minAreaFraction,
			),
			maxAreaFraction: clampFloat(
				config.maxAreaFraction,
				0.9,
				BOUNDS.maxAreaFraction,
			),
			minRectangularity: clampFloat(
				config.minRectangularity,
				0.4,
				BOUNDS.minRectangularity,
			),
			maxBorderContact: clampFloat(
				config.maxBorderContact,
				0.5,
				BOUNDS.maxBorderContact,
			),
			minDominance: clampFloat(config.minDominance, 1.5, BOUNDS.minDominance),
			minConfidence: clampFloat(config.minConfidence, 0.4, BOUNDS.minConfidence),
			aspectRatio:
				config.aspectRatio === "" || config.aspectRatio == null
					? null
					: clampFloat(config.aspectRatio, 1, BOUNDS.aspectRatio),
			aspectTolerance: clampFloat(
				config.aspectTolerance,
				0.15,
				BOUNDS.aspectTolerance,
			),
			expectedSizeFraction:
				config.expectedSizeFraction === "" || config.expectedSizeFraction == null
					? null
					: clampFloat(
							config.expectedSizeFraction,
							0.5,
							BOUNDS.expectedSizeFraction,
						),
			sizeTolerance: clampFloat(config.sizeTolerance, 0.2, BOUNDS.sizeTolerance),
			cropMargin: clampFloat(config.cropMargin, 0.02, BOUNDS.cropMargin),
			minRotateAngleDeg: clampFloat(
				config.minRotateAngleDeg,
				0.5,
				BOUNDS.minRotateAngleDeg,
			),
			outputFormat: pickMode(config.outputFormat, "raw", OUTPUT_FORMATS),
			outputQuality: clampInt(config.outputQuality, 90, BOUNDS.outputQuality),
			pngOptimize: !!config.pngOptimize,
		};

		const overrideKeys = Object.keys(defaults);
		const configuredPreviewEnabled = !!config.previewEnabled;
		const configuredPreviewWidth = clampInt(
			config.previewWidth,
			220,
			BOUNDS.previewWidth,
		);

		this.on("input", async (msg, send, done) => {
			try {
				if (!available()) {
					throw new Error(
						"label-crop: OpenCV engine unavailable - install either " +
							"@rosepetal/node-red-contrib-image-tools (native, fastest, " +
							"prebuilt for Linux x64/arm64, Alpine x64, macOS x64/arm64) " +
							"or @techstark/opencv-js (WASM, runs anywhere)",
					);
				}
				const options = { ...defaults };
				for (const key of overrideKeys) {
					if (msg[key] !== undefined && msg[key] !== null && msg[key] !== "") {
						options[key] = msg[key];
					}
				}
				const originalImage = msg.payload;
				const res = await labelCrop(originalImage, options);
				const previewEnabled = asBoolean(
					msg.previewEnabled,
					configuredPreviewEnabled,
				);
				const previewWidth = clampInt(
					msg.previewWidth,
					configuredPreviewWidth,
					BOUNDS.previewWidth,
				);
				if (previewEnabled) {
					const previewStarted = performance.now();
					try {
						await publishPreview(this, originalImage, res.image, previewWidth);
						res.metadata.timings.previewMs = performance.now() - previewStarted;
					} catch (previewError) {
						this.warn(`label-crop preview: ${previewError.message}`);
					}
				} else if (RED.comms && typeof RED.comms.publish === "function") {
					RED.comms.publish("label-crop-preview", { id: this.id, clear: true });
				}
				msg.payload = res.image;
				msg.labelCrop = res.metadata;
				this.status({
					fill: res.detected ? "green" : "yellow",
					shape: res.detected ? "dot" : "ring",
					text: res.detected
						? `deskewed ${res.metadata.width}×${res.metadata.height}`
						: `not detected (${res.metadata.reason})`,
				});
				// In calipers mode a miss names the edge that failed, and that
				// is nearly always a region that needs re-aiming rather than a
				// bad part - so say so once per distinct reason, not per frame.
				if (!res.detected && options.boundaryMode === "calipers") {
					if (this.lastCaliperWarning !== res.metadata.reason) {
						this.lastCaliperWarning = res.metadata.reason;
						this.warn(`label-crop: ${res.metadata.reason}`);
					}
				} else if (res.detected) {
					this.lastCaliperWarning = null;
				}
				send(msg);
				done();
			} catch (err) {
				this.status({ fill: "red", shape: "ring", text: "error" });
				// done(err) is Node-RED's single failure path; it routes to
				// node.error without a second report here.
				done(err);
			}
		});
	}

	RED.nodes.registerType("label-crop", LabelCropNode);
};
