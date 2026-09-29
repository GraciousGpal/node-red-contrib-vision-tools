/**
 * golden-compare Node-RED node.
 *
 * Golden-template AOI: a position check (measured translation vs. a tolerance band, not
 * silently corrected away) plus two independent blemish checks (print =
 * missing ink, background = unwanted ink), each with their own
 * tolerance. See README.md for the algorithm; the actual pixel-crunching
 * lives in lib/compare.js so it can be exercised outside Node-RED.
 *
 * Input (msg.payload): Buffer / Uint8Array / ArrayBuffer with image bytes,
 * a file path string, or an object { data | buffer | path }; raw pixels
 * carry their geometry on the object, msg.rawInfo, or msg.images[].
 * Per-message overrides: msg.golden (path/Buffer - swaps and re-caches
 * the golden reference), msg.goldenKey / msg.goldenRawInfo for it, and
 * every setting in SETTINGS below, by the same name.
 */

const crypto = require("crypto");
const inspector = require("./lib/inspector.js");
const { toShared } = require("./lib/shared.js");
const { readScaleFile } = require("./lib/scaleFile.js");
const { formatMs: fmtMs } = require("./lib/formatMs.js");
const {
	readTransformFile,
	writeTransformFile,
} = require("./lib/transformFile.js");
const nuisance = require("./lib/nuisanceMap.js");
const {
	clampInt,
	clampFloat,
	pickMode,
	isBytes,
	assertUnderCap,
	openRegularFile,
	readRegularFile,
} = require("./lib/nodeInput.js");

module.exports = (RED) => {
	/**
	 * Every setting the editor saves and a message may override by the same
	 * name: the runtime fallback and the clamp, declared once. The
	 * constructor reads each off `config`, and the input handler reads it
	 * again off `msg` with the node's value as the fallback; `fixed` marks
	 * the few a message may not change. test/editorDefaults.test.js reads
	 * this block against the editor's `defaults`, so it keeps that shape.
	 */
	const SETTINGS = {
		workingSize: { value: 1024, int: [64, 4096], fixed: true },
		threshold: { value: 128, int: [0, 255] },
		// otsu by default, not a fixed level: the golden is normally PDF
		// artwork - synthetic pure black on pure white - and the frame is a
		// photograph. No single grey level is correct for both.
		thresholdMode: { value: "otsu", modes: ["fixed", "otsu", "sauvola"] },
		sauvolaRadius: { value: 24, int: [2, 200] },
		sauvolaK: { value: 0.2, float: [0.01, 1] },
		inkMargin: { value: 8, int: [0, 128] },
		// Wide by default: on a frame already at the golden's scale the extra
		// rungs cost almost nothing, while a narrow default would silently
		// fail every artwork-as-golden setup - the case the search exists for.
		scaleSearchMin: { value: 0.6, float: [0.1, 10] },
		scaleSearchMax: { value: 2.5, float: [0.1, 10] },
		scaleSearchSteps: { value: 19, int: [1, 61] },
		// Presses stretch print along the media-feed axis relative to the
		// artwork, 5-6% on this project's own samples. Left unsearched it
		// puts every feature several pixels out toward the ends of the long
		// axis and fails a good part on both blemish checks.
		alignCandidates: { value: 5, int: [1, 16] },
		// 0 = auto, one per core, capped at 16, leaving one for the event
		// loop. 1 disables the pool and keeps every stage on this thread.
		workers: { value: 0, int: [0, 64] },
		// 0 disables the "this is a different label" check entirely
		mismatchScore: { value: 0.15, float: [0, 1] },
		localAlign: { value: true },
		localAlignTile: { value: 96, int: [16, 512] },
		localAlignMax: { value: 3, int: [1, 16] },
		maxAspect: { value: 0.06, float: [0, 0.5] },
		aspectSteps: { value: 7, int: [1, 21] },
		maxAngleDeg: { value: 2, float: [0, 30] },
		angleSteps: { value: 5, int: [1, 21] },
		positionToleranceAngleDeg: { value: 1, float: [0, 30] },
		// tight because localAlign is on by default: the dilation no longer
		// has to absorb registration error, only genuine edge variation
		printTolerance: { value: 2, int: [0, 50] },
		backgroundTolerance: { value: 1, int: [0, 50] },
		alignSearch: { value: 16, int: [0, 200] },
		positionToleranceXMm: { value: 2, float: [0, 1000] },
		positionToleranceYMm: { value: 2, float: [0, 1000] },
		positionToleranceXPx: { value: 16, int: [0, 1000] },
		positionToleranceYPx: { value: 16, int: [0, 1000] },
		blockSize: { value: 16, int: [4, 256] },
		blockThreshold: { value: 0.15, float: [0, 1] },
		failThreshold: { value: 0.3, float: [0, 1] },
		failRatio: { value: 0.002, float: [0, 1] },
		outputPrintHeatmap: { value: true },
		outputBackgroundHeatmap: { value: true },
		// JPEG unless asked for PNG: a heat map is a picture for a person,
		// and PNG was ~150ms per image at working size (see encodeImage in
		// lib/compare.js). Also applies to msg.stages.
		heatmapFormat: { value: "jpg", modes: ["jpg", "png", "raw"] },
		heatmapQuality: { value: 85, int: [1, 100] },
		debugStages: { value: false },
		trainTransform: { value: false },
		trainNuisance: { value: false },
		// 0 disables the gate outright. The measured window on the reference
		// run is 0.27-0.32; lib/nuisanceMap.js says why it is that narrow.
		noveltyThreshold: { value: 0.3, float: [0, 1], fixed: true },
		// PROTOTYPES, default off - see lib/nativeSeed.js. The seed replaces
		// the staged sweeps with a native ORB+ECC alignment when the optional
		// @rosepetal/node-red-contrib-image-tools engine is installed, and is
		// inert without it; the fast path lets OpenCV own the affine solve and
		// global warp, and may produce different inspection results.
		nativeAlignSeed: { value: false },
		nativeFastAlign: { value: false },
	};

	/** One setting off `config` or `msg`, clamped, with `fallback` for a
	 * missing or unusable value. */
	function readSetting(spec, raw, fallback) {
		if (spec.int) return clampInt(raw, fallback, spec.int);
		if (spec.float) return clampFloat(raw, fallback, spec.float);
		if (spec.modes) return pickMode(raw, fallback, spec.modes);
		return raw == null ? fallback : !!raw;
	}

	/** msg[key] is this frame's value or absent - never a previous frame's. */
	function setOrDelete(msg, key, value) {
		if (value) msg[key] = value;
		else delete msg[key];
	}

	/** A raw descriptor that cannot fit in the buffer it travels with
	 * would be decoded past the end by sharp (libvips's generic 'memory
	 * area too small') - refuse with the actual numbers before sharp is
	 * involved. */
	function assertRawFits(buffer, raw, label) {
		if (!raw) return;
		const need = raw.width * raw.height * raw.channels;
		if (buffer.byteLength < need) {
			throw new Error(
				`${label} raw descriptor ${raw.width}x${raw.height}x${raw.channels} needs ` +
					`${need} bytes but the buffer holds ${buffer.byteLength}`,
			);
		}
	}

	/** The byte-carrying forms, in one place - the top-level buffer and the
	 * `data`/`buffer` member of an object descriptor are validated
	 * identically. */
	function bytesOf(source) {
		const data = isBytes(source)
			? source
			: source && typeof source === "object"
				? source.data || source.buffer
				: null;
		return isBytes(data) ? data : null;
	}

	/** One copy of `data` into shared memory, as a Buffer view over it, so
	 * handing it to the inspector later is a handle rather than a second
	 * copy. Falls back to an ordinary Buffer where SharedArrayBuffer is
	 * unavailable, which is also where the inspector runs inline anyway. */
	function sharedCopy(data) {
		const src =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		if (typeof SharedArrayBuffer === "undefined") return Buffer.from(src);
		const store = new SharedArrayBuffer(src.byteLength);
		new Uint8Array(store).set(src);
		return Buffer.from(store, 0, src.byteLength);
	}

	const sha1 = (bytes) =>
		crypto
			.createHash("sha1")
			.update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
			.digest("hex");

	const objectFormError = (label) =>
		`${label} object must contain "data"/"buffer" or an existing "path"`;

	/**
	 * Where an image source keeps its bytes: `{ data }` for the in-memory
	 * forms, checked against the size cap, or `{ path, missing }` for a
	 * file, `missing` being the error to raise if it is not there - a bare
	 * path string and a path inside an object have always said different
	 * things. Anything else is refused here.
	 */
	function locateSource(source, label) {
		if (source == null || source === "") throw new Error(`${label} is empty`);
		const data = bytesOf(source);
		if (data) {
			assertUnderCap(data, label);
			return { data };
		}
		if (typeof source === "string") {
			return { path: source, missing: `${label} does not exist on disk: "${source}"` };
		}
		if (typeof source === "object" && typeof source.path === "string") {
			return { path: source.path, missing: objectFormError(label) };
		}
		if (typeof source === "object") throw new Error(objectFormError(label));
		throw new Error(`unsupported ${label} type: ${typeof source}`);
	}

	/**
	 * Load an image source to { buffer, raw }. `prefetched` is the handle
	 * fingerprintImage already holds open on a path golden, so the bytes are
	 * read through it rather than reopened - the file cannot be swapped
	 * between the stat and the read.
	 */
	async function loadImage(source, label, prefetched) {
		const at = locateSource(source, label);
		if (at.data) {
			// A Buffer is what sharp wants and is not copied. A Uint8Array or
			// ArrayBuffer may be a view onto memory the caller keeps writing
			// to, so it is copied - straight into shared memory, where the
			// frame has to end up anyway to reach the inspector.
			const buffer = Buffer.isBuffer(at.data) ? at.data : sharedCopy(at.data);
			const raw = rawGeometry(source);
			assertRawFits(buffer, raw, label);
			return { buffer, raw };
		}
		if (prefetched) return { buffer: await prefetched.handle.readFile() };
		const buffer = await readRegularFile(at.path, label);
		if (!buffer) throw new Error(at.missing);
		return { buffer };
	}

	/**
	 * A cheap, stable fingerprint of an image source, without reading or
	 * hashing its bytes wherever that can be avoided - this runs on every
	 * message, loadImage only when the golden cache misses. A path is
	 * fingerprinted by mtime and size, so overwriting the golden in place
	 * still re-prepares the cache, and the handle stays open for loadImage;
	 * a named key (msg.goldenKey) skips the hash; an unnamed buffer has to
	 * be hashed, there being nothing else in it that says whether it
	 * changed. The caller must always call close(), hit or miss.
	 */
	async function fingerprintImage(source, label, namedKey) {
		const named = namedKey ? `key:${namedKey}` : null;
		const at = locateSource(source, label);
		if (at.data) {
			return {
				key: named || `buf:${sha1(at.data)}`,
				// the only thing a named key can be cross-checked against
				// without reading the bytes it deliberately ignores
				byteLength: at.data.byteLength,
				close: async () => {},
			};
		}
		// Stat even under a named key. It costs ~0.02ms, and it keeps a
		// deleted or swapped-for-a-directory golden an error rather than a
		// silently reused cache entry; only the read was ever expensive.
		const open = await openRegularFile(at.path, label);
		if (!open) throw new Error(at.missing);
		return {
			key: named || `path:${at.path}:${open.mtimeMs}:${open.size}`,
			handle: open.handle,
			close: () => open.handle.close(),
		};
	}

	/**
	 * Geometry for pixels that arrive with no container around them.
	 * Undefined unless all three are present and sane - a partial
	 * descriptor is worse than none, because sharp would read past the end
	 * of the buffer rather than tell you the numbers are wrong.
	 */
	function rawGeometry(source) {
		if (!source || typeof source !== "object") return undefined;
		const width = Number(source.width);
		const height = Number(source.height);
		const channels = Number(source.channels);
		if (!Number.isInteger(width) || width <= 0) return undefined;
		if (!Number.isInteger(height) || height <= 0) return undefined;
		if (!Number.isInteger(channels) || channels < 1 || channels > 4)
			return undefined;
		// A descriptor past this is a mistake, not a sensor: 64M pixels at
		// 4 channels is 256MB, far beyond anything this inspection runs.
		// Capping here keeps such a descriptor from reaching sharp's raw
		// path, where the length mismatch would surface only as libvips's
		// generic 'memory area too small' error.
		if (width * height > 64 * 1024 * 1024) return undefined;
		return { width, height, channels };
	}

	/** pdf-to-image's convention: raw bytes on the payload, geometry on
	 * msg.images[] (raw pixels have no container to carry it). */
	function rawGeometryFromImages(msg) {
		if (!msg || String(msg.format).toUpperCase() !== "RAW") return undefined;
		const images = Array.isArray(msg.images) ? msg.images : null;
		if (!images || images.length === 0) return undefined;
		const match =
			(msg.page != null && images.find((i) => i && i.page === msg.page)) ||
			images[0];
		return rawGeometry(match);
	}

	/**
	 * Raw geometry for the frame under inspection.
	 *
	 * `msg.images[]` is only consulted when no golden travels on the same
	 * message. When the golden is the PDF render - the intended setup -
	 * msg.images describes *that*, not the camera frame, and silently
	 * decoding a 23MP capture at the artwork's dimensions would produce a
	 * confident, wrong answer rather than an error. Say `msg.rawInfo` when
	 * both are raw on one message.
	 */
	function targetRawGeometry(msg, source) {
		const direct = rawGeometry(source);
		if (direct) return direct;
		if (!msg) return undefined;
		const explicit = rawGeometry(msg.rawInfo);
		if (explicit) return explicit;
		if (msg.golden != null) return undefined;
		return rawGeometryFromImages(msg);
	}

	/**
	 * Raw geometry for the golden. Beyond the self-describing object form,
	 * `msg.goldenRawInfo` states it outright, and a bare buffer from
	 * pdf-to-image is read from msg.images[] - which is what wiring that
	 * node straight into this one produces.
	 *
	 * msg.images[] is only consulted for that one case. A path-string or
	 * object golden carries its own geometry, and a message still holding a
	 * pdf-to-image render's leftovers (msg.format === "RAW" + msg.images[])
	 * must not stamp that geometry onto a file golden: the file's bytes
	 * would be decoded as raw pixels at the frame's dimensions, and the
	 * garbage golden cached under cfg.raw for every later frame.
	 */
	function goldenRawGeometry(msg, source) {
		const direct = rawGeometry(source);
		if (direct) return direct;
		if (!msg) return undefined;
		const explicit = rawGeometry(msg.goldenRawInfo);
		if (explicit) return explicit;
		return isBytes(source) ? rawGeometryFromImages(msg) : undefined;
	}

	function GoldenCompareNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		for (const [key, spec] of Object.entries(SETTINGS)) {
			node[key] = readSetting(spec, config[key], spec.value);
		}
		node.goldenPath = String(config.goldenPath || "").trim();
		node.scaleFilePath = String(config.scaleFilePath || "").trim();
		node.transformFilePath = String(config.transformFilePath || "").trim();
		node.nuisancePath = String(config.nuisancePath || "").trim();
		// Accumulates across frames for the life of the node, so a training
		// run is "send the good frames through", not a single message.
		node.nuisanceAcc = null;
		// { key, promise }: the prepared golden, keyed by its fingerprint plus
		// every setting baked into it (the cacheKey list in ensureGolden is
		// the authoritative one), so a change to either triggers exactly one
		// re-prepare, shared by messages that arrive while it is in flight.
		node.goldenCache = null;

		node.on("input", async (msg, send, done) => {
			send =
				send ||
				function () {
					node.send.apply(node, arguments);
				};
			const totalStart = performance.now();
			try {
				const goldenSource = msg.golden == null ? node.goldenPath : msg.golden;
				if (!goldenSource) {
					throw new Error(
						"no golden reference configured - set the node's Golden image path or send msg.golden",
					);
				}
				const scale = await readScaleFile(node.scaleFilePath);
				if (scale && scale.error) {
					// a corrupt or implausible calibration file silently downgrades
					// the whole inspection to pixel tolerances, which is the wrong
					// thing to do without saying so - warn once per path, then run
					// uncalibrated rather than erroring every frame
					if (node.warnedAboutScale !== node.scaleFilePath) {
						node.warnedAboutScale = node.scaleFilePath;
						node.warn(scale.error);
					}
				}
				const scaleOk = scale != null && !scale.error;
				const cfg = {};
				for (const [key, spec] of Object.entries(SETTINGS)) {
					cfg[key] = spec.fixed ? node[key] : readSetting(spec, msg[key], node[key]);
				}
				cfg.mmPerPixelNative = scaleOk ? scale.mmPerPixelNative : null;
				// the calibration photo's own native size, so prepareGolden can
				// convert the mm/px scale across a golden rendered at a
				// different resolution than the calibration was taken at
				cfg.calibrationNativeWidth = scaleOk ? scale.nativeWidth : null;
				cfg.calibrationNativeHeight = scaleOk ? scale.nativeHeight : null;

				// Fingerprint first, load only on a miss: the golden's bytes are
				// the most expensive thing this node can touch, and on the hot
				// path they have not changed. msg.goldenKey names the golden
				// instead of hashing it.
				const named =
					typeof msg.goldenKey === "string" && msg.goldenKey !== ""
						? msg.goldenKey
						: null;
				// Everything the inspector needs to hold a prepared golden for
				// this key. Re-runnable, fingerprint and all: the inspector's
				// store is bounded, so an entry can be evicted between preparing
				// it and using it, and the retry below re-runs this.
				let goldenKey;
				let goldenMeta;
				let cacheKey;
				const ensureGolden = async () => {
					const fingerprint = await fingerprintImage(
						goldenSource,
						"golden reference",
						named,
					);
					// the same string that ties a trained transform to its golden, so
					// its format is persisted and must not drift - see the cache key
					// note below
					goldenKey = fingerprint.key;
					try {
						// only a golden sent on the message can be raw; one loaded from
						// goldenPath is a file, and files carry their own geometry
						cfg.raw =
							msg.golden == null
								? undefined
								: goldenRawGeometry(msg, msg.golden);
						// only settings actually baked into the cached golden object
						// need to invalidate it - printTolerance/alignSearch/etc are
						// applied fresh per frame in compareFrame.
						cacheKey = [
							fingerprint.key,
							cfg.workingSize,
							cfg.threshold,
							cfg.thresholdMode,
							cfg.sauvolaRadius,
							cfg.sauvolaK,
							// golden.fgAmbiguous is baked in at prepare time
							cfg.inkMargin,
							cfg.backgroundTolerance,
							// whether the golden's debug-stage images were baked in,
							// and in which format
							cfg.debugStages,
							cfg.heatmapFormat,
							cfg.heatmapQuality,
							cfg.mmPerPixelNative,
							// the calibration photo's size, which the mm/px conversion is
							// expressed against
							cfg.calibrationNativeWidth == null
								? ""
								: `${cfg.calibrationNativeWidth}x${cfg.calibrationNativeHeight}`,
							// raw geometry changes how the same bytes decode
							cfg.raw
								? `${cfg.raw.width}x${cfg.raw.height}x${cfg.raw.channels}`
								: "",
							// a named key is trusted, but the length is free to check and
							// catches a different render under a stale name; it is in the
							// cache key only, never in goldenKey, whose format is
							// persisted in trained-transform files
							named && fingerprint.byteLength != null
								? `len:${fingerprint.byteLength}`
								: "",
						].join("|");

						if (!node.goldenCache || node.goldenCache.key !== cacheKey) {
							node.status({
								fill: "blue",
								shape: "dot",
								text: "preparing golden…",
							});
							// Ask before sending. The inspector usually already holds
							// this golden - it outlives a redeploy - and reading the
							// artwork off disk only to have it recognised as a duplicate
							// key is the cost this handshake exists to avoid.
							const promise = (async () => {
								let reply = await inspector.prepare({ cacheKey, cfg });
								if (reply.needGolden) {
									const { buffer: goldenBuf } = await loadImage(
										goldenSource,
										"golden reference",
										fingerprint,
									);
									// the object form is checked inside loadImage; the
									// msg.goldenRawInfo / msg.images[] forms arrive
									// separately, with the buffer known here
									assertRawFits(goldenBuf, cfg.raw, "golden reference");
									reply = await inspector.prepare({
										cacheKey,
										cfg,
										golden: toShared(goldenBuf).buffer,
									});
								}
								return reply.goldenMeta;
							})().catch((err) => {
								// let the next message retry instead of being stuck on a
								// permanently-rejected cache entry
								if (node.goldenCache && node.goldenCache.key === cacheKey) {
									node.goldenCache = null;
								}
								throw err;
							});
							node.goldenCache = { key: cacheKey, promise };
						}
						goldenMeta = await node.goldenCache.promise;
					} finally {
						await fingerprint.close();
					}
				};
				await ensureGolden();

				// The golden's content identity, tying a trained transform to the
				// image rather than to how it was delivered. Lazy and memoised:
				// needed when training, and otherwise only to settle a cheap-key
				// mismatch that would refuse a good record on every frame. Raw
				// geometry rides along because the same bytes decode into a
				// different image under a different width/height/channels.
				const goldenContentKey = async () => {
					const suffix = cfg.raw
						? `:${cfg.raw.width}x${cfg.raw.height}x${cfg.raw.channels}`
						: "";
					if (goldenKey.startsWith("buf:")) {
						return `sha1:${goldenKey.slice(4)}${suffix}`;
					}
					// the suffix is part of the memo key too: a named golden
					// (msg.goldenKey) keeps its name across a change of raw
					// geometry, and the same bytes are a different image then
					const memo = node.goldenContentKey;
					const memoKey = `${goldenKey}${suffix}`;
					if (memo && memo.key === memoKey) return memo.contentKey;
					const { buffer } = await loadImage(goldenSource, "golden reference");
					const contentKey = `sha1:${sha1(buffer)}${suffix}`;
					node.goldenContentKey = { key: memoKey, contentKey };
					return contentKey;
				};

				// The golden is never upscaled, so a source smaller than
				// workingSize silently caps the whole inspection: the frame is
				// brought down to the golden's scale, and detail the camera
				// did capture is thrown away before anything looks at it. Easy
				// to walk into when the golden is a PDF render, where the pixel
				// count is a dpi setting rather than a property of the file.
				const goldenLongEdge = Math.max(
					goldenMeta.nativeWidth || 0,
					goldenMeta.nativeHeight || 0,
				);
				if (
					goldenLongEdge > 0 &&
					goldenLongEdge < cfg.workingSize &&
					node.warnedAboutKey !== cacheKey
				) {
					node.warnedAboutKey = cacheKey;
					node.warn(
						`golden is ${goldenMeta.nativeWidth}x${goldenMeta.nativeHeight}, smaller than ` +
							`workingSize ${cfg.workingSize} - the inspection runs at the golden's ` +
							`resolution, not the frame's. Render it at a higher dpi, or lower ` +
							`workingSize to match.`,
					);
				}

				// The mm/px scale converts across a golden rendered at a different
				// resolution than the calibration photo, so the mm numbers stay
				// right - but the operator should hear that the two framings
				// differ. Keyed on its own flag so it cannot crowd out the
				// golden-too-small warning for the same golden.
				if (
					cfg.mmPerPixelNative != null &&
					cfg.calibrationNativeWidth != null &&
					(goldenMeta.nativeWidth !== cfg.calibrationNativeWidth ||
						goldenMeta.nativeHeight !== cfg.calibrationNativeHeight) &&
					node.warnedAboutGoldenRes !== cacheKey
				) {
					node.warnedAboutGoldenRes = cacheKey;
					node.warn(
						`golden is ${goldenMeta.nativeWidth}x${goldenMeta.nativeHeight}, but the calibration ` +
							`photo was ${cfg.calibrationNativeWidth}x${cfg.calibrationNativeHeight} - the ` +
							`mm/px scale is converted across that resolution difference, so mm ` +
							`tolerances stay correct; calibrate from a photo at the golden's ` +
							`resolution if the conversion surprises you`,
					);
				}

				// No fingerprint for the frame: it is different every time, so
				// nothing is cached against it.
				const { buffer: targetBuf, raw: targetRawFromSource } = await loadImage(
					msg.payload,
					"msg.payload",
				);
				cfg.targetRaw = targetRawGeometry(msg, msg.payload) || targetRawFromSource;
				assertRawFits(targetBuf, cfg.targetRaw, "msg.payload");
				// Copied into shared memory once, so the inspector gets a handle
				// rather than tens of megabytes, and so the decoder never reads
				// the caller's buffer - a flow reusing its capture buffer can no
				// longer corrupt a decode in progress. Mutation between send()
				// and this line still can, and always could.
				const frame = toShared(targetBuf).buffer;

				// Training measures the rig's magnification and the press's
				// stretch from this one frame and writes them down; every
				// later frame reuses them instead of re-deriving a constant.
				// Send msg.golden alongside msg.payload to train from any two
				// images without disturbing the node's configured golden.
				const training = cfg.trainTransform;
				let trainedScore = null;
				let pinRefused = null;
				if (!training && node.transformFilePath) {
					const trained = await readTransformFile(node.transformFilePath, {
						goldenKey,
						goldenContentKey,
						workingSize: cfg.workingSize,
					});
					if (trained && trained.error) {
						// carry on searching rather than aligning to numbers
						// known to be wrong - a stale pin looks like a print
						// fault across the whole frame, which is the most
						// expensive way to be wrong here
						pinRefused = trained.error;
						node.warn(`${trained.error}; searching for the transform instead`);
					} else if (trained) {
						cfg.pinnedScale = { mx: trained.scaleX, my: trained.scaleY };
						trainedScore = trained.record.alignScore;
					}
				}

				// The nuisance map is independent of the trained transform:
				// one pins magnification, the other says what "clean" looks
				// like per block. A rig can sensibly have either alone.
				const trainingNuisance = cfg.trainNuisance;
				if (!trainingNuisance && node.nuisancePath) {
					const map = await nuisance.readNuisanceMap(node.nuisancePath, {
						goldenKey,
						goldenContentKey,
						workingSize: cfg.workingSize,
						blockSize: cfg.blockSize,
					});
					if (map && map.error) {
						// Same posture as a refused pin: run without it rather
						// than subtract a baseline measured somewhere else,
						// which would blind the check in the wrong places.
						node.warn(`${map.error}; comparing without a nuisance map`);
					} else if (map) {
						cfg.nuisanceBaseline = map.baseline;
					}
				}

				node.status({
					fill: "blue",
					shape: "dot",
					text: training ? "training transform…" : "comparing…",
				});
				// The inspector's golden store is bounded, so the entry
				// prepared moments ago can be evicted before this frame uses it
				// - by another node with a different golden, or a message that
				// re-keyed on its own threshold. Re-prepare and try once more.
				//
				// Invalidating the cache first is what makes the retry
				// terminate: ensureGolden decides on `node.goldenCache.key !==
				// cacheKey`, so retrying without clearing it would re-enter a
				// cache *hit*, never send a prepare, and ask the same empty
				// inspector again forever.
				let reply = await inspector.inspect({ cacheKey, cfg, frame });
				if (reply.needGolden) {
					if (node.goldenCache && node.goldenCache.key === cacheKey) {
						node.goldenCache = null;
					}
					await ensureGolden();
					reply = await inspector.inspect({ cacheKey, cfg, frame });
					if (reply.needGolden) {
						throw new Error(
							"the inspector lost the prepared golden twice in a row - " +
								"the golden store is too small for the number of goldens in flight",
						);
					}
				}
				const result = reply.result;

				// A pinned transform cannot notice that the press has changed.
				// The stretch is a property of the print run, not of the
				// golden, so a new run on the same artwork needs retraining
				// and no file check can see it coming - the golden matches.
				// What does show it is the alignment residual: it jumps well
				// clear of what training measured. Say so rather than
				// reporting a frame-wide print fault.
				if (
					trainedScore != null &&
					result.transform.score > trainedScore * 1.5 + 0.005
				) {
					node.warn(
						`alignment residual ${result.transform.score.toFixed(4)} is well above the ` +
							`${trainedScore.toFixed(4)} measured at training - the trained transform ` +
							`probably no longer fits this print run; retrain it`,
					);
				}

				if (training) {
					const record = {
						scaleX: result.transform.scaleX,
						scaleY: result.transform.scaleY,
						stretchPercent: result.transform.stretchPercent,
						angleDeg: result.transform.angleDeg,
						alignScore: result.transform.score,
						goldenKey,
						// what the record is really tied to: the golden's bytes, so
						// the same image still matches when it arrives by a different
						// route than the one it was trained through
						goldenContentKey: await goldenContentKey(),
						workingSize: cfg.workingSize,
						goldenWidth: goldenMeta.width,
						goldenHeight: goldenMeta.height,
						trainedAt: new Date().toISOString(),
					};
					if (!node.transformFilePath) {
						throw new Error(
							"training needs a Trained transform path to write to - set one on the node",
						);
					}
					await writeTransformFile(node.transformFilePath, record);
					msg.trainedTransform = record;
					node.log(
						`trained transform: scaleX=${record.scaleX.toFixed(5)} ` +
							`scaleY=${record.scaleY.toFixed(5)} stretch=${record.stretchPercent.toFixed(2)}% ` +
							`alignScore=${record.alignScore.toFixed(4)} -> ${node.transformFilePath}`,
					);
				}

				// Nuisance-map training folds this frame's background density
				// grid into the running accumulator and rewrites the map, every
				// frame, so a run can be stopped whenever it looks settled. The
				// frames must be known-good: a defect trained in becomes a blind
				// spot exactly where it sat.
				if (trainingNuisance) {
					const bg = result.backgroundBlemish;
					if (!node.nuisancePath) {
						throw new Error(
							"training a nuisance map needs a Nuisance map path to write to - set one on the node",
						);
					}
					if (!bg || !bg.densityBytes) {
						throw new Error(
							"nuisance training got no density grid back from the comparison",
						);
					}
					if (
						node.nuisanceAcc &&
						(node.nuisanceAcc.gridW !== bg.gridW ||
							node.nuisanceAcc.gridH !== bg.gridH)
					) {
						// geometry changed mid-run; the partial map describes a
						// grid that no longer exists
						node.warn(
							`nuisance training restarted: grid changed to ${bg.gridW}x${bg.gridH}`,
						);
						node.nuisanceAcc = null;
					}
					if (!node.nuisanceAcc) {
						node.nuisanceAcc = nuisance.createAccumulator(bg.gridW, bg.gridH);
					}
					nuisance.accumulate(
						node.nuisanceAcc,
						nuisance.dequantizeDensity(bg.densityBytes),
					);
					const baseline = nuisance.finalize(node.nuisanceAcc);
					const record = nuisance.buildRecord(baseline, node.nuisanceAcc, {
						channel: "background",
						blockSize: cfg.blockSize,
						workingSize: cfg.workingSize,
						goldenKey,
						goldenContentKey: await goldenContentKey(),
					});
					await nuisance.writeNuisanceMap(node.nuisancePath, record);
					msg.trainedNuisance = {
						frames: record.frames,
						gridW: record.gridW,
						gridH: record.gridH,
						path: node.nuisancePath,
					};
					node.log(
						`nuisance map: ${record.frames} frame(s), ` +
							`${record.gridW}x${record.gridH} -> ${node.nuisancePath}`,
					);
				}

				msg.payload = result.pass;
				msg.result = {
					pass: result.pass,
					position: result.position,
					// a node.warn() is easy to miss in the sidebar, and a refused
					// pin is otherwise invisible from the message: same shape,
					// silently slower, transform.pinned quietly false
					transform: pinRefused
						? { ...result.transform, pinRefused }
						: result.transform,
					// registration grade, and whether this looks like the wrong
					// golden rather than a bad part - see gradeMatch
					match: result.match,
					thresholds: result.thresholds,
					localAlign: result.localAlign,
					printBlemish: {
						pass: result.printBlemish.pass,
						defectRatio: result.printBlemish.defectRatio,
						regions: result.printBlemish.regions,
					},
					backgroundBlemish: {
						pass: result.backgroundBlemish.pass,
						defectRatio: result.backgroundBlemish.defectRatio,
						regions: result.backgroundBlemish.regions,
						// How far the dirtiest block exceeded its trained
						// baseline, and whether that alone failed the frame.
						// 0 / true when no nuisance map is loaded.
						worstExcess: result.backgroundBlemish.worstExcess,
						noveltyPass: result.backgroundBlemish.noveltyPass,
					},
				};
				msg.timings = {
					decodeMs: Math.round(result.timings.decodeMs),
					alignMs: Math.round(result.timings.alignMs),
					diffMs: Math.round(result.timings.diffMs),
					heatmapMs: Math.round(result.timings.heatmapMs),
					stagesMs: Math.round(result.timings.stagesMs),
					totalMs: Math.round(performance.now() - totalStart),
				};
				setOrDelete(msg, "printHeatmap", result.printBlemish.heatmap);
				setOrDelete(msg, "backgroundHeatmap", result.backgroundBlemish.heatmap);
				setOrDelete(msg, "stages", result.stages);

				send(msg);

				// Said before the pass/fail line, because it changes what that
				// line means: every number below it is a comparison against
				// something that is not this label.
				if (result.match.mismatchSuspected) {
					node.warn(`golden-compare: ${result.match.reason}`);
				}

				const failedParts = [];
				if (!result.position.pass) failedParts.push("position");
				if (!result.printBlemish.pass) failedParts.push("print");
				if (!result.backgroundBlemish.pass) failedParts.push("background");
				node.status({
					fill: result.pass ? "green" : "red",
					shape: result.pass ? "dot" : "ring",
					text:
						(result.match.mismatchSuspected
							? `different label? · align ${result.match.score.toFixed(3)}`
							: result.pass
								? `pass · align ${result.match.score.toFixed(3)}`
								: `fail (${failedParts.join("+")}) · align ${result.match.score.toFixed(3)}`) +
						` · ${fmtMs(performance.now() - totalStart)}`,
				});
				const pos = result.position;
				const posStr =
					(pos.dxMm == null
						? `dx=${pos.dxPx}px dy=${pos.dyPx}px`
						: `dx=${pos.dxMm.toFixed(2)}mm dy=${pos.dyMm.toFixed(2)}mm`) +
					` angle=${pos.angleDeg.toFixed(2)}deg scale=${pos.scale.toFixed(3)}` +
					` stretch=${pos.stretchPercent.toFixed(2)}%` +
					(result.transform.pinned ? " pinned" : "");
				const matchStr = `align(${result.match.grade} ${result.match.score.toFixed(4)}${
					result.match.mismatchSuspected ? " DIFFERENT-LABEL?" : ""
				}) `;
				node.log(
					`golden-compare: ${result.pass ? "PASS" : "FAIL"} [${failedParts.join("+") || "none"}] ` +
						matchStr +
						`position(${pos.pass ? "ok" : "FAIL"} ${posStr}) ` +
						`print(${result.printBlemish.pass ? "ok" : "FAIL"} ratio=${result.printBlemish.defectRatio.toFixed(5)} regions=${result.printBlemish.regions.length}) ` +
						`background(${result.backgroundBlemish.pass ? "ok" : "FAIL"} ratio=${result.backgroundBlemish.defectRatio.toFixed(5)} regions=${result.backgroundBlemish.regions.length}) | ` +
						`decode ${fmtMs(result.timings.decodeMs)}, align ${fmtMs(result.timings.alignMs)}, ` +
						`diff ${fmtMs(result.timings.diffMs)}, heatmap ${fmtMs(result.timings.heatmapMs)}, ` +
						`stages ${fmtMs(result.timings.stagesMs)}, total ${fmtMs(msg.timings.totalMs)}`,
				);
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: "error" });
				// done(err) is the one failure path; a node.error here as well
				// would report every failure twice
				done(err);
			}
		});
	}

	RED.nodes.registerType("golden-compare", GoldenCompareNode);
};
