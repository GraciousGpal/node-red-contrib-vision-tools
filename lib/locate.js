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
 * label. Full-image scanning with it is already far more capable than the
 * JS port, but on a large photo (megapixels) it still costs on the order of
 * a second per scan (mostly the detector's own search over the full frame).
 * If the barcode locations are known in advance - a fixed camera rig with
 * labels landing in roughly the same place shot to shot, same assumption
 * golden-compare's "one-time/per-maintenance calibration" already makes for
 * this project - decoding small, pre-defined regions instead is much
 * faster: on the 4096x5500 test photo (6 regions, warmed up), the whole
 * regions pass measured ~190-235ms against ~1.4-1.8s for the same image
 * scanned whole - a ~7x wall-clock win, and the gap widens with fewer/
 * smaller regions since most of that 190-235ms is one fixed decode (next
 * paragraph), not per-region cost (each region's own search measured
 * 1-50ms).
 *
 * When regions are in play, the raw decode itself is restricted to the
 * union bounding box of all regions (via sharp's extract-on-load, driven
 * by a near-free sharp().metadata() header read to get image dimensions
 * first) rather than decoding the full frame - on the 4096x5500 test
 * photo this cut the dominant decode cost from ~180ms to ~139ms (a bbox of
 * 1666x3677 out of the full frame), and it means the full-resolution raw
 * buffer is never materialized at all on the common path where regions
 * succeed. The full-frame decode only happens lazily, inside
 * decodeFullImage, when the automatic fallback actually fires. Every
 * region crop (for both the search itself and the preview image attached
 * to each result) is sliced from that bbox-restricted raw buffer via
 * sharp's raw-input mode, and all regions are searched concurrently via
 * Promise.all (verified both faster - ~30ms vs ~35-65ms sequential for 6
 * regions - and correctness-identical to sequential, i.e. concurrent
 * zxing-wasm readBarcodes() calls don't corrupt each other's results, at
 * least as tested against this project's real sample photo).
 *
 * Three implementation traps worth knowing about if touching this file,
 * all found by benchmarking against this project's real 4096x5500 sample
 * photo rather than trusting any approach to "obviously" be fast:
 *  - A first version re-ran `sharp(pngBuffer).extract(box)` per region
 *    instead - a fresh full PNG decode every time. Across 6 regions that
 *    alone cost ~1.1s (region timings summed to ~125ms, the wrapping loop
 *    took ~1220ms) - decode-once-slice-many fixed it.
 *  - A second version sliced each region via one `sharp(raw.data,
 *    {raw:...}).extract(box)` pipeline, forked into two outputs (raw +
 *    PNG preview) with `.clone()` run concurrently through `Promise.all`.
 *    Measured 400-600ms *per region* against the 90MB raw buffer - worse
 *    than the original bug. Two independent, *sequential* pipelines (see
 *    sliceRawImage) measured 2-40ms for the same crops instead. The cause
 *    wasn't fully pinned down (suspected libvips contention over shared
 *    large raw input across concurrent clones) - if tempted to
 *    "simplify" this back to clone()+Promise.all, re-benchmark against a
 *    real multi-megapixel raw buffer first, not a small test image.
 *  - The region-level parallelism added later (Promise.all across
 *    *different* regions, each with its own independent sliceRawImage
 *    call) is a different thing from the clone()+Promise.all trap above -
 *    it's independent pipelines from the start, never sharing one via
 *    .clone(), and was benchmarked as a genuine win. Don't conflate the
 *    two when reasoning about future changes here.
 */

"use strict";

const sharp = require("sharp");
const { readBarcodes } = require("zxing-wasm/reader");

// Formats enabled by default. EAN8 is deliberately left out: it's short
// enough that ZXing's implementations (both the JS port and, in one test
// against this project's own sample label, zxing-wasm) have a real chance
// of matching noise in a region that has no barcode in it at all - a
// confident wrong answer, worse than "not found". Turn it on explicitly
// per-call if a real EAN-8 code is expected.
const DEFAULT_FORMATS = ["Code128", "DataMatrix", "QRCode", "EAN13", "Code39", "ITF", "PDF417"];

const WARMUP_WIDTH = 4500;
const WARMUP_HEIGHT = 6000;

// zxing-wasm's first-ever readBarcodes() call in this process pays a
// one-time cost (WASM instantiation, plus linear-memory growth to fit a
// large image) of roughly 1.5-2s that has nothing to do with the image
// content - verified by timing repeated calls, where call 1 was
// consistently ~1.8x slower than every call after it. A same-size blank
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
// point (for search input or preview output) slices whichever buffer this
// returns via sharp's raw-input mode, which is pure memory work - no
// re-parsing of the original PNG/JPEG per region.
async function decodeToRawImage(buffer, extractBox) {
	let pipeline = sharp(buffer).ensureAlpha();
	if (extractBox) pipeline = pipeline.extract(extractBox);
	const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
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

// Slices a box out of the raw image, returning both an ImageData-shaped
// object (fed straight to readBarcodes - no PNG encode/decode round trip
// needed just to search it) and a PNG buffer (for the result's preview
// crop). Two independent, *sequential* pipelines from raw.data, not one
// pipeline forked with .clone() and run concurrently via Promise.all -
// that combination measured 400-600ms per crop against this raw buffer
// (90MB, 4096x5500 RGBA) vs. 2-40ms doing the same two crops sequentially
// as separate pipelines. Cause not fully pinned down (likely libvips
// contention over the same large raw source when two pipelines derived
// from it via clone() process concurrently) - the fix is empirical, not
// fully understood, so don't "simplify" this back to clone()+Promise.all
// without re-benchmarking against a large raw buffer specifically.
async function sliceRawImage(raw, box) {
	const rawCrop = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
		.extract(box)
		.raw()
		.toBuffer({ resolveWithObject: true });
	const previewPng = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
		.extract(box)
		.png()
		.toBuffer();
	const imageData = {
		data: new Uint8ClampedArray(rawCrop.data.buffer, rawCrop.data.byteOffset, rawCrop.data.byteLength),
		width: rawCrop.info.width,
		height: rawCrop.info.height,
	};
	return { imageData, previewPng };
}

// `raw` may be decoded from an extract-on-load restricted to a bbox rather
// than the full frame (see locateBarcodes) - `origin` carries that bbox's
// offset plus the true full-image dimensions, so region boxes can be
// clamped/reported in real image coordinates (roi) while the actual slice
// happens in raw's own, possibly-offset, coordinate space (localBox).
async function decodeRegion(raw, origin, region, readerOptions) {
	const fullBox = clampBox(region, origin.imageWidth, origin.imageHeight);
	const localBox = { left: fullBox.left - origin.left, top: fullBox.top - origin.top, width: fullBox.width, height: fullBox.height };
	const { imageData, previewPng } = await sliceRawImage(raw, localBox);

	const start = Date.now();
	const found = await readBarcodes(imageData, readerOptions);
	const decodeMs = Date.now() - start;

	return found.map((r) => ({
		text: r.text,
		format: r.format,
		decodeMs,
		source: "region",
		regionLabel: region.label || null,
		roi: { x: fullBox.left, y: fullBox.top, width: fullBox.width, height: fullBox.height },
		previewBuffer: previewPng,
	}));
}

async function decodeFullImage(raw, readerOptions) {
	const imageData = { data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), width: raw.width, height: raw.height };

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
		const { previewPng } = await sliceRawImage(raw, box);
		results.push({
			text: r.text,
			format: r.format,
			decodeMs,
			source: "fullImage",
			regionLabel: null,
			roi: { x: box.left, y: box.top, width: box.width, height: box.height },
			previewBuffer: previewPng,
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
 * @returns {Promise<{results: object[], timings: object, usedFullImage: boolean, imageWidth: number, imageHeight: number}>}
 */
async function locateBarcodes(buffer, options = {}) {
	const mode = options.mode || "regionsThenAuto";
	const regions = Array.isArray(options.regions) ? options.regions : [];
	const readerOptions = options.readerOptions || { formats: DEFAULT_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 20 };

	await warmUp(readerOptions);

	// header-only read (~1-3ms, no pixel decode) - just enough to clamp
	// regions and compute their union bbox before touching pixel data
	const metadata = await sharp(buffer).metadata();
	const imageWidth = metadata.width;
	const imageHeight = metadata.height;

	const timings = {};
	let results = [];

	const tryRegions = mode !== "autoOnly" && regions.length > 0;
	if (tryRegions) {
		const start = Date.now();
		const clampedBoxes = regions.map((r) => clampBox(r, imageWidth, imageHeight));
		const bbox = unionBox(clampedBoxes);
		const bboxRaw = await decodeToRawImage(buffer, bbox);
		const origin = { left: bbox.left, top: bbox.top, imageWidth, imageHeight };
		const regionResults = await Promise.all(regions.map((region) => decodeRegion(bboxRaw, origin, region, readerOptions)));
		results = results.concat(...regionResults);
		timings.regionsMs = Date.now() - start;
	}

	const shouldFallback = mode === "autoOnly" || (mode === "regionsThenAuto" && results.length === 0);
	let usedFullImage = false;
	if (shouldFallback) {
		usedFullImage = true;
		const start = Date.now();
		const raw = await decodeToRawImage(buffer);
		results = results.concat(await decodeFullImage(raw, readerOptions));
		timings.fullImageMs = Date.now() - start;
	}

	return {
		results,
		timings,
		usedFullImage,
		imageWidth,
		imageHeight,
	};
}

module.exports = { locateBarcodes, DEFAULT_FORMATS };
