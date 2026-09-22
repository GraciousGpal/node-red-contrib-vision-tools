/**
 * line-finder: find straight edges inside search regions the operator
 * drew - one region for one edge, or several for the sides of a
 * rectangle.
 *
 * Input (msg.payload): an encoded image Buffer or a raw
 * { data, width, height, channels } object - the same image shapes
 * golden-compare and label-crop accept.
 *
 * Output: msg.payload passes through untouched (this is a measuring
 * tool, not a filter) and msg.lineFinder carries the result. With one
 * region it is the findLine result itself:
 *
 *   { found, reason, line: { x, y, dx, dy, p0, p1 }, angleDeg, score,
 *     calipers: { total, found, used }, residualPx, points, caliperLines,
 *     diagnostics, region, imageWidth, imageHeight, timings: { totalMs },
 *     lines: [ { name, ...the same } ] }
 *
 * With several regions the per-region results live in `lines` (in the
 * configured order, each `{ name, ...findLine result, region }`), the
 * top-level `found` is true only when every region found its line and
 * `reason` names the first that did not ("top:no-edge"). Regions named
 * left/right/top/bottom are intersected into `rect` - { ok, corners,
 * center, width, height, angleDeg, score, residualPx } in the shape
 * label-crop reports - and every pair of found lines that is not
 * parallel within the angle tolerance is intersected into
 * `intersections: [{ a, b, x, y }]`, which is what an L-shaped fixture
 * needs.
 *
 * A miss is a normal outcome, not an error: `found` is false and
 * `reason` says which gate stopped it. Genuine setup problems - an
 * unusable payload, a region off the image - are errors.
 *
 * Regions come from `config.regions`, an array of { name, x, y, width,
 * height, angleDeg, scanDirection, polarity, edgeSelect }. A flow saved
 * before that existed stores one region in regionX/regionY/regionWidth/
 * regionHeight/regionAngleDeg plus scanDirection/polarity/edgeSelect,
 * and still does: when `regions` is empty those fields build a single
 * region named "line" and the output is exactly what it was. The
 * numeric tuning (calipers, contrast, smoothing, ...) is node-wide;
 * only the geometry and the three modes are per region.
 *
 * The editor's "Run on this image" button posts a crop of the loaded
 * sample to the admin endpoint POST /line-finder/run (see runOnCrop),
 * once per region, and gets the same result back in frame coordinates,
 * so a region can be tuned against a real photo without deploying.
 *
 * The last frame each node saw is kept in memory - one per node, by node
 * id - so the editor can show the operator the real picture instead of
 * asking for a file every time: GET /line-finder/last-frame/:id serves
 * it, and a Run request that names `nodeId` and carries no image
 * searches that frame in full. It is a reference to the payload as it
 * arrived, not a copy, so the cost is one frame per line-finder node;
 * it survives a redeploy but not a restart, and a deleted node's entry
 * goes with it.
 *
 * Unlike label-crop this needs no OpenCV engine. lib/lineFinder.js is
 * pure JS over a grayscale raster and only touches the region's own
 * pixels, so the cost scales with the boxes the operator drew rather
 * than with the frame. Decoding an *encoded* payload does need sharp,
 * which is already a hard dependency of this package.
 */

const { performance } = require("node:perf_hooks");

module.exports = (RED) => {
	const {
		findLine,
		regionCorners,
		normalizeRegion,
		rectFromLines,
		intersectLines,
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
	const COORD = [-1e6, 1e6];
	const SIDE = [1, 1e6];
	const ANGLE = [-180, 180];
	// the four names that make a rectangle, in label-crop's order
	const RECT_SIDES = ["left", "right", "top", "bottom"];
	const DEG = Math.PI / 180;

	/**
	 * The last frame through each node, by node id, for the editor:
	 * { payload, width, height, receivedAt, png }. `payload` is the
	 * message's own payload - the encoded Buffer or the raw descriptor -
	 * held by reference; `png` memoises a raw frame's encoding from the
	 * first time the editor asks for it until the next frame replaces the
	 * entry. Lives in this closure, so it outlasts a redeploy of the flow
	 * (Node-RED calls this factory once per process) and nothing else.
	 */
	const lastFrames = new Map();

	/** The Content-Type an encoded payload should be served under, from its magic bytes. */
	function sniffImageType(buf) {
		if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
		if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
			return "image/png";
		}
		if (
			buf.length >= 12 &&
			buf.toString("latin1", 0, 4) === "RIFF" &&
			buf.toString("latin1", 8, 12) === "WEBP"
		) {
			return "image/webp";
		}
		return "application/octet-stream";
	}

	/**
	 * A cached entry as bytes the browser can decode: an encoded payload
	 * as it came, a raw one as PNG - encoded on the first request and kept
	 * on the entry, at zlib's fastest level because this is a one-off for
	 * a dialog, not a stream.
	 */
	function frameBytes(entry) {
		const p = entry.payload;
		if (Buffer.isBuffer(p)) {
			return Promise.resolve({ bytes: p, contentType: sniffImageType(p) });
		}
		if (!entry.png) {
			const sharp = require("sharp");
			const data = Buffer.isBuffer(p.data)
				? p.data
				: Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength);
			entry.png = sharp(data, {
				raw: { width: p.width, height: p.height, channels: p.channels || 1 },
			})
				.png({ compressionLevel: 1 })
				.toBuffer()
				.catch((err) => {
					entry.png = null;
					throw err;
				});
		}
		return entry.png.then((bytes) => ({ bytes, contentType: "image/png" }));
	}

	function noFrameYet() {
		const err = new Error("no frame yet");
		err.status = 404;
		return err;
	}

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
	 * The one region a flow saved before `regions` existed keeps in flat
	 * fields - and the fallback for a node whose list is empty.
	 */
	function legacyRegion(config) {
		return {
			name: "line",
			x: clampFloat(config.regionX, 0, COORD),
			y: clampFloat(config.regionY, 0, COORD),
			width: clampFloat(config.regionWidth, 100, SIDE),
			height: clampFloat(config.regionHeight, 100, SIDE),
			angleDeg: clampFloat(config.regionAngleDeg, 0, ANGLE),
			scanDirection: pickMode(config.scanDirection, "right", SCAN_DIRECTIONS),
			polarity: pickMode(config.polarity, "either", POLARITIES),
			edgeSelect: pickMode(config.edgeSelect, "best", EDGE_SELECTS),
		};
	}

	/**
	 * A configured or per-message region list into the shape the search
	 * runs: geometry clamped, the three per-region modes validated against
	 * `fallback` (the legacy fields, so a list entry that omits its scan
	 * direction inherits the node's), and a name for each. Anything that is
	 * not an object is dropped, and a non-array - including the JSON string
	 * an import might hold - yields [] so the caller falls back to the
	 * legacy fields.
	 */
	function normalizeRegions(list, fallback) {
		let items = list;
		if (typeof items === "string") {
			try {
				items = JSON.parse(items);
			} catch {
				return [];
			}
		}
		if (!Array.isArray(items)) return [];
		const out = [];
		items.forEach((r, i) => {
			if (!r || typeof r !== "object") return;
			out.push({
				name: String(r.name == null ? "" : r.name).trim() || `region${i + 1}`,
				x: clampFloat(r.x, fallback.x, COORD),
				y: clampFloat(r.y, fallback.y, COORD),
				width: clampFloat(r.width, fallback.width, SIDE),
				height: clampFloat(r.height, fallback.height, SIDE),
				angleDeg: clampFloat(r.angleDeg, fallback.angleDeg, ANGLE),
				scanDirection: pickMode(r.scanDirection, fallback.scanDirection, SCAN_DIRECTIONS),
				polarity: pickMode(r.polarity, fallback.polarity, POLARITIES),
				edgeSelect: pickMode(r.edgeSelect, fallback.edgeSelect, EDGE_SELECTS),
			});
		});
		return out;
	}

	function geometryOf(region) {
		return {
			x: region.x,
			y: region.y,
			width: region.width,
			height: region.height,
			angleDeg: region.angleDeg,
		};
	}

	/**
	 * Regions named left/right/top/bottom into the rectangle they bound,
	 * in the field names label-crop reports (corners tl, tr, br, bl;
	 * center; width; height; angleDeg). Undefined when the four are not
	 * all configured; `ok: false` with the finder's reason when they are
	 * but one missed or two came out parallel.
	 */
	function rectOf(lines) {
		const byName = {};
		for (const l of lines) byName[l.name] = l;
		if (!RECT_SIDES.every((s) => byName[s])) return undefined;
		const r = rectFromLines({
			left: byName.left,
			right: byName.right,
			top: byName.top,
			bottom: byName.bottom,
		});
		if (!r.ok) return { ok: false, reason: r.reason, missing: r.missing };
		return {
			ok: true,
			reason: "ok",
			corners: r.corners,
			center: { x: r.cx, y: r.cy },
			width: r.width,
			height: r.height,
			angleDeg: r.angleDeg,
			score: r.score,
			residualPx: r.residualPx,
		};
	}

	/**
	 * Every pair of found lines that actually crosses: two lines within
	 * the angle tolerance of parallel are skipped, since their crossing
	 * point is wherever the noise puts it. With the tolerance off, only
	 * the half-degree floor intersectLines itself applies is used.
	 */
	function intersectionsOf(lines, angleToleranceDeg) {
		const found = lines.filter((l) => l.found);
		const minAngle = Math.max(0.5, angleToleranceDeg == null ? 0 : angleToleranceDeg);
		const out = [];
		for (let i = 0; i < found.length; i++) {
			for (let j = i + 1; j < found.length; j++) {
				const a = found[i].line;
				const b = found[j].line;
				const between = Math.acos(Math.min(1, Math.abs(a.dx * b.dx + a.dy * b.dy))) / DEG;
				if (between < minAngle) continue;
				const p = intersectLines(a, b);
				if (!p) continue;
				out.push({ a: found[i].name, b: found[j].name, x: p.x, y: p.y });
			}
		}
		return out;
	}

	/**
	 * The search itself, region by region, then the top-level shape.
	 *
	 * One region reports the findLine result at the top level exactly as it
	 * always has, with `lines[0]` a copy of it; several report only the
	 * verdict at the top and the results in `lines`, plus the rectangle and
	 * the crossings when there are any to report.
	 */
	function searchRegions(gray, width, height, regions, cfg, minScore) {
		const lines = regions.map((region) => {
			const result = findLine(gray, width, height, geometryOf(region), {
				...cfg,
				scanDirection: region.scanDirection,
				polarity: region.polarity,
				edgeSelect: region.edgeSelect,
			});
			// A found line that nothing agrees on is worse than a clean miss,
			// so the score gate is applied here rather than left to the flow.
			if (result.found && result.score < minScore) {
				result.found = false;
				result.reason = "below-min-score";
			}
			return { name: region.name, ...result, region: { ...region } };
		});

		if (lines.length === 1) {
			const { name, region, ...result } = lines[0];
			return { ...result, region: geometryOf(region), lines };
		}
		const missed = lines.find((l) => !l.found);
		const out = {
			found: !missed,
			reason: missed ? `${missed.name}:${missed.reason}` : "ok",
			lines,
		};
		const rect = rectOf(lines);
		if (rect) out.rect = rect;
		out.intersections = intersectionsOf(lines, cfg.angleToleranceDeg);
		return out;
	}

	const round1 = (v) => Math.round(v * 10) / 10;

	/**
	 * A small JPEG of the frame, plus the geometry needed to draw every
	 * search region, its caliper hits and its fitted line over it.
	 *
	 * Tuning a caliper region is the one job where a number is not enough:
	 * "score 0.4" does not say whether the box is aimed at the wrong edge,
	 * clipped by the frame, or straddling two steps - and the picture says
	 * all three at a glance. So the overlay carries the *dropped* caliper
	 * points too, not only the surviving fit.
	 *
	 * Coordinates are published in image pixels and scaled in the editor,
	 * so the payload does not have to be re-sent when the preview is
	 * resized, and a rotated region draws as the parallelogram it is. The
	 * per-region drawings are in `lines`; the top-level fields repeat the
	 * first region's for a single-region node, as they always did.
	 */
	async function buildPreview(payload, result, width) {
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
		const lines = result.lines.map((l) => ({
			name: l.name,
			region: regionCorners(geometryOf(l.region), l.region.scanDirection),
			scanDirection: l.region.scanDirection,
			found: l.found,
			reason: l.reason,
			score: l.score,
			angleDeg: l.angleDeg,
			calipers: l.calipers,
			residualPx: l.residualPx,
			line: l.found ? { p0: l.line.p0, p1: l.line.p1 } : null,
			// rounded: this crosses the websocket on every frame, and a
			// tenth of a pixel is well past what a thumbnail can show
			points: l.points.map((p) => ({ x: round1(p.x), y: round1(p.y), used: p.used })),
		}));
		const single = lines.length === 1 ? lines[0] : null;
		return {
			image: jpeg.toString("base64"),
			mimeType: "jpeg",
			previewWidth: width,
			imageWidth: result.imageWidth,
			imageHeight: result.imageHeight,
			region: single ? single.region : null,
			scanDirection: single ? single.scanDirection : null,
			found: result.found,
			reason: result.reason,
			score: single ? single.score : null,
			angleDeg: single ? single.angleDeg : null,
			calipers: single ? single.calipers : null,
			residualPx: single ? single.residualPx : null,
			line: single ? single.line : null,
			points: single ? single.points : [],
			lines,
			rect:
				result.rect && result.rect.ok
					? {
							corners: result.rect.corners.map((p) => ({ x: round1(p.x), y: round1(p.y) })),
							width: result.rect.width,
							height: result.rect.height,
							angleDeg: result.rect.angleDeg,
						}
					: null,
		};
	}

	/**
	 * The search settings out of a node config, clamped into range. The
	 * editor's Run request carries the same fields under the same names,
	 * so it goes through here too and cannot drift from what deploys.
	 */
	function settingsFrom(config) {
		return {
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
	}

	/**
	 * The editor's "Run on this image": the real search over a crop of the
	 * sample the operator loaded, with the dialog's current settings,
	 * before anything is deployed. The editor calls it once per region.
	 *
	 * Body: { image, offset: { x, y }, region: { x, y, width, height,
	 * angleDeg }, cfg: { ...the node's settings by name } }. `image` is a
	 * crop, PNG or JPEG, base64 (a data: URL prefix is tolerated), and
	 * `offset` is where its top-left corner sits in the full frame. A crop
	 * rather than the frame because httpAdmin's JSON body is capped at
	 * settings.apiMaxLength - 5MB by default - and a 20-megapixel PNG will
	 * not fit. The region arrives in frame coordinates, is searched in crop
	 * coordinates, and every coordinate in the answer is moved back, so the
	 * editor never has to know the search ran on a crop.
	 *
	 * With `nodeId` and no `image` the search runs instead on the last
	 * frame that node saw (see lastFrames) - the whole frame, offset 0,0 -
	 * so the editor tunes against exactly the pixels production will see,
	 * with no browser decode in between. A 404 when that node has not had
	 * a frame yet.
	 *
	 * Returns { source, result }: `source` is "cached" or "upload", and
	 * `result` the findLine result with the score gate applied the way
	 * the input handler applies it, plus `region`, `crop` and the
	 * clamped `settings` that actually ran, so the editor's explanation
	 * of a miss quotes the threshold that was used rather than the one
	 * typed.
	 */
	async function runOnCrop(body) {
		if (!body || typeof body !== "object") {
			throw new Error("line-finder/run: expected a JSON body");
		}
		const cached = body.image === undefined && body.nodeId != null;
		if (!cached && (typeof body.image !== "string" || body.image.length === 0)) {
			throw new Error(
				"line-finder/run: image must be the crop's PNG or JPEG bytes, base64-encoded",
			);
		}
		// normalizeRegion throws the finder's own messages for a bad region
		const reg = normalizeRegion(body.region);
		const region = {
			x: reg.x,
			y: reg.y,
			width: reg.width,
			height: reg.height,
			angleDeg: reg.angleDeg,
		};
		const offset = !cached && body.offset && typeof body.offset === "object" ? body.offset : {};
		const ox = clampFloat(offset.x, 0, COORD);
		const oy = clampFloat(offset.y, 0, COORD);
		const cfgIn = body.cfg && typeof body.cfg === "object" ? body.cfg : {};
		const cfg = settingsFrom(cfgIn);
		const minScore = clampFloat(cfgIn.minScore, 0, BOUNDS.minScore);

		let source;
		let decoded;
		if (cached) {
			const entry = lastFrames.get(String(body.nodeId));
			if (!entry) throw noFrameYet();
			decoded = await toGray(entry.payload);
			source = "cached";
		} else {
			const bytes = Buffer.from(body.image.replace(/^data:[^,]*,/, ""), "base64");
			decoded = await toGray(bytes);
			source = "upload";
		}
		const { gray, width, height } = decoded;
		const result = findLine(
			gray,
			width,
			height,
			{ ...region, x: region.x - ox, y: region.y - oy },
			cfg,
		);
		if (result.found && result.score < minScore) {
			result.found = false;
			result.reason = "below-min-score";
		}

		// back into frame coordinates
		const shift = (p) => {
			p.x += ox;
			p.y += oy;
		};
		if (result.line) {
			shift(result.line);
			shift(result.line.p0);
			shift(result.line.p1);
		}
		for (const p of result.points) shift(p);
		for (const c of result.caliperLines) {
			shift(c.p0);
			shift(c.p1);
			if (c.edge) shift(c.edge);
		}
		result.region = region;
		result.crop = { x: ox, y: oy, width, height };
		result.settings = { ...cfg, minScore };
		return { source, result };
	}

	function LineFinderNode(config) {
		RED.nodes.createNode(this, config);

		const legacy = legacyRegion(config);
		const configured = normalizeRegions(config.regions, legacy);
		const regions = configured.length ? configured : [legacy];

		// the three modes belong to each region now; what settingsFrom reads
		// out of the legacy fields already went into `legacy`
		const { scanDirection, polarity, edgeSelect, ...defaults } = settingsFrom(config);
		const overrideKeys = Object.keys(defaults);
		const MODE_OVERRIDES = {
			scanDirection: SCAN_DIRECTIONS,
			polarity: POLARITIES,
			edgeSelect: EDGE_SELECTS,
		};

		const minScore = clampFloat(config.minScore, 0, BOUNDS.minScore);

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
				// msg.regions replaces the whole list; msg.region re-aims the node
				// to a single region on top of the first configured one, as it
				// always has - so one node can be driven from a list (four
				// edges, say) without four copies of it.
				let useRegions = regions;
				if (msg.regions !== undefined) {
					const list = normalizeRegions(msg.regions, regions[0]);
					if (list.length) useRegions = list;
				} else if (msg.region && typeof msg.region === "object") {
					useRegions = normalizeRegions([{ ...regions[0], ...msg.region }], regions[0]);
				}
				// a per-message mode applies to every region, as it did to the one
				for (const key of Object.keys(MODE_OVERRIDES)) {
					if (msg[key] === undefined) continue;
					useRegions = useRegions.map((r) => ({
						...r,
						[key]: pickMode(msg[key], r[key], MODE_OVERRIDES[key]),
					}));
				}

				const { gray, width, height } = await toGray(msg.payload);
				// for the editor: the payload by reference, nothing copied or encoded
				lastFrames.set(this.id, { payload: msg.payload, width, height, receivedAt: Date.now(), png: null });
				const result = searchRegions(gray, width, height, useRegions, cfg, minScore);
				result.imageWidth = width;
				result.imageHeight = height;
				result.timings = { totalMs: performance.now() - started };

				const previewEnabled =
					msg.previewEnabled == null
						? configuredPreviewEnabled
						: !!msg.previewEnabled;
				if (previewEnabled && RED.comms && typeof RED.comms.publish === "function") {
					try {
						const data = await buildPreview(
							msg.payload,
							result,
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
				let text;
				if (!result.found) {
					text = `not found (${result.reason})`;
				} else if (result.lines.length === 1) {
					text = `${result.angleDeg.toFixed(2)}° · ${result.calipers.used}/${result.calipers.total} · score ${result.score.toFixed(2)}`;
				} else {
					text = `${result.lines.length}/${result.lines.length} lines`;
					if (result.rect && result.rect.ok) {
						text += ` · rect ${Math.round(result.rect.width)}×${Math.round(result.rect.height)}`;
					}
				}
				this.status({
					fill: result.found ? "green" : "yellow",
					shape: result.found ? "dot" : "ring",
					text,
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

		this.on("close", (removed, done) => {
			// a deleted node takes its frame with it; a redeploy keeps it, so
			// the editor still has a picture to draw on after Deploy
			if (removed) lastFrames.delete(this.id);
			done();
		});
	}

	RED.nodes.registerType("line-finder", LineFinderNode);

	RED.httpAdmin.get(
		"/line-finder/last-frame/:id",
		RED.auth.needsPermission("line-finder.read"),
		async (req, res) => {
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
		},
	);

	RED.httpAdmin.post(
		"/line-finder/run",
		RED.auth.needsPermission("line-finder.write"),
		async (req, res) => {
			try {
				res.json({ ok: true, ...(await runOnCrop(req.body)) });
			} catch (err) {
				// a bad body, an undecodable image or an invalid region: all the
				// caller's to fix, so 400 with the message rather than 500; a
				// node with no frame cached yet is a 404
				res.status(err.status || 400).json({ ok: false, error: err.message });
			}
		},
	);
};
