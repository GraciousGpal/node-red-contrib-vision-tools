/**
 * line-finder: find a straight edge inside a search region the operator
 * drew.
 *
 * Input (msg.payload): an encoded image Buffer or a raw
 * { data, width, height, channels } object - the same image shapes
 * golden-compare and label-crop accept.
 *
 * Output: msg.payload passes through untouched (this is a measuring
 * tool, not a filter) and msg.lineFinder carries the result:
 *
 *   { found, reason, line: { x, y, dx, dy, p0, p1 }, angleDeg, score,
 *     calipers: { total, found, used }, residualPx, points, region,
 *     timings: { totalMs } }
 *
 * A miss is a normal outcome, not an error: `found` is false and
 * `reason` says which gate stopped it. Genuine setup problems - an
 * unusable payload, a region off the image - are errors.
 *
 * Unlike label-crop this needs no OpenCV engine. lib/lineFinder.js is
 * pure JS over a grayscale raster and only touches the region's own
 * pixels, so the cost scales with the box the operator drew rather than
 * with the frame. Decoding an *encoded* payload does need sharp, which
 * is already a hard dependency of this package.
 */

const { performance } = require("node:perf_hooks");

module.exports = (RED) => {
	const {
		findLine,
		regionCorners,
		SCAN_DIRECTIONS,
		POLARITIES,
		EDGE_SELECTS,
	} = require("./lib/lineFinder.js");
	const { clampInt, clampFloat, pickMode } = require("./lib/nodeInput.js");

	const BOUNDS = {
		calipers: [1, 512],
		contrastThreshold: [0, 255],
		filterHalfWidth: [0, 64],
		ignoreCount: [0, 64],
		outlierTolerancePx: [0.1, 1000],
		minCaliperFraction: [0.05, 1],
		angleToleranceDeg: [0, 90],
		minScore: [0, 1],
		previewWidth: [80, 600],
	};

	/**
	 * Grayscale raster from whatever the flow handed us.
	 *
	 * A raw descriptor is used in place: the caller already paid for the
	 * pixels and the finder only reads them. Only an encoded buffer goes
	 * through sharp, and then only once.
	 */
	async function toGray(payload) {
		if (payload && payload.data && payload.width && payload.height) {
			const channels = payload.channels || 1;
			const data =
				payload.data instanceof Uint8Array
					? payload.data
					: new Uint8Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength);
			if (channels === 1) {
				return { gray: data, width: payload.width, height: payload.height };
			}
			// Rec. 601 luma, matching what sharp's .grayscale() produces, so a
			// region tuned on an encoded sample behaves the same on raw input.
			const n = payload.width * payload.height;
			const gray = new Uint8Array(n);
			for (let i = 0; i < n; i++) {
				const p = i * channels;
				gray[i] =
					(data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29 + 128) >> 8;
			}
			return { gray, width: payload.width, height: payload.height };
		}
		if (Buffer.isBuffer(payload)) {
			const sharp = require("sharp");
			const { data, info } = await sharp(payload)
				.grayscale()
				.raw()
				.toBuffer({ resolveWithObject: true });
			return {
				gray: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
				width: info.width,
				height: info.height,
			};
		}
		throw new Error(
			"line-finder: msg.payload must be an encoded image Buffer or a raw " +
				"{ data, width, height, channels } image object",
		);
	}

	/**
	 * A small JPEG of the frame, plus the geometry needed to draw the
	 * search region, the caliper hits and the fitted line over it.
	 *
	 * Tuning a caliper region is the one job where a number is not enough:
	 * "score 0.4" does not say whether the box is aimed at the wrong edge,
	 * clipped by the frame, or straddling two steps - and the picture says
	 * all three at a glance. So the overlay carries the *dropped* caliper
	 * points too, not only the surviving fit.
	 *
	 * Coordinates are published in image pixels and scaled in the editor,
	 * so the payload does not have to be re-sent when the preview is
	 * resized, and a rotated region draws as the parallelogram it is.
	 */
	async function buildPreview(payload, result, region, cfg, width) {
		const sharp = require("sharp");
		const pipeline =
			payload && payload.data && payload.width
				? sharp(
						Buffer.isBuffer(payload.data) ? payload.data : Buffer.from(payload.data),
						{
							raw: {
								width: payload.width,
								height: payload.height,
								channels: payload.channels || 1,
							},
						},
					)
				: sharp(payload);
		const jpeg = await pipeline
			.resize({ width, withoutEnlargement: true })
			.jpeg({ quality: 70 })
			.toBuffer();
		return {
			image: jpeg.toString("base64"),
			mimeType: "jpeg",
			previewWidth: width,
			imageWidth: result.imageWidth,
			imageHeight: result.imageHeight,
			region: regionCorners(region, cfg.scanDirection),
			scanDirection: cfg.scanDirection,
			found: result.found,
			reason: result.reason,
			score: result.score,
			angleDeg: result.angleDeg,
			calipers: result.calipers,
			residualPx: result.residualPx,
			line: result.found ? { p0: result.line.p0, p1: result.line.p1 } : null,
			// rounded: this crosses the websocket on every frame, and a
			// tenth of a pixel is well past what a thumbnail can show
			points: result.points.map((p) => ({
				x: Math.round(p.x * 10) / 10,
				y: Math.round(p.y * 10) / 10,
				used: p.used,
			})),
		};
	}

	function LineFinderNode(config) {
		RED.nodes.createNode(this, config);

		const region = {
			x: clampFloat(config.regionX, 0, [-1e6, 1e6]),
			y: clampFloat(config.regionY, 0, [-1e6, 1e6]),
			width: clampFloat(config.regionWidth, 100, [1, 1e6]),
			height: clampFloat(config.regionHeight, 100, [1, 1e6]),
			angleDeg: clampFloat(config.regionAngleDeg, 0, [-180, 180]),
		};

		const defaults = {
			scanDirection: pickMode(config.scanDirection, "right", SCAN_DIRECTIONS),
			polarity: pickMode(config.polarity, "either", POLARITIES),
			edgeSelect: pickMode(config.edgeSelect, "best", EDGE_SELECTS),
			calipers: clampInt(config.calipers, 16, BOUNDS.calipers),
			contrastThreshold: clampFloat(config.contrastThreshold, 2, BOUNDS.contrastThreshold),
			filterHalfWidth: clampInt(config.filterHalfWidth, 2, BOUNDS.filterHalfWidth),
			ignoreCount: clampInt(config.ignoreCount, 0, BOUNDS.ignoreCount),
			outlierTolerancePx: clampFloat(config.outlierTolerancePx, 2.5, BOUNDS.outlierTolerancePx),
			minCaliperFraction: clampFloat(config.minCaliperFraction, 0.5, BOUNDS.minCaliperFraction),
			// blank means "do not check the angle at all", which is the
			// documented off value in lib/lineFinder.js
			angleToleranceDeg:
				config.angleToleranceDeg === "" || config.angleToleranceDeg == null
					? null
					: clampFloat(config.angleToleranceDeg, 10, BOUNDS.angleToleranceDeg),
		};

		// A found line that nothing agrees on is worse than a clean miss, so
		// the score gate is applied here rather than left to the flow.
		const minScore = clampFloat(config.minScore, 0, BOUNDS.minScore);
		const overrideKeys = Object.keys(defaults);

		const configuredPreviewEnabled = !!config.previewEnabled;
		const configuredPreviewWidth = clampInt(
			config.previewWidth,
			260,
			BOUNDS.previewWidth,
		);

		this.on("input", async (msg, send, done) => {
			const started = performance.now();
			try {
				const cfg = { ...defaults };
				for (const key of overrideKeys) {
					if (msg[key] !== undefined) cfg[key] = msg[key];
				}
				// msg.region wins wholesale when supplied, so one configured node
				// can be re-aimed per message (four of them driven from a list,
				// for instance) without four copies of the node.
				const useRegion =
					msg.region && typeof msg.region === "object"
						? { ...region, ...msg.region }
						: region;

				const { gray, width, height } = await toGray(msg.payload);
				const result = findLine(gray, width, height, useRegion, cfg);
				result.region = useRegion;
				result.imageWidth = width;
				result.imageHeight = height;
				result.timings = { totalMs: performance.now() - started };

				if (result.found && result.score < minScore) {
					result.found = false;
					result.reason = "below-min-score";
				}

				const previewEnabled =
					msg.previewEnabled == null
						? configuredPreviewEnabled
						: !!msg.previewEnabled;
				if (previewEnabled && RED.comms && typeof RED.comms.publish === "function") {
					try {
						const data = await buildPreview(
							msg.payload,
							result,
							useRegion,
							cfg,
							clampInt(msg.previewWidth, configuredPreviewWidth, BOUNDS.previewWidth),
						);
						RED.comms.publish("line-finder-preview", { id: this.id, ...data });
					} catch (previewError) {
						// a preview is a diagnostic, never a reason to fail a frame
						this.warn(`line-finder preview: ${previewError.message}`);
					}
				} else if (RED.comms && typeof RED.comms.publish === "function") {
					RED.comms.publish("line-finder-preview", { id: this.id, clear: true });
				}

				msg.lineFinder = result;
				this.status({
					fill: result.found ? "green" : "yellow",
					shape: result.found ? "dot" : "ring",
					text: result.found
						? `${result.angleDeg.toFixed(2)}° · ${result.calipers.used}/${result.calipers.total} · score ${result.score.toFixed(2)}`
						: `not found (${result.reason})`,
				});
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

	RED.nodes.registerType("line-finder", LineFinderNode);
};
