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
 * a file path string, or an object { data | buffer | path }.
 * Optional per-message overrides: msg.golden (path/Buffer - swaps and
 * re-caches the golden reference), msg.threshold, msg.inkMargin,
 * msg.printTolerance,
 * msg.backgroundTolerance, msg.alignSearch, msg.positionToleranceXMm,
 * msg.positionToleranceYMm, msg.positionToleranceXPx,
 * msg.positionToleranceYPx, msg.blockSize, msg.blockThreshold,
 * msg.failThreshold, msg.failRatio, msg.outputPrintHeatmap,
 * msg.outputBackgroundHeatmap, msg.debugStages, msg.heatmapFormat,
 * msg.heatmapQuality.
 */

const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const inspector = require("./lib/inspector.js");
const { toShared } = require("./lib/shared.js");
const { readScaleFile } = require("./lib/scaleFile.js");
const {
	readTransformFile,
	writeTransformFile,
} = require("./lib/transformFile.js");
const nuisance = require("./lib/nuisanceMap.js");

module.exports = (RED) => {
	const BOUNDS = {
		workingSize: [64, 4096],
		threshold: [0, 255],
		tolerance: [0, 50],
		alignSearch: [0, 200],
		blockSize: [4, 256],
		positionPx: [0, 1000],
		positionMm: [0, 1000],
		angleDeg: [0, 30],
		aspect: [0, 0.5],
		aspectSteps: [1, 21],
		angleSteps: [1, 21],
		scale: [0.1, 10],
		scaleSteps: [1, 61],
		sauvolaRadius: [2, 200],
		sauvolaK: [0.01, 1],
		inkMargin: [0, 128],
		alignCandidates: [1, 16],
		localAlignTile: [16, 512],
		localAlignMax: [1, 16],
		workers: [0, 64],
		mismatchScore: [0, 1],
	};
	const THRESHOLD_MODES = ["fixed", "otsu", "sauvola"];

	function pickMode(value, fallback) {
		return THRESHOLD_MODES.includes(value) ? value : fallback;
	}
	const UNIT_BOUNDS = [0, 1];

	function clampInt(value, fallback, [min, max]) {
		const n = parseInt(value, 10);
		if (isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function clampFloat(value, fallback, [min, max]) {
		const n = parseFloat(value);
		if (isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function fmtMs(ms) {
		return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
	}

	// Image inputs are capped before anything copies, hashes, or reads
	// them: an unbounded buffer would be copied and SHA-1'd on every
	// message for no inspection value, and an unbounded path read would
	// hang or OOM on a special file like /dev/zero. 512MB is far past the
	// largest capture this pipeline is meant for (a 23MP framebuffer is
	// ~90MB).
	const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

	/**
	 * Read an image file through one handle: open -> fstat -> guards ->
	 * read. The guards are the point. A pathExists() then readFile() pair
	 * is a race (the file can be swapped between the two), and an
	 * unguarded path read lets a flow point msg.golden at /dev/zero and
	 * hang the node on an endless read. Returns null when the path does
	 * not exist, so callers can keep distinguishing "missing" from
	 * "refused".
	 */
	async function openRegularFile(p, label) {
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
			return { handle: fd, mtimeMs: stat.mtimeMs, size: stat.size };
		} catch (err) {
			await fd.close();
			throw err;
		}
	}

	/** open -> fstat -> guards -> read -> close, for callers that want the
	 * bytes outright rather than a handle to fingerprint from. */
	async function readRegularFile(p, label) {
		const open = await openRegularFile(p, label);
		if (!open) return null;
		try {
			return {
				buffer: await open.handle.readFile(),
				mtimeMs: open.mtimeMs,
				size: open.size,
			};
		} finally {
			await open.handle.close();
		}
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
		const data =
			Buffer.isBuffer(source) ||
			source instanceof Uint8Array ||
			source instanceof ArrayBuffer
				? source
				: source && typeof source === "object"
					? source.data || source.buffer
					: null;
		if (
			Buffer.isBuffer(data) ||
			data instanceof Uint8Array ||
			data instanceof ArrayBuffer
		) {
			return data;
		}
		return null;
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

	function assertUnderCap(data, label) {
		if (data.byteLength > MAX_IMAGE_BYTES) {
			throw new Error(
				`${label} is ${data.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte cap`,
			);
		}
	}

	/**
	 * Load an image source (Buffer/path/object) to { buffer, raw }.
	 *
	 * Every guard the node has ever applied lives here: the size cap, the
	 * regular-file check, the distinct missing-file errors for a path string
	 * versus a path inside an object, and the raw-descriptor length check.
	 *
	 * `prefetched` is an already-open handle from fingerprintImage, so a
	 * path golden that has just been stat'ed for its cache key is read
	 * through the *same* handle rather than reopened - the file cannot be
	 * swapped between the two, which is the race the single-handle
	 * open/fstat/read was written to avoid in the first place.
	 */
	async function loadImage(source, label, prefetched) {
		if (source == null || source === "") {
			throw new Error(`${label} is empty`);
		}
		const data = bytesOf(source);
		if (data) {
			assertUnderCap(data, label);
			// A real Buffer is already exactly what sharp wants, so it is not
			// copied here. Uint8Array and ArrayBuffer must be - those can be
			// views onto a larger buffer the caller keeps writing to - and when
			// they are, the copy goes *straight into shared memory*. The frame
			// has to end up there anyway to reach the inspector, and doing it
			// in two steps (Buffer.from, then toShared) copied a 68MB
			// framebuffer twice: 10.3ms + 12.6ms, both on the event loop.
			const buffer = Buffer.isBuffer(data) ? data : sharedCopy(data);
			const raw = rawGeometry(source);
			assertRawFits(buffer, raw, label);
			return { buffer, raw };
		}
		if (typeof source === "string") {
			if (prefetched) return { buffer: await prefetched.handle.readFile() };
			const file = await readRegularFile(source, label);
			if (!file) {
				throw new Error(`${label} does not exist on disk: "${source}"`);
			}
			return { buffer: file.buffer };
		}
		if (typeof source === "object") {
			if (typeof source.path === "string") {
				if (prefetched) return { buffer: await prefetched.handle.readFile() };
				const file = await readRegularFile(source.path, label);
				if (file) return { buffer: file.buffer };
			}
			throw new Error(
				`${label} object must contain "data"/"buffer" or an existing "path"`,
			);
		}
		throw new Error(`unsupported ${label} type: ${typeof source}`);
	}

	/**
	 * A cheap, stable fingerprint of an image source, *without* reading or
	 * hashing its bytes wherever that can be avoided. This is the half of the
	 * old resolveImage that has to run on every message; loadImage is the
	 * half that only has to run when the golden cache misses.
	 *
	 * Costs, per form:
	 *  - a path is fingerprinted by mtime and size, so overwriting the golden
	 *    in place still re-prepares the cache (and refuses the stale trained
	 *    transform measured against the old bytes). The handle stays open for
	 *    loadImage, so a hit costs one open+fstat and no read at all - it used
	 *    to read the whole artwork on every frame and throw it away.
	 *  - a named key (msg.goldenKey) skips the SHA-1 entirely. That is what
	 *    the option was always documented to do and never actually did: the
	 *    hash ran inside resolveImage before the name was consulted.
	 *  - an unnamed buffer still has to be hashed. There is nothing else in
	 *    it that says whether it changed.
	 *
	 * The caller must always call close(), hit or miss.
	 */
	async function fingerprintImage(source, label, namedKey) {
		if (source == null || source === "") {
			throw new Error(`${label} is empty`);
		}
		const named = namedKey ? `key:${namedKey}` : null;
		const data = bytesOf(source);
		if (data) {
			assertUnderCap(data, label);
			return {
				key:
					named ||
					`buf:${crypto.createHash("sha1").update(Buffer.isBuffer(data) ? data : Buffer.from(data)).digest("hex")}`,
				// cheap, and the only thing a named key can be cross-checked
				// against without reading the bytes it deliberately ignores
				byteLength: data.byteLength,
				close: async () => {},
			};
		}
		const p =
			typeof source === "string"
				? source
				: source && typeof source === "object" && typeof source.path === "string"
					? source.path
					: null;
		if (p !== null) {
			// Stat even under a named key. It costs ~0.02ms, it keeps a deleted
			// or swapped-for-a-directory golden an error rather than a silently
			// reused cache entry, and only the *read* was ever expensive.
			const open = await openRegularFile(p, label);
			if (!open) {
				throw new Error(
					typeof source === "string"
						? `${label} does not exist on disk: "${p}"`
						: `${label} object must contain "data"/"buffer" or an existing "path"`,
				);
			}
			return {
				key: named || `path:${p}:${open.mtimeMs}:${open.size}`,
				handle: open.handle,
				close: () => open.handle.close(),
			};
		}
		if (typeof source === "object") {
			throw new Error(
				`${label} object must contain "data"/"buffer" or an existing "path"`,
			);
		}
		throw new Error(`unsupported ${label} type: ${typeof source}`);
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
		if (
			Buffer.isBuffer(source) ||
			source instanceof Uint8Array ||
			source instanceof ArrayBuffer
		) {
			return rawGeometryFromImages(msg);
		}
		return undefined;
	}

	function GoldenCompareNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.goldenPath = String(config.goldenPath || "").trim();
		node.workingSize = clampInt(config.workingSize, 1024, BOUNDS.workingSize);
		node.threshold = clampInt(config.threshold, 128, BOUNDS.threshold);
		// otsu by default, not a fixed level: the golden is normally PDF
		// artwork - synthetic pure black on pure white - and the frame is a
		// photograph. There is no single grey level that is correct for
		// both, and no reason to make the operator discover that.
		node.thresholdMode = pickMode(config.thresholdMode, "otsu");
		node.sauvolaRadius = clampInt(config.sauvolaRadius, 24, BOUNDS.sauvolaRadius);
		node.sauvolaK = clampFloat(config.sauvolaK, 0.2, BOUNDS.sauvolaK);
		node.inkMargin = clampInt(config.inkMargin, 8, BOUNDS.inkMargin);
		// Wide by default: on a frame that is already at golden's scale the
		// extra rungs cost almost nothing (there is barely any margin to
		// sweep), while a narrow default would silently fail every
		// artwork-as-golden setup - the case the search exists for.
		node.scaleSearchMin = clampFloat(config.scaleSearchMin, 0.6, BOUNDS.scale);
		node.scaleSearchMax = clampFloat(config.scaleSearchMax, 2.5, BOUNDS.scale);
		node.scaleSearchSteps = clampInt(
			config.scaleSearchSteps,
			19,
			BOUNDS.scaleSteps,
		);
		// Presses stretch print along the media-feed axis relative to the
		// artwork - measured at 5-6% on this project's own samples. Left
		// unsearched it is not a small error: it puts every feature several
		// pixels out toward the ends of the long axis and fails a good part
		// on both blemish checks.
		node.alignCandidates = clampInt(
			config.alignCandidates,
			5,
			BOUNDS.alignCandidates,
		);
		// 0 = auto (one per core, capped at 8, leaving one for the event
		// loop); 1 disables the pool and keeps every stage on this thread
		node.workers = clampInt(config.workers, 0, BOUNDS.workers);
		// 0 disables the "this is a different label" check entirely
		node.mismatchScore = clampFloat(
			config.mismatchScore,
			0.15,
			BOUNDS.mismatchScore,
		);
		node.localAlign = config.localAlign !== false;
		node.localAlignTile = clampInt(
			config.localAlignTile,
			96,
			BOUNDS.localAlignTile,
		);
		node.localAlignMax = clampInt(config.localAlignMax, 3, BOUNDS.localAlignMax);
		node.maxAspect = clampFloat(config.maxAspect, 0.06, BOUNDS.aspect);
		node.aspectSteps = clampInt(config.aspectSteps, 7, BOUNDS.aspectSteps);
		node.maxAngleDeg = clampFloat(config.maxAngleDeg, 2, BOUNDS.angleDeg);
		node.angleSteps = clampInt(config.angleSteps, 5, BOUNDS.angleSteps);
		node.positionToleranceAngleDeg = clampFloat(
			config.positionToleranceAngleDeg,
			1,
			BOUNDS.angleDeg,
		);
		// tight because localAlign is on by default: the dilation no longer
		// has to absorb registration error, only genuine edge variation
		node.printTolerance = clampInt(config.printTolerance, 2, BOUNDS.tolerance);
		node.backgroundTolerance = clampInt(
			config.backgroundTolerance,
			1,
			BOUNDS.tolerance,
		);
		node.alignSearch = clampInt(config.alignSearch, 16, BOUNDS.alignSearch);
		node.positionToleranceXMm = clampFloat(
			config.positionToleranceXMm,
			2,
			BOUNDS.positionMm,
		);
		node.positionToleranceYMm = clampFloat(
			config.positionToleranceYMm,
			2,
			BOUNDS.positionMm,
		);
		node.positionToleranceXPx = clampInt(
			config.positionToleranceXPx,
			16,
			BOUNDS.positionPx,
		);
		node.positionToleranceYPx = clampInt(
			config.positionToleranceYPx,
			16,
			BOUNDS.positionPx,
		);
		node.blockSize = clampInt(config.blockSize, 16, BOUNDS.blockSize);
		node.blockThreshold = clampFloat(config.blockThreshold, 0.15, UNIT_BOUNDS);
		node.failThreshold = clampFloat(config.failThreshold, 0.3, UNIT_BOUNDS);
		node.failRatio = clampFloat(config.failRatio, 0.002, UNIT_BOUNDS);
		node.outputPrintHeatmap = config.outputPrintHeatmap !== false;
		node.outputBackgroundHeatmap = config.outputBackgroundHeatmap !== false;
		// JPEG unless asked for PNG: a heat map is a picture for a person,
		// and PNG was ~150ms per image at working size (see encodeImage in
		// lib/compare.js). Also applies to msg.stages.
		node.heatmapFormat =
			config.heatmapFormat === "png" || config.heatmapFormat === "raw"
				? config.heatmapFormat
				: "jpg";
		node.heatmapQuality = clampInt(config.heatmapQuality, 85, [1, 100]);
		node.debugStages = !!config.debugStages;
		node.scaleFilePath = String(config.scaleFilePath || "").trim();
		node.transformFilePath = String(config.transformFilePath || "").trim();
		node.trainTransform = !!config.trainTransform;
		node.nuisancePath = String(config.nuisancePath || "").trim();
		node.trainNuisance = !!config.trainNuisance;
		// 0 disables the gate outright. Measured window on the reference
		// run is 0.27-0.32; see lib/nuisanceMap.js on why it is that narrow
		// and how the training set size moves the lower edge.
		node.noveltyThreshold = clampFloat(config.noveltyThreshold, 0.3, UNIT_BOUNDS);
		// Accumulates across frames for the life of the node, so a training
		// run is "send the good frames through", not a single message.
		node.nuisanceAcc = null;
		// PROTOTYPES, default off - see lib/nativeSeed.js
		node.nativeAlignSeed = !!config.nativeAlignSeed;
		node.nativeFastAlign = !!config.nativeFastAlign;

		// { key, promise } - cached prepared golden, keyed by fingerprintImage()'s
		// fingerprint plus every setting baked into the cached object
		// (workingSize, threshold, thresholdMode, sauvolaRadius, sauvolaK,
		// inkMargin, backgroundTolerance, debugStages, mmPerPixelNative, the
		// calibration photo's size, and the raw geometry - the cacheKey
		// construction below is the authoritative list), so a changed
		// msg.golden, a re-pointed goldenPath, a fresh calibration save, or
		// a flipped baked setting all trigger exactly one re-prepare, shared
		// by any messages that arrive while it's in flight.
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
				const cfg = {
					workingSize: node.workingSize,
					threshold: clampInt(msg.threshold, node.threshold, BOUNDS.threshold),
					thresholdMode: pickMode(msg.thresholdMode, node.thresholdMode),
					sauvolaRadius: clampInt(
						msg.sauvolaRadius,
						node.sauvolaRadius,
						BOUNDS.sauvolaRadius,
					),
					sauvolaK: clampFloat(msg.sauvolaK, node.sauvolaK, BOUNDS.sauvolaK),
					inkMargin: clampInt(msg.inkMargin, node.inkMargin, BOUNDS.inkMargin),
					scaleSearchMin: clampFloat(
						msg.scaleSearchMin,
						node.scaleSearchMin,
						BOUNDS.scale,
					),
					scaleSearchMax: clampFloat(
						msg.scaleSearchMax,
						node.scaleSearchMax,
						BOUNDS.scale,
					),
					scaleSearchSteps: clampInt(
						msg.scaleSearchSteps,
						node.scaleSearchSteps,
						BOUNDS.scaleSteps,
					),
					alignCandidates: clampInt(
						msg.alignCandidates,
						node.alignCandidates,
						BOUNDS.alignCandidates,
					),
					workers: clampInt(msg.workers, node.workers, BOUNDS.workers),
					mismatchScore: clampFloat(
						msg.mismatchScore,
						node.mismatchScore,
						BOUNDS.mismatchScore,
					),
					localAlign: msg.localAlign == null ? node.localAlign : !!msg.localAlign,
					localAlignTile: clampInt(
						msg.localAlignTile,
						node.localAlignTile,
						BOUNDS.localAlignTile,
					),
					localAlignMax: clampInt(
						msg.localAlignMax,
						node.localAlignMax,
						BOUNDS.localAlignMax,
					),
					maxAspect: clampFloat(msg.maxAspect, node.maxAspect, BOUNDS.aspect),
					aspectSteps: clampInt(
						msg.aspectSteps,
						node.aspectSteps,
						BOUNDS.aspectSteps,
					),
					maxAngleDeg: clampFloat(
						msg.maxAngleDeg,
						node.maxAngleDeg,
						BOUNDS.angleDeg,
					),
					angleSteps: clampInt(msg.angleSteps, node.angleSteps, BOUNDS.angleSteps),
					positionToleranceAngleDeg: clampFloat(
						msg.positionToleranceAngleDeg,
						node.positionToleranceAngleDeg,
						BOUNDS.angleDeg,
					),
					printTolerance: clampInt(
						msg.printTolerance,
						node.printTolerance,
						BOUNDS.tolerance,
					),
					backgroundTolerance: clampInt(
						msg.backgroundTolerance,
						node.backgroundTolerance,
						BOUNDS.tolerance,
					),
					alignSearch: clampInt(
						msg.alignSearch,
						node.alignSearch,
						BOUNDS.alignSearch,
					),
					positionToleranceXMm: clampFloat(
						msg.positionToleranceXMm,
						node.positionToleranceXMm,
						BOUNDS.positionMm,
					),
					positionToleranceYMm: clampFloat(
						msg.positionToleranceYMm,
						node.positionToleranceYMm,
						BOUNDS.positionMm,
					),
					positionToleranceXPx: clampInt(
						msg.positionToleranceXPx,
						node.positionToleranceXPx,
						BOUNDS.positionPx,
					),
					positionToleranceYPx: clampInt(
						msg.positionToleranceYPx,
						node.positionToleranceYPx,
						BOUNDS.positionPx,
					),
					blockSize: clampInt(msg.blockSize, node.blockSize, BOUNDS.blockSize),
					blockThreshold: clampFloat(
						msg.blockThreshold,
						node.blockThreshold,
						UNIT_BOUNDS,
					),
					failThreshold: clampFloat(
						msg.failThreshold,
						node.failThreshold,
						UNIT_BOUNDS,
					),
					failRatio: clampFloat(msg.failRatio, node.failRatio, UNIT_BOUNDS),
					outputPrintHeatmap:
						msg.outputPrintHeatmap == null
							? node.outputPrintHeatmap
							: !!msg.outputPrintHeatmap,
					outputBackgroundHeatmap:
						msg.outputBackgroundHeatmap == null
							? node.outputBackgroundHeatmap
							: !!msg.outputBackgroundHeatmap,
					debugStages:
						msg.debugStages == null ? node.debugStages : !!msg.debugStages,
					heatmapFormat: ["png", "jpg", "raw"].includes(msg.heatmapFormat)
						? msg.heatmapFormat
						: node.heatmapFormat,
					heatmapQuality: clampInt(
						msg.heatmapQuality,
						node.heatmapQuality,
						[1, 100],
					),
					// PROTOTYPE. Seeds the pinned search from a native ORB+ECC
					// alignment instead of the staged sweeps, when the optional
					// @rosepetal/node-red-contrib-image-tools engine is
					// installed. Silently inert without it, and the sweeps stay
					// the fallback for a seed that fails its range check.
					nativeAlignSeed:
						msg.nativeAlignSeed == null
							? node.nativeAlignSeed
							: !!msg.nativeAlignSeed,
					// Aggressive prototype: OpenCV owns affine solve + global warp.
					// It intentionally may produce different inspection results.
					nativeFastAlign:
						msg.nativeFastAlign == null
							? node.nativeFastAlign
							: Boolean(msg.nativeFastAlign),
					mmPerPixelNative: scaleOk ? scale.mmPerPixelNative : null,
					// the calibration photo's own native size, so prepareGolden can
					// convert the mm/px scale across a golden rendered at a
					// different resolution than the calibration was taken at
					calibrationNativeWidth: scaleOk ? scale.nativeWidth : null,
					calibrationNativeHeight: scaleOk ? scale.nativeHeight : null,
				};

				// Fingerprint first, load only on a miss. The golden's bytes are
				// the most expensive thing this node can touch, and on the hot
				// path they have not changed - re-reading the artwork file, or
				// re-hashing a 12MB render, is time spent re-learning a constant.
				// msg.goldenKey names the golden instead, which is what it was
				// always documented to do.
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
							// A named key is the flow's assertion that the bytes did not
							// change, and it is deliberately trusted. The length is free
							// to check and catches the coarsest way that assertion can be
							// wrong (a different render under a stale name); it is in the
							// cache key only, never in `goldenKey` itself, which is
							// persisted in trained-transform files and must keep its
							// format.
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

				// The golden's content identity, for tying a trained transform to
				// the image rather than to how the image was delivered. Lazy and
				// memoised on the node: it is needed when training, and otherwise
				// only to settle a cheap-key mismatch that would refuse a good
				// record on every frame. A buffer golden is already keyed by its
				// own SHA-1, so that case costs nothing; a path golden is read and
				// hashed once per file version, never per frame. Raw geometry
				// rides along because the same bytes decode into a different image
				// under a different width/height/channels.
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
					const contentKey = `sha1:${crypto
						.createHash("sha1")
						.update(buffer)
						.digest("hex")}${suffix}`;
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

				// The calibration measures mm/px on the calibration photo's own
				// native resolution; the formula converts across a golden rendered
				// at a different one, so the mm numbers stay right - but an
				// operator who calibrated on a 4096-wide capture and then feeds
				// 1844-wide artwork should hear that the two framings differ.
				// Keyed on its own flag so it cannot crowd out the golden-too-small
				// warning for the same golden.
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
				// nothing is cached against it and the key was computed and
				// thrown away. That was a SHA-1 of the whole payload on every
				// message - 27ms of a 23MP framebuffer, for nothing.
				const { buffer: targetBuf, raw: targetRawFromSource } = await loadImage(
					msg.payload,
					"msg.payload",
				);
				cfg.targetRaw = targetRawGeometry(msg, msg.payload) || targetRawFromSource;
				assertRawFits(targetBuf, cfg.targetRaw, "msg.payload");
				// Copied into shared memory once, here, so the inspector gets a
				// handle rather than tens of megabytes: ~12ms for a 23MP raw
				// framebuffer against the ~600ms of frozen event loop it buys.
				//
				// It also narrows - but does not close - an old hazard: sharp
				// decodes asynchronously from whatever buffer it was given, so
				// a flow reusing its capture buffer could corrupt a decode
				// already in progress. After this copy the decoder never sees
				// the caller's memory, so mutation *during* the decode is no
				// longer possible; mutation between send() and this line still
				// is, and always was.
				const frame = toShared(targetBuf).buffer;

				// Training measures the rig's magnification and the press's
				// stretch from this one frame and writes them down; every
				// later frame reuses them instead of re-deriving a constant.
				// Send msg.golden alongside msg.payload to train from any two
				// images without disturbing the node's configured golden.
				const training =
					msg.trainTransform == null ? node.trainTransform : !!msg.trainTransform;
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
				const trainingNuisance =
					msg.trainNuisance == null
						? node.trainNuisance
						: !!msg.trainNuisance;
				cfg.trainNuisance = trainingNuisance;
				cfg.noveltyThreshold = node.noveltyThreshold;
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

				// Nuisance-map training: fold this frame's background density
				// grid into the running accumulator and rewrite the map. Every
				// frame rewrites it, so a run can be stopped whenever it looks
				// settled rather than having to declare its length up front -
				// the file is ~66KB and training is not a production path.
				//
				// The operator's contract is the same one the golden itself
				// has: these frames must be known-good. A defect trained in
				// becomes a blind spot exactly where it sat.
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
				if (result.printBlemish.heatmap) {
					msg.printHeatmap = result.printBlemish.heatmap;
				} else {
					delete msg.printHeatmap;
				}
				if (result.backgroundBlemish.heatmap) {
					msg.backgroundHeatmap = result.backgroundBlemish.heatmap;
				} else {
					delete msg.backgroundHeatmap;
				}
				if (result.stages) {
					msg.stages = result.stages;
				} else {
					delete msg.stages;
				}

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
					text: result.match.mismatchSuspected
						? `different label? · align ${result.match.score.toFixed(3)}`
						: result.pass
							? `pass · align ${result.match.score.toFixed(3)} · ${msg.timings.totalMs}ms`
							: `fail (${failedParts.join("+")}) · align ${result.match.score.toFixed(3)} · ${msg.timings.totalMs}ms`,
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
				// done(err) routes the failure through node.error exactly
				// once; an explicit node.error here reported every failure
				// twice (double log lines, Catch nodes firing twice)
				done(err);
			}
		});
	}

	RED.nodes.registerType("golden-compare", GoldenCompareNode);
};
