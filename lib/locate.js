/**
 * Barcode location + decode, kept independent of Node-RED (plain functions
 * over Buffers/plain objects) so it can be exercised from a standalone
 * script without booting the runtime - same convention as
 * node-red-contrib-golden-compare/lib.
 *
 * Uses zxing-wasm (the real zxing-cpp C++ engine as WebAssembly) rather than
 * @zxing/library (the pure-JS port node-red-contrib-image-tools' Barcode
 * Decoder uses) - genuine multi-symbol detection, rotation tolerance, and
 * native DataMatrix support, all needed to reliably read a real multi-code
 * label. A full-image scan of a multi-megapixel photo is still slow (the
 * detector searches the whole frame). If the barcode locations are known
 * in advance - a fixed camera rig with labels landing in roughly the same
 * place shot to shot, same assumption golden-compare's
 * "one-time/per-maintenance calibration" already makes for this project -
 * decoding small, pre-defined regions instead is much faster.
 *
 * When regions are in play, the raw decode itself is restricted to the
 * union bounding box of all regions (via sharp's extract-on-load, driven
 * by a near-free sharp().metadata() header read to get image dimensions
 * first) rather than decoding the full frame, so the full-resolution raw
 * buffer is never materialized at all on the common path where regions
 * succeed. The full-frame decode only happens lazily, inside
 * decodeFullImage, when the automatic fallback actually fires. Bare pixels
 * (`options.raw`) skip decoding altogether and are sliced as they are.
 * Every region crop is copied row by row out of that buffer in plain JS
 * (cropToImageData) and all regions are searched concurrently via
 * Promise.all: concurrent zxing-wasm readBarcodes() calls don't corrupt
 * each other's results (tested against a real sample photo). A region's
 * preview PNG is encoded only when the region read something.
 *
 * Traps:
 *  - Re-running `sharp(pngBuffer).extract(box)` per region is a fresh full
 *    decode every time. Decode once, slice many.
 *  - Slicing through sharp's raw-input mode is a pipeline over the whole
 *    source per crop, slower than the reads themselves. Hence the JS crop.
 *
 * Offline operation: zxing-wasm 3.1.3, left to itself, fetches its .wasm
 * from the jsdelivr CDN on the first decode of every process. A factory
 * rig usually has no internet, and there that first decode aborts with
 * "both async and sync fetching of the wasm failed" - every
 * barcode-locate after a Node-RED restart would fail. So at module load the binary shipped inside the package
 * (dist/reader/zxing_reader.wasm) is read and handed to
 * prepareZXingModule as wasmBinary; zxing then never touches the
 * network. The package root has to be found from the reader entry point
 * (dist/cjs/reader/index.js, three levels down): the package's exports
 * map refuses require.resolve("zxing-wasm/package.json") and the .wasm
 * subpaths under CommonJS. If the file cannot be read (a repackaged or
 * future layout), nothing is logged and the library default (the CDN)
 * stays in place.
 *
 * Every result carries `symbol`, the bbox of zxing's corner points in
 * full-image coordinates, next to `roi` (the region it was searched in;
 * for the full-image pass, that same bbox clamped). Results naming the
 * same text and format whose symbol boxes touch are one physical code
 * read twice through overlapping regions (padded regions around codes
 * that sit close together overlap, hand-drawn ones often do) - and only
 * the first is kept (see dedupResults for why "touch" and not IoU).
 *
 * `options.raw` ({ width, height, channels }) takes bare pixels with no
 * container: the geometry replaces the header read and every decode goes
 * through sharp's raw-input mode.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { readBarcodes, prepareZXingModule } = require("zxing-wasm/reader");

// The package's own .wasm, or null when it cannot be read (see the module
// docstring: offline operation). Silent on failure by design - the CDN
// default still works on a connected machine.
function localReaderWasm() {
	try {
		const root = path.resolve(path.dirname(require.resolve("zxing-wasm/reader")), "..", "..", "..");
		return fs.readFileSync(path.join(root, "dist", "reader", "zxing_reader.wasm"));
	} catch {
		return null;
	}
}

const readerWasm = localReaderWasm();
if (readerWasm) {
	// fireImmediately instantiates now, so the first readBarcodes never
	// reaches for the network. A rejection here also rejects that first
	// readBarcodes, which reports it; the catch only keeps it from being
	// an unhandled rejection at require time.
	prepareZXingModule({ overrides: { wasmBinary: readerWasm }, fireImmediately: true }).catch(() => {});
}

// Formats enabled by default. EAN8 is deliberately left out: it's short
// enough that ZXing (JS port and zxing-wasm alike) has a real chance
// of matching noise in a region that has no barcode in it at all - a
// confident wrong answer, worse than "not found". Turn it on explicitly
// per-call if a real EAN-8 code is expected.
const DEFAULT_FORMATS = ["Code128", "DataMatrix", "QRCode", "EAN13", "Code39", "ITF", "PDF417"];

const WARMUP_WIDTH = 4500;
const WARMUP_HEIGHT = 6000;

// zxing-wasm's first-ever readBarcodes() call in this process pays a
// one-time cost (WASM instantiation, plus linear-memory growth to fit a
// large image) that has nothing to do with the image content. A same-size blank
// canvas warms it up exactly as well as a real photo does. Module-level so
// it runs (and is paid for) only once per Node-RED process, however many
// barcode-locate node instances exist across however many flows.
let warmupPromise = null;
function warmUp(readerOptions) {
	if (!warmupPromise) {
		warmupPromise = (async () => {
			const blank = await sharp({
				create: {
					width: WARMUP_WIDTH,
					height: WARMUP_HEIGHT,
					channels: 3,
					background: { r: 255, g: 255, b: 255 },
				},
			})
				.png()
				.toBuffer();
			try {
				await readBarcodes(blank, readerOptions);
			} catch {
				// a blank canvas decodes to nothing - expected; only the warmup
				// side effect (WASM init + heap growth) matters here
			}
		})();
	}
	return warmupPromise;
}

// Decodes the source image to raw RGBA pixels. With no extractBox, decodes
// the full frame (used for the automatic fallback, and for full-frame-only
// mode). With extractBox, decodes only that region via sharp's
// extract-on-load - cheaper than decoding the full frame and slicing after,
// see the region-bbox note in the module docstring. Every crop after this
// point (search input and preview) is sliced out of whichever buffer this
// returns by cropToImageData - no re-parsing of the original file.
// `rawInput` ({width,height,channels}) when buffer is bare pixels: those
// are already decoded, so they are used as they are, whatever the channel
// count - cropToImageData slices any of them. Running them through sharp
// (ensureAlpha, extract) costs a pass over the whole frame, more than the
// region reads themselves.
async function decodeToRawImage(buffer, extractBox, rawInput) {
	if (rawInput) return { data: buffer, width: rawInput.width, height: rawInput.height, channels: rawInput.channels };
	let pipeline = sharp(buffer).ensureAlpha();
	if (extractBox) pipeline = pipeline.extract(extractBox);
	const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

// zxing's corner points -> integer {x,y,width,height}, offset into
// full-image coordinates (a region's points are relative to its crop).
function symbolBox(position, offsetX = 0, offsetY = 0) {
	const b = boundingBoxFromPosition(position);
	const x = Math.floor(b.minX);
	const y = Math.floor(b.minY);
	return {
		x: x + offsetX,
		y: y + offsetY,
		width: Math.ceil(b.maxX) - x,
		height: Math.ceil(b.maxY) - y,
	};
}

// Inclusive on purpose: a linear code read from a single scan line can
// have a position of zero height, and must still meet the box of the
// same code read elsewhere.
function boxesIntersect(a, b) {
	return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

// One physical symbol read more than once through overlapping regions
// collapses to its first read (applied to the whole results list, so the
// full-image pass is covered too). Regions are scanned in the order
// given, so the first region that saw it keeps its label. Intersection
// rather than IoU: zxing's position for a linear code covers only the
// rows that actually decoded, so the same Code128 seen through a tall
// region and through one that cuts it short gives boxes of very
// different heights, an IoU well under 0.5, and would be reported
// twice. Same text, same format and touching boxes can only be the same
// print - two physical copies of one code never overlap.
function dedupResults(results) {
	const kept = [];
	for (const r of results) {
		const dup = kept.some((k) => k.text === r.text && k.format === r.format && boxesIntersect(k.symbol, r.symbol));
		if (!dup) kept.push(r);
	}
	return kept;
}

function boundingBoxFromPosition(position) {
	const xs = [position.topLeft.x, position.topRight.x, position.bottomRight.x, position.bottomLeft.x];
	const ys = [position.topLeft.y, position.topRight.y, position.bottomRight.y, position.bottomLeft.y];
	return {
		minX: Math.min(...xs),
		maxX: Math.max(...xs),
		minY: Math.min(...ys),
		maxY: Math.max(...ys),
	};
}

// clamps a user-defined region to the image bounds - regions are measured
// by eye against a specific photo/rig and can drift slightly out of bounds
// (a region near an edge, or a photo that came in smaller than expected)
function clampBox(box, imageWidth, imageHeight) {
	const left = Math.max(0, Math.min(Math.round(box.x), imageWidth - 1));
	const top = Math.max(0, Math.min(Math.round(box.y), imageHeight - 1));
	const width = Math.max(1, Math.min(Math.round(box.width), imageWidth - left));
	const height = Math.max(1, Math.min(Math.round(box.height), imageHeight - top));
	return { left, top, width, height };
}

// union bounding box of a set of already-clamped boxes, in the same
// {left,top,width,height} shape - used to restrict the raw decode to just
// the area regions actually cover instead of the whole frame
function unionBox(boxes) {
	const left = Math.min(...boxes.map((b) => b.left));
	const top = Math.min(...boxes.map((b) => b.top));
	const right = Math.max(...boxes.map((b) => b.left + b.width));
	const bottom = Math.max(...boxes.map((b) => b.top + b.height));
	return { left, top, width: right - left, height: bottom - top };
}

// The pixels of `box` (in raw's own coordinates) as the ImageData
// readBarcodes takes: RGBA, copied row by row out of raw, whatever its
// channel count (1 grey, 2 grey+alpha, 3 RGB, 4 RGBA). Plain memory work -
// a sharp pipeline per crop is a pass over the whole source.
function cropToImageData(raw, box) {
	const { width, height } = box;
	const c = raw.channels;
	const src = raw.data;
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		let s = ((box.top + y) * raw.width + box.left) * c;
		let d = y * width * 4;
		if (c === 4) {
			out.set(src.subarray(s, s + width * 4), d);
			continue;
		}
		for (let x = 0; x < width; x++, s += c, d += 4) {
			if (c >= 3) {
				out[d] = src[s];
				out[d + 1] = src[s + 1];
				out[d + 2] = src[s + 2];
			} else {
				out[d] = out[d + 1] = out[d + 2] = src[s];
			}
			out[d + 3] = c === 2 ? src[s + 1] : 255;
		}
	}
	return { data: out, width, height };
}

// A result's preview crop, encoded only for crops that produced one, and
// at zlib level 1: the default level takes longer than the read itself,
// for somewhat smaller files.
function previewPng(imageData) {
	const { data, width, height } = imageData;
	return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
		.png({ compressionLevel: 1 })
		.toBuffer();
}

// `raw` may be decoded from an extract-on-load restricted to a bbox rather
// than the full frame (see locateBarcodes) - `origin` carries that bbox's
// offset plus the true full-image dimensions, so region boxes can be
// clamped/reported in real image coordinates (roi) while the actual slice
// happens in raw's own, possibly-offset, coordinate space (localBox).
async function decodeRegion(raw, origin, region, readerOptions) {
	const fullBox = clampBox(region, origin.imageWidth, origin.imageHeight);
	const localBox = { left: fullBox.left - origin.left, top: fullBox.top - origin.top, width: fullBox.width, height: fullBox.height };
	const imageData = cropToImageData(raw, localBox);
	// A region that names its format - a profile's boxes do, the golden's
	// own code was read there - is searched for that one first: each
	// format's detector is a pass of its own. One the node has not
	// enabled is searched with every enabled format. A narrowed region that reads nothing is
	// searched once more for every enabled format, so a wrong label printed
	// in another symbology is still reported; an empty region costs one pass.
	const own = region.format && (!readerOptions.formats || readerOptions.formats.includes(region.format));
	const options = own ? { ...readerOptions, formats: [region.format] } : readerOptions;

	const start = Date.now();
	let found = await readBarcodes(imageData, options);
	if (own && !found.length) found = await readBarcodes(imageData, readerOptions);
	const decodeMs = Date.now() - start;

	const preview = found.length ? await previewPng(imageData) : null;
	return found.map((r) => ({
		text: r.text,
		format: r.format,
		decodeMs,
		source: "region",
		regionLabel: region.label || null,
		roi: { x: fullBox.left, y: fullBox.top, width: fullBox.width, height: fullBox.height },
		symbol: symbolBox(r.position, fullBox.left, fullBox.top),
		previewBuffer: preview,
	}));
}

async function decodeFullImage(raw, readerOptions) {
	const imageData =
		raw.channels === 4
			? { data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), width: raw.width, height: raw.height }
			: cropToImageData(raw, { left: 0, top: 0, width: raw.width, height: raw.height });

	const start = Date.now();
	const found = await readBarcodes(imageData, readerOptions);
	const decodeMs = Date.now() - start;

	const results = [];
	for (const r of found) {
		const bbox = boundingBoxFromPosition(r.position);
		const box = clampBox(
			{ x: bbox.minX, y: bbox.minY, width: bbox.maxX - bbox.minX, height: bbox.maxY - bbox.minY },
			raw.width,
			raw.height,
		);
		const preview = await previewPng(cropToImageData(raw, box));
		results.push({
			text: r.text,
			format: r.format,
			decodeMs,
			source: "fullImage",
			regionLabel: null,
			roi: { x: box.left, y: box.top, width: box.width, height: box.height },
			symbol: symbolBox(r.position),
			previewBuffer: preview,
		});
	}
	return results;
}

/**
 * @param {Buffer} buffer - full image bytes
 * @param {object} options
 * @param {Array<{label?:string,x:number,y:number,width:number,height:number}>} [options.regions]
 * @param {"regionsThenAuto"|"regionsOnly"|"autoOnly"} [options.mode]
 * @param {object} [options.readerOptions] - passed straight through to zxing-wasm's readBarcodes
 * @param {{width:number,height:number,channels:number}} [options.raw] - buffer is bare pixels of this geometry
 * @returns {Promise<{results: object[], timings: object, usedFullImage: boolean, imageWidth: number, imageHeight: number}>}
 *   each result: { text, format, decodeMs, source: "region"|"fullImage", regionLabel, roi, symbol, previewBuffer },
 *   roi and symbol as { x, y, width, height } in full-image px
 */
async function locateBarcodes(buffer, options = {}) {
	const mode = options.mode || "regionsThenAuto";
	const regions = Array.isArray(options.regions) ? options.regions : [];
	const readerOptions = options.readerOptions || { formats: DEFAULT_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 20 };

	const rawInput = options.raw ? { width: options.raw.width, height: options.raw.height, channels: options.raw.channels } : undefined;

	await warmUp(readerOptions);

	// header-only read (no pixel decode) - just enough to clamp
	// regions and compute their union bbox before touching pixel data.
	// Bare pixels have no header; their geometry is the descriptor.
	let imageWidth;
	let imageHeight;
	if (rawInput) {
		imageWidth = rawInput.width;
		imageHeight = rawInput.height;
	} else {
		const metadata = await sharp(buffer).metadata();
		imageWidth = metadata.width;
		imageHeight = metadata.height;
	}

	const timings = {};
	let results = [];

	const tryRegions = mode !== "autoOnly" && regions.length > 0;
	if (tryRegions) {
		const start = Date.now();
		const clampedBoxes = regions.map((r) => clampBox(r, imageWidth, imageHeight));
		const bbox = unionBox(clampedBoxes);
		// bare pixels come back whole (nothing to decode), a file only as
		// the regions' union box
		const bboxRaw = await decodeToRawImage(buffer, bbox, rawInput);
		const origin = rawInput ? { left: 0, top: 0, imageWidth, imageHeight } : { left: bbox.left, top: bbox.top, imageWidth, imageHeight };
		const regionResults = await Promise.all(regions.map((region) => decodeRegion(bboxRaw, origin, region, readerOptions)));
		results = results.concat(...regionResults);
		timings.regionsMs = Date.now() - start;
	}

	const shouldFallback = mode === "autoOnly" || (mode === "regionsThenAuto" && results.length === 0);
	let usedFullImage = false;
	if (shouldFallback) {
		usedFullImage = true;
		const start = Date.now();
		const raw = await decodeToRawImage(buffer, undefined, rawInput);
		results = results.concat(await decodeFullImage(raw, readerOptions));
		timings.fullImageMs = Date.now() - start;
	}

	results = dedupResults(results);

	return {
		results,
		timings,
		usedFullImage,
		imageWidth,
		imageHeight,
	};
}

module.exports = { locateBarcodes, DEFAULT_FORMATS };
