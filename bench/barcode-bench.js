/**
 * Stopwatch for barcode-locate's decode path, frame to results.
 *
 * Outside `test/` and not named `*.test.js` on purpose: its numbers move
 * with the machine, so nothing asserts on them.
 *
 * Runs lib/locate.js the way the node runs it, strictly one frame at a
 * time, over one image or every image in a folder, and prints the median
 * and p95 of every stage in `timings` plus the wall time per frame, for:
 *
 *   file   the encoded file, as the node gets it from a camera or a file
 *   raw    the same frame as bare pixels, decoded once beforehand (what a
 *          `resize` at x1 with raw output upstream hands over)
 *   full   the full-image pass (mode autoOnly) on the file
 *
 * Regions come from --regions (a JSON array of {x,y,width,height[,format,
 * label]}) or, with --auto, from a full-image scan of the first frame:
 * each code's box padded as a profile region is (regionPad 0.2,
 * regionPadMinPx 64) and tagged with its format, which a profile region
 * carries. The one-time WASM warm-up is run and reported before timing.
 *
 * Usage:
 *   node bench/barcode-bench.js --image frame.jpg --auto               # one frame, --repeat 10 by default
 *   node bench/barcode-bench.js --dir frames/ --frames 20 --regions '[{"x":77,"y":1841,"width":522,"height":1317,"format":"Code128"}]'
 *   node bench/barcode-bench.js --image frame.jpg --auto --no-preview --formats Code128
 *   node bench/barcode-bench.js --image frame.jpg --auto --json out.json
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { locateBarcodes, warmUp, DEFAULT_FORMATS } = require("../lib/locate.js");

// an option's value is the next token unless that is another option
function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	const v = i >= 0 ? process.argv[i + 1] : undefined;
	return v !== undefined && !v.startsWith("--") ? v : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const IMAGE = arg("image", null);
const DIR = arg("dir", null);
const FRAMES = Number(arg("frames", 0));
// a single image is run this many times, so its median is a median
const REPEAT = Number(arg("repeat", IMAGE ? 10 : 1));
const JSON_OUT = arg("json", null);
const PREVIEW = !flag("no-preview");
const FORMATS = arg("formats", null)
	? arg("formats", "").split(",").map((f) => f.trim()).filter(Boolean)
	: DEFAULT_FORMATS;
const AUTO = flag("auto");
const REGIONS_ARG = arg("regions", null);
const REGION_PAD = 0.2;
const REGION_PAD_MIN_PX = 64;

if ((!IMAGE && !DIR) || (IMAGE && DIR) || (AUTO && REGIONS_ARG) || !(REPEAT >= 1)) {
	console.error("usage: node bench/barcode-bench.js (--image <file> | --dir <folder>) [--auto | --regions '<json>'] [--frames N] [--repeat N] [--formats A,B] [--no-preview] [--json out.json]");
	process.exit(2);
}

const readerOptions = { tryHarder: true, tryRotate: true, maxNumberOfSymbols: 20, formats: FORMATS };

function frameFiles() {
	if (IMAGE) return [path.resolve(IMAGE)];
	const all = fs
		.readdirSync(DIR)
		.filter((f) => /\.(jpe?g|png)$/i.test(f))
		.sort()
		.map((f) => path.join(DIR, f));
	return FRAMES > 0 ? all.slice(0, FRAMES) : all;
}

// a profile region around a found code: padded on every side by
// max(regionPad x longer edge, regionPadMinPx), as goldenRegions pads
function padded(result) {
	const b = result.symbol;
	const p = Math.max(REGION_PAD * Math.max(b.width, b.height), REGION_PAD_MIN_PX);
	return {
		label: result.text,
		format: result.format,
		x: Math.round(b.x - p),
		y: Math.round(b.y - p),
		width: Math.round(b.width + 2 * p),
		height: Math.round(b.height + 2 * p),
	};
}

// nearest-rank: the value at rank ceil(q x n), so p95 of 20 samples is
// the 19th, not the maximum
function quantile(values, q) {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const v = s[Math.max(0, Math.ceil(q * s.length) - 1)];
	return Math.round(v * 10) / 10;
}

// warmupMs is left out: the warm-up is run before timing, so it is 0 on every frame
const STAGES = ["wallMs", "headerMs", "decodeMs", "cropMs", "readMs", "previewMs", "regionsMs", "fullImageMs"];

async function main() {
	const files = frameFiles();
	if (!files.length) {
		console.error(`no .jpg/.png frames in ${DIR}`);
		process.exit(2);
	}
	const first = fs.readFileSync(files[0]);
	const meta = await sharp(first).metadata();

	let t = performance.now();
	await warmUp(readerOptions);
	const warmupMs = performance.now() - t;

	let regions = [];
	if (REGIONS_ARG) {
		regions = JSON.parse(REGIONS_ARG);
	} else if (AUTO) {
		const scan = await locateBarcodes(first, { mode: "autoOnly", readerOptions, preview: false });
		if (!scan.results.length) {
			console.error("--auto: the full-image scan of the first frame read no code, so there are no regions to time");
			process.exit(1);
		}
		regions = scan.results.map(padded);
	}

	const modes = [
		{ name: "file", run: (buf) => locateBarcodes(buf, { mode: "regionsOnly", regions, readerOptions, preview: PREVIEW }) },
		{
			name: "raw",
			run: async (buf) => {
				const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
				const started = performance.now();
				const r = await locateBarcodes(data, { mode: "regionsOnly", regions, readerOptions, preview: PREVIEW, raw: { width: info.width, height: info.height, channels: info.channels } });
				r.rawStartedAt = started;
				return r;
			},
		},
		{ name: "full", run: (buf) => locateBarcodes(buf, { mode: "autoOnly", readerOptions, preview: PREVIEW }) },
	].filter((m) => regions.length || m.name === "full");

	const samples = {};
	const codes = {};
	for (const m of modes) {
		samples[m.name] = {};
		codes[m.name] = [];
	}
	for (const file of files) {
		const buf = fs.readFileSync(file);
		for (let rep = 0; rep < REPEAT; rep++) for (const m of modes) {
			const started = performance.now();
			const r = await m.run(buf);
			const wallMs = performance.now() - (r.rawStartedAt || started);
			const got = samples[m.name];
			(got.wallMs = got.wallMs || []).push(wallMs);
			for (const [k, v] of Object.entries(r.timings)) (got[k] = got[k] || []).push(v);
			codes[m.name].push(r.results.length);
		}
	}

	const report = {
		frames: files.length,
		repeat: REPEAT,
		size: `${meta.width}x${meta.height} ${meta.format}`,
		formats: FORMATS,
		preview: PREVIEW,
		regions,
		warmupMs: Math.round(warmupMs),
		modes: {},
	};
	console.log(`${files.length} frame${files.length === 1 ? "" : "s"}${REPEAT > 1 ? ` x ${REPEAT}` : ""}, ${report.size}; formats ${FORMATS.join(",")}; preview ${PREVIEW ? "on" : "off"}; warm-up ${report.warmupMs} ms`);
	console.log(`regions: ${regions.length ? regions.map((r) => `${r.format || "any"} ${r.width}x${r.height}`).join(", ") : "none (full image only)"}`);
	const head = ["mode", "codes", ...STAGES];
	const rows = [];
	for (const m of modes) {
		const got = samples[m.name];
		const row = { mode: m.name, codes: `${quantile(codes[m.name], 0.5)}` };
		report.modes[m.name] = { codesMedian: quantile(codes[m.name], 0.5) };
		for (const k of STAGES) {
			const v = got[k] || [];
			const p50 = quantile(v, 0.5);
			const p95 = quantile(v, 0.95);
			row[k] = p50 === null ? "-" : v.length > 1 ? `${p50.toFixed(1)}/${p95.toFixed(1)}` : p50.toFixed(1);
			if (p50 !== null) report.modes[m.name][k] = { p50, p95, n: v.length };
		}
		rows.push(row);
	}
	const widths = head.map((h) => Math.max(h.length, ...rows.map((r) => String(r[h]).length)));
	const line = (r) => head.map((h, i) => String(r[h]).padStart(widths[i])).join("  ");
	console.log(line(Object.fromEntries(head.map((h) => [h, h]))));
	for (const r of rows) console.log(line(r));
	console.log("ms, median/p95 per frame; wallMs is the call itself, the stages are its timings (previewMs is the wait after the reads; raw's wall excludes the upstream decode)");
	if (JSON_OUT) {
		fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
		console.log(`wrote ${JSON_OUT}`);
	}
}

main().catch((err) => {
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
});
