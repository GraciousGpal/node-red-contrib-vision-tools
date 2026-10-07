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
const { toShared, accountShared } = require("./lib/shared.js");
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
		// 37 rungs over 0.6-2.5 is a 4% step; 19 was 8%, which the joint
		// refine did not always bridge. On the synthetic set 37 took the
		// mean scale error from 0.31% to 0.08%, clean false fails from 15 to
		// 10 of 34, and no time - a search that starts nearer finishes sooner.
		scaleSearchSteps: { value: 37, int: [1, 61] },
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
		// the fraction of the golden's ink that must be in the frame for
		// there to be a label to judge; 0 disables. A blank tray passed
		// every other check on the rig - see gradeMatch in lib/compare.js.
		minCoverage: { value: 0.5, float: [0, 1] },
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
		// px of the golden's own border, every side, that no check looks
		// at. The label's edge lands here, and so does whatever
		// is just past it - substrate, a lifted edge's shadow - which is not
		// a mark on the artwork. 0 inspects to the edge.
		edgeMargin: { value: 0, int: [0, 1024] },
		alignSearch: { value: 16, int: [0, 200] },
		positionToleranceXMm: { value: 2, float: [0, 1000] },
		positionToleranceYMm: { value: 2, float: [0, 1000] },
		positionToleranceXPx: { value: 16, int: [0, 1000] },
		positionToleranceYPx: { value: 16, int: [0, 1000] },
		blockSize: { value: 16, int: [4, 256] },
		blockThreshold: { value: 0.15, float: [0, 1] },
		failThreshold: { value: 0.3, float: [0, 1] },
		failRatio: { value: 0.002, float: [0, 1] },
		// A print block that lost at least this fraction of the ink the golden
		// has there fails, however small a share of the block's area that ink
		// was. Body type is 10-15% ink, so a dropped word never reaches
		// failThreshold by area and never reaches failRatio; against its own
		// ink it reads 1.0. Print only - extra ink has no "should be". 0 = off.
		printMissingFraction: { value: 0.5, float: [0, 1] },
		// The tone check: each pixel's grey against what the artwork's own
		// grey there should photograph as - the neighbourhood's paper and
		// ink levels with the golden's grey mapped between them - as a
		// fraction of the paper-to-ink span. A smudge, a ghosted impression
		// or faded print never crosses the ink threshold and so never
		// reaches the two binary checks; at 0.3 this sees a 70% smudge
		// (0.56) and a 46% ghost (0.46) and leaves a stain a few levels off
		// paper (0.1-0.2) alone, and a grey panel in the artwork is expected
		// grey. 0 = off.
		toneThreshold: { value: 0.3, float: [0, 1] },
		// px either side of an ink edge the tone check leaves out: where
		// blur and sub-pixel registration put legitimate grey
		toneMargin: { value: 6, int: [0, 50] },
		// the slack comes from the trained transform when it measured one;
		// the number above is then the fallback for an untrained rig
		toneMarginAuto: { value: true },
		// The speck check: connected components of the same tone deviation,
		// at this level, counted. Dust and pinholes are one to three px each
		// and never make a block dense; what they have is number. 0 = off.
		speckThreshold: { value: 0.3, float: [0, 1] },
		// 3 px, not 2: on a real label's harsh-preset frame, two-pixel
		// components of JPEG and sensor noise reached the count gate once;
		// three never did, and dust and pinholes lost nothing
		speckMinArea: { value: 3, int: [1, 100000] },
		// fail on this many specks, or on one speck this big (px); 0 = no gate
		speckMaxCount: { value: 8, int: [0, 1000000] },
		speckMaxArea: { value: 48, int: [0, 10000000] },
		// every check's regions on the aligned frame in one picture, each in
		// its own colour: what a person looks at. The four below are one
		// check each, per block: what a person tunes with. The two newest
		// default off - a full-resolution encode is ~55 ms each, and the
		// overlay shows what they show.
		outputHeatmap: { value: true },
		outputPrintHeatmap: { value: true },
		outputBackgroundHeatmap: { value: true },
		outputToneHeatmap: { value: false },
		outputSpeckHeatmap: { value: false },
		// JPEG unless asked for PNG: a heat map is a picture for a person,
		// and PNG was ~150ms per image at working size (see encodeImage in
		// lib/compare.js). Also applies to msg.stages.
		heatmapFormat: { value: "jpg", modes: ["jpg", "png", "raw"] },
		heatmapQuality: { value: 85, int: [1, 100] },
		debugStages: { value: false },
		// A thumbnail under the node on the flow canvas, and the whole
		// pipeline behind it - every stage, both heat maps - kept for the
		// editor's stage viewer. Diagnostic: it renders every stage on every
		// frame, which is what "Output pipeline stages" costs.
		previewEnabled: { value: false },
		previewWidth: { value: 260, int: [80, 600] },
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
		accountShared(src.byteLength);
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

	/**
	 * The last inspection each node ran with the preview on, by node id:
	 * every rendered stage and both heat maps, plus the verdict and the
	 * numbers behind it, so the editor's stage viewer can open on it
	 * without the images ever having crossed the websocket. One entry per
	 * node, replaced per frame; a redeploy keeps it, a restart does not,
	 * and a deleted node's goes with it.
	 */
	const lastInspections = new Map();

	/**
	 * An inspection the stage viewer has paused on, by node id. The last
	 * entry is replaced by every frame, so a viewer that wants to look
	 * closer at one asks for it to be held; the routes then serve the
	 * held entry when asked for its time, and the latest otherwise. At
	 * most one held per node, released when the viewer resumes or closes.
	 */
	const heldInspections = new Map();

	/** The entry a route should serve: the held one when its time is
	 * asked for, else the latest. */
	function entryFor(id, t) {
		const held = heldInspections.get(id);
		if (held && t && String(held.receivedAt) === String(t)) return held;
		return lastInspections.get(id);
	}

	/**
	 * The pipeline, in the order it runs, as the stage viewer walks it.
	 * Keys are the msg.stages keys plus the two heat maps; a stage that
	 * was not rendered (a heat map with its output off, the nuisance
	 * baseline with no map loaded) is simply absent from a given entry.
	 */
	const STAGES = [
		{
			key: "goldenGray",
			group: "golden",
			title: "Golden, grey",
			description:
				"The reference artwork at working size, as the pipeline sees it. Everything on the golden side is prepared once and cached.",
		},
		{
			key: "goldenFg",
			group: "golden",
			title: "Golden ink",
			description:
				"White where the golden is darker than the threshold: what the reference says is ink. Threshold mode and ink margin shape this.",
		},
		{
			key: "goldenFgDilatedBackground",
			group: "golden",
			title: "Golden ink, grown by the background tolerance",
			description:
				"The golden's ink dilated by the background tolerance. Frame ink inside this is expected; frame ink outside it is a background blemish.",
		},
		{
			key: "nuisanceBaseline",
			group: "golden",
			title: "Nuisance baseline",
			description:
				"The trained nuisance map over the golden: each block as red as the background density it reached on known-good frames. Only blocks that exceed their own baseline by the novelty threshold fail.",
		},
		{
			key: "targetGray",
			group: "frame",
			title: "Frame, grey",
			description:
				"The whole frame at working size, before alignment. The golden is searched for inside this.",
		},
		{
			key: "targetFg",
			group: "frame",
			title: "Frame ink",
			description:
				"The frame thresholded on its own level, the same mode as the golden. The alignment search matches this against the golden's ink.",
		},
		{
			key: "targetGrayAligned",
			group: "aligned",
			title: "Frame, aligned",
			description:
				"The matched region of the frame warped onto the golden's canvas with the found scale, stretch, angle and offset. From here on every image is golden-sized and the two can be compared pixel for pixel.",
		},
		{
			key: "targetFgAligned",
			group: "aligned",
			title: "Frame ink, aligned",
			description:
				"The frame's ink after the same warp, and after local alignment if it is on.",
		},
		{
			key: "targetFgDilatedPrint",
			group: "aligned",
			title: "Frame ink, grown by the print tolerance",
			description:
				"The aligned frame ink dilated by the print tolerance. Golden ink inside this counts as present; golden ink outside it is a print defect.",
		},
		{
			key: "printDefect",
			group: "verdict",
			title: "Print defect",
			description:
				"Golden ink the frame does not have: dropouts, voids, faded or missing print. Pixels in the ambiguity band are withheld.",
		},
		{
			key: "backgroundDefect",
			group: "verdict",
			title: "Background defect",
			description:
				"Frame ink the golden does not have: marks, smudges, overprint, dust. Pixels in the ambiguity band are withheld.",
		},
		{
			key: "heatmap",
			group: "verdict",
			title: "Every check, one picture",
			description:
				"Each check's regions on the aligned frame, boxed in its own colour with the defect pixels filled inside: blue is extra ink (background), red is missing ink (print), amber is tone, green is specks. What failed, where, and which check said so.",
		},
		{
			key: "printHeatmap",
			group: "verdict",
			title: "Print heat map",
			description:
				"The print defect summarised per block over the aligned frame: a block is red once its defect density reaches the block threshold, and the channel fails when any block reaches the fail threshold or the defect ratio is exceeded.",
		},
		{
			key: "backgroundHeatmap",
			group: "verdict",
			title: "Background heat map",
			description:
				"The background defect per block, the same way. With a nuisance map loaded a block also fails when it exceeds its baseline by the novelty threshold.",
		},
		{
			key: "toneDeviation",
			group: "verdict",
			title: "Tone deviation",
			description:
				"How far each pixel's grey sits from what the artwork predicts for it - the golden's grey mapped between the paper and ink levels measured nearby - as a fraction of that span: white is ink where paper should be, or paper where ink should be. Blank within the ink-edge band and the canvas border, where blur, registration and the warp's fill put legitimate grey.",
		},
		{
			key: "toneHeatmap",
			group: "verdict",
			title: "Tone heat map",
			description:
				"Pixels past the tone threshold, per block, the same way as the other two: a smudge, a ghosted impression or faded print that the ink threshold never sees.",
		},
		{
			key: "speckHeatmap",
			group: "verdict",
			title: "Specks",
			description:
				"Every block holding a speck - a connected run of pixels past the speck threshold, at least the minimum area - redder with more speck in it. Dust and pinholes are a few pixels each and never make a block dense; the check counts them instead.",
		},
	];

	// The heat maps a result can carry: the message key, the setting that
	// asks for it, and where compareFrame puts it. One table for the flags,
	// the message and the stage viewer, so a new picture is one line.
	const HEATMAPS = [
		["heatmap", "outputHeatmap", (r) => r.heatmap],
		["printHeatmap", "outputPrintHeatmap", (r) => r.printBlemish.heatmap],
		["backgroundHeatmap", "outputBackgroundHeatmap", (r) => r.backgroundBlemish.heatmap],
		["toneHeatmap", "outputToneHeatmap", (r) => r.toneBlemish.heatmap],
		["speckHeatmap", "outputSpeckHeatmap", (r) => r.speckBlemish.heatmap],
	];

	/** A rendered image, whichever of the three formats it is in, as a
	 * sharp pipeline. */
	function imagePipeline(image) {
		const sharp = require("sharp");
		if (Buffer.isBuffer(image)) return sharp(image);
		return sharp(
			Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
			{
				raw: { width: image.width, height: image.height, channels: image.channels },
			},
		);
	}

	/** The bytes and content type to serve a stored stage as. Encoded
	 * stages go out as they are; a raw one is encoded now, once, on demand. */
	async function stageBytes(image) {
		if (Buffer.isBuffer(image)) {
			const png = image.length > 4 && image[0] === 0x89 && image[1] === 0x50;
			return { bytes: image, contentType: png ? "image/png" : "image/jpeg" };
		}
		return {
			bytes: await imagePipeline(image).png({ compressionLevel: 1 }).toBuffer(),
			contentType: "image/png",
		};
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
		// whether a thumbnail is on the canvas, so switching the preview off
		// clears it once rather than publishing a clear per frame forever
		node.previewShown = false;

		node.on("close", (removed, done) => {
			if (removed) {
				lastInspections.delete(node.id);
				heldInspections.delete(node.id);
			}
			done();
		});

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
				// The stage viewer needs every stage and every heat map whether
				// or not the message is to carry them: render them when the
				// preview is on, and put on the message only what was asked
				// for. debugStages goes into the golden cache key below, so it
				// must be settled here.
				const wantStages = cfg.debugStages;
				const wanted = Object.fromEntries(HEATMAPS.map(([key, flag]) => [key, cfg[flag]]));
				if (cfg.previewEnabled) {
					cfg.debugStages = true;
					for (const [, flag] of HEATMAPS) cfg[flag] = true;
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
				cfg.measureRegister = training;
				let trainedScore = null;
				let trainedSlack = null;
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
						// the register slack training measured, when this record
						// has one and the node is set to take it
						const slack = trained.record.registerSlackPx;
						if (cfg.toneMarginAuto && Number.isFinite(slack) && slack >= 0 && slack <= 50) {
							cfg.toneMargin = Math.round(slack);
							trainedSlack = cfg.toneMargin;
						}
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
						// how far off register the frame still sat after the local
						// alignment, and the slack the tone and speck checks take
						// from it on later frames (Register slack "from training")
						register: result.register,
						registerSlackPx: result.register ? result.register.slackPx : null,
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
							`alignScore=${record.alignScore.toFixed(4)}` +
							(record.register
								? ` register(p98=${record.register.p98Px.toFixed(1)}px max=${record.register.maxPx.toFixed(1)}px` +
									` beyond=${record.register.beyond}) -> tone slack ${record.registerSlackPx}px`
								: "") +
							` -> ${node.transformFilePath}`,
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
					// a training frame's register measurement, else absent
					...(result.register ? { register: result.register } : {}),
					printBlemish: {
						pass: result.printBlemish.pass,
						defectRatio: result.printBlemish.defectRatio,
						regions: result.printBlemish.regions,
						// the most ink any block lost, as a fraction of what the
						// golden has there - the printMissingFraction gate's number
						worstMissing: result.printBlemish.worstMissing,
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
					toneBlemish: {
						enabled: result.toneBlemish.enabled,
						pass: result.toneBlemish.pass,
						defectRatio: result.toneBlemish.defectRatio,
						regions: result.toneBlemish.regions,
						// the register slack the check ran with, and whether it
						// came from the trained transform or the node's number
						marginPx: cfg.toneMargin,
						marginTrained: trainedSlack != null,
						// the frame's paper and ink levels the check measured
						// against, whole-frame; absent when the check did not run
						...(result.toneBlemish.enabled
							? { paperLevel: result.toneBlemish.paperLevel, inkLevel: result.toneBlemish.inkLevel }
							: {}),
						...(result.toneBlemish.reason ? { reason: result.toneBlemish.reason } : {}),
					},
					speckBlemish: {
						enabled: result.speckBlemish.enabled,
						pass: result.speckBlemish.pass,
						count: result.speckBlemish.count,
						area: result.speckBlemish.area,
						largest: result.speckBlemish.largest,
						regions: result.speckBlemish.regions,
						...(result.speckBlemish.reason ? { reason: result.speckBlemish.reason } : {}),
					},
				};
				// A check that was asked for and could not run says so once per
				// golden, not per frame: the reason is the golden, not the part.
				if (result.toneBlemish.reason && node.toneWarnedFor !== goldenKey) {
					node.toneWarnedFor = goldenKey;
					node.warn(`golden-compare: tone and speck checks skipped - ${result.toneBlemish.reason}`);
				}
				const t = result.timings;
				const ms = (v) => Math.round(v || 0);
				msg.timings = {
					decodeMs: ms(t.decodeMs),
					alignMs: ms(t.alignMs),
					diffMs: ms(t.diffMs),
					heatmapMs: ms(t.heatmapMs),
					toneMs: ms(t.toneMs),
					speckMs: ms(t.speckMs),
					overlayMs: ms(t.overlayMs),
					stagesMs: ms(t.stagesMs),
					totalMs: Math.round(performance.now() - totalStart),
					// the align bucket's own split: it is the number that moves,
					// and its parts answer to different settings
					nativeAlignMs: ms(t.nativeAlignMs),
					seedMs: ms(t.seedMs),
					tableMs: ms(t.tableMs),
					searchMs: ms(t.searchMs),
					warpMs: ms(t.warpMs),
					localAlignMs: ms(t.localAlignMs),
					thresholdMs: ms(t.thresholdMs),
					nativeFallbackMs: ms(t.nativeFallbackMs),
				};
				for (const [key, , pick] of HEATMAPS) {
					setOrDelete(msg, key, wanted[key] ? pick(result) : null);
				}
				setOrDelete(msg, "stages", wantStages ? result.stages : null);

				send(msg);

				// Said before the pass/fail line, because it changes what that
				// line means: every number below it is a comparison against
				// something that is not this label.
				if (result.match.mismatchSuspected || result.match.labelMissing) {
					node.warn(`golden-compare: ${result.match.reason}`);
				}

				const failedParts = [];
				if (result.match.labelMissing) failedParts.push("coverage");
				if (!result.position.pass) failedParts.push("position");
				if (!result.printBlemish.pass) failedParts.push("print");
				if (!result.backgroundBlemish.pass) failedParts.push("background");
				if (!result.toneBlemish.pass) failedParts.push("tone");
				if (!result.speckBlemish.pass) failedParts.push("specks");
				const verdictText =
					(result.match.labelMissing
						? `label missing? · ${Math.round(result.match.coverage * 100)}% of ink`
						: result.match.mismatchSuspected
							? `different label? · align ${result.match.score.toFixed(3)}`
							: result.pass
								? `pass · align ${result.match.score.toFixed(3)}`
								: `fail (${failedParts.join("+")}) · align ${result.match.score.toFixed(3)}`) +
					` · ${fmtMs(performance.now() - totalStart)}`;
				node.status({
					fill: result.pass ? "green" : "red",
					shape: result.pass ? "dot" : "ring",
					text: verdictText,
				});

				if (cfg.previewEnabled) {
					// Keep the whole pipeline for the stage viewer, and put a
					// thumbnail under the node. A preview is a diagnostic,
					// never a reason to fail a frame that was inspected fine.
					try {
						await publishPreview(node, msg, result, cfg, verdictText);
					} catch (previewError) {
						node.warn(`golden-compare preview: ${previewError.message}`);
					}
				} else if (node.previewShown && RED.comms) {
					node.previewShown = false;
					RED.comms.publish("golden-compare-preview", { id: node.id, clear: true });
				}
				const pos = result.position;
				const posStr =
					(pos.dxMm == null
						? `dx=${pos.dxPx}px dy=${pos.dyPx}px`
						: `dx=${pos.dxMm.toFixed(2)}mm dy=${pos.dyMm.toFixed(2)}mm`) +
					` angle=${pos.angleDeg.toFixed(2)}deg scale=${pos.scale.toFixed(3)}` +
					` stretch=${pos.stretchPercent.toFixed(2)}%` +
					(result.transform.pinned ? " pinned" : "");
				const matchStr = `align(${result.match.grade} ${result.match.score.toFixed(4)} cov=${result.match.coverage.toFixed(2)}${
					result.match.labelMissing
						? " LABEL-MISSING?"
						: result.match.mismatchSuspected
							? " DIFFERENT-LABEL?"
							: ""
				}) `;
				// which way the frame was aligned, and the align time by stage,
				// so a slow frame says where it was slow without a debug node
				const route = result.transform.native
					? "native"
					: result.transform.seeded
						? "js+seed"
						: "js";
				const alignSplit = [
					["native", t.nativeAlignMs],
					["seed", t.seedMs],
					["table", t.tableMs],
					["search", t.searchMs],
					["warp", t.warpMs],
					["local", t.localAlignMs],
					["threshold", t.thresholdMs],
					["discarded", t.nativeFallbackMs],
				]
					.filter(([, v]) => v > 0)
					.map(([k, v]) => `${k} ${fmtMs(v)}`)
					.join(" ");
				const routeStr = result.transform.nativeFallback
					? `${route} after native fallback: ${result.transform.nativeFallback}`
					: route;
				node.log(
					`golden-compare: ${result.pass ? "PASS" : "FAIL"} [${failedParts.join("+") || "none"}] ` +
						matchStr +
						`position(${pos.pass ? "ok" : "FAIL"} ${posStr}) ` +
						`print(${result.printBlemish.pass ? "ok" : "FAIL"} ratio=${result.printBlemish.defectRatio.toFixed(5)} regions=${result.printBlemish.regions.length}) ` +
						`background(${result.backgroundBlemish.pass ? "ok" : "FAIL"} ratio=${result.backgroundBlemish.defectRatio.toFixed(5)} regions=${result.backgroundBlemish.regions.length}) | ` +
						`decode ${fmtMs(t.decodeMs)}, align ${fmtMs(t.alignMs)} [${alignSplit}], ` +
						`diff ${fmtMs(t.diffMs)}, heatmap ${fmtMs(t.heatmapMs)}, ` +
						`stages ${fmtMs(t.stagesMs)}, total ${fmtMs(msg.timings.totalMs)} | ${routeStr}`,
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

	/**
	 * Store this frame's stages for the viewer and draw the thumbnail. The
	 * thumbnail is the heat map of the channel that failed - or the print
	 * one, which is the aligned frame with no blocks on it, when nothing
	 * did - so the picture under the node says where, not just whether.
	 */
	async function publishPreview(node, msg, result, cfg, verdictText) {
		const images = {};
		for (const key of Object.keys(result.stages || {})) {
			if (result.stages[key]) images[key] = result.stages[key];
		}
		for (const [key, , pick] of HEATMAPS) {
			const image = pick(result);
			if (image) images[key] = image;
		}
		const entry = {
			receivedAt: Date.now(),
			filename: typeof msg.filename === "string" ? msg.filename : null,
			pass: result.pass,
			text: verdictText,
			result: msg.result,
			timings: msg.timings,
			width: result.width,
			height: result.height,
			images,
		};
		lastInspections.set(node.id, entry);
		if (!RED.comms || typeof RED.comms.publish !== "function") return;
		// the thumbnail: the one picture, which the preview always renders
		const source = images.heatmap || images.targetGrayAligned;
		if (!source) return;
		const thumb = await imagePipeline(source)
			.resize({ width: cfg.previewWidth, withoutEnlargement: true })
			.jpeg({ quality: 70 })
			.toBuffer();
		node.previewShown = true;
		RED.comms.publish("golden-compare-preview", {
			id: node.id,
			image: thumb.toString("base64"),
			mimeType: "jpeg",
			previewWidth: cfg.previewWidth,
			imageWidth: result.width,
			imageHeight: result.height,
			pass: result.pass,
			labelMissing: !!result.match.labelMissing,
			mismatchSuspected: !!result.match.mismatchSuspected,
			text: verdictText,
			receivedAt: entry.receivedAt,
			stages: STAGES.filter((s) => images[s.key]).map((s) => s.key),
		});
	}

	RED.nodes.registerType("golden-compare", GoldenCompareNode);

	// The stage viewer's two routes: what the last inspection was, and each
	// of its images by key. Images are served one at a time, as the viewer
	// steps to them, rather than as one JSON body: a full set is ten to
	// fifteen images at working size.
	RED.httpAdmin.get(
		"/golden-compare/last/:id",
		RED.auth.needsPermission("golden-compare.read"),
		(req, res) => {
			const entry = entryFor(req.params.id, req.query && req.query.t);
			if (!entry) {
				res.status(404).json({ ok: false, error: "no frame yet" });
				return;
			}
			const held = heldInspections.get(req.params.id);
			res.setHeader("Cache-Control", "no-store");
			res.json({
				ok: true,
				held: !!held && held === entry,
				receivedAt: entry.receivedAt,
				filename: entry.filename,
				pass: entry.pass,
				text: entry.text,
				result: entry.result,
				timings: entry.timings,
				width: entry.width,
				height: entry.height,
				stages: STAGES.filter((s) => entry.images[s.key]).map((s) => ({
					key: s.key,
					group: s.group,
					title: s.title,
					description: s.description,
				})),
			});
		},
	);

	RED.httpAdmin.get(
		"/golden-compare/last/:id/stage/:key",
		RED.auth.needsPermission("golden-compare.read"),
		async (req, res) => {
			const entry = entryFor(req.params.id, req.query && req.query.t);
			const image = entry && entry.images[req.params.key];
			if (!image) {
				res
					.status(404)
					.json({ ok: false, error: entry ? "no such stage" : "no frame yet" });
				return;
			}
			try {
				const { bytes, contentType } = await stageBytes(image);
				res.setHeader("Content-Type", contentType);
				// the next frame replaces it, so the browser must not keep this one
				res.setHeader("Cache-Control", "no-store");
				res.end(bytes);
			} catch (err) {
				res.status(500).json({ ok: false, error: err.message });
			}
		},
	);

	// Pause: hold the inspection the viewer is looking at so the next
	// frame does not replace it. The body names the frame by its time, so
	// a hold that arrives after the frame is already gone is refused
	// rather than silently pinning a different one.
	RED.httpAdmin.post(
		"/golden-compare/last/:id/hold",
		RED.auth.needsPermission("golden-compare.write"),
		(req, res) => {
			const entry = lastInspections.get(req.params.id);
			const t = req.body && req.body.receivedAt;
			if (!entry) {
				res.status(404).json({ ok: false, error: "no frame yet" });
				return;
			}
			if (t != null && String(entry.receivedAt) !== String(t)) {
				res.status(409).json({
					ok: false,
					error: "that frame has already been replaced",
					receivedAt: entry.receivedAt,
				});
				return;
			}
			heldInspections.set(req.params.id, entry);
			res.json({ ok: true, receivedAt: entry.receivedAt });
		},
	);

	RED.httpAdmin.delete(
		"/golden-compare/last/:id/hold",
		RED.auth.needsPermission("golden-compare.write"),
		(req, res) => {
			heldInspections.delete(req.params.id);
			res.json({ ok: true });
		},
	);
};
