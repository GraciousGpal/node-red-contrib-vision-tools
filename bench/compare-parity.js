/**
 * Is lib/compare.js output byte-identical between a git ref and the working tree?
 *
 * Extracts lib/ and prebuilds/ at <ref> into <out>/ref, runs the case matrix
 * against that tree and against the working copy, each in its own process
 * (node_modules from the repo), and diffs result JSON (timings stripped) plus
 * the sha256 of every buffer. Exit 0 when identical, 1 with the first 20
 * differing keys, 2 on a git archive failure, a child crash or timeout, kernels
 * that differ between sides, or a side that never took the OpenCV fast-align path.
 * --out must not sit inside another Node project: its node_modules would win.
 *
 * Usage:
 *   node bench/compare-parity.js [--ref HEAD] [--out <dir>] [--quick]
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "lib");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BAR_Y = [0.1, 0.155, 0.19, 0.26, 0.3, 0.375, 0.41, 0.47, 0.545, 0.6, 0.68, 0.74];

function labelSvg(width, height, { shiftX = 0, shiftY = 0, rotate = 0, missingBar = false, rects = [] } = {}) {
	const bars = [];
	for (let i = 0; i < BAR_Y.length; i++) {
		if (missingBar && i === 5) continue;
		const w = Math.round(width * (i % 3 === 0 ? 0.62 : i % 3 === 1 ? 0.44 : 0.31));
		bars.push(`<rect x="${Math.round(width * 0.14) + shiftX}" y="${Math.round(height * BAR_Y[i]) + shiftY}" width="${w}" height="${Math.round(height * 0.022)}" fill="#111"/>`);
	}
	const border = `<rect x="${8 + shiftX}" y="${8 + shiftY}" width="${width - 16}" height="${height - 16}" fill="none" stroke="#111" stroke-width="6"/>`;
	const ring = `<circle cx="${Math.round(width * 0.75) + shiftX}" cy="${Math.round(height * 0.86) + shiftY}" r="60" fill="none" stroke="#111" stroke-width="9"/>`;
	const extra = rects.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill || "#000"}"/>`).join("");
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>` +
			`<g transform="rotate(${rotate} ${width / 2} ${height / 2})">${border}${bars.join("")}${ring}</g>${extra}</svg>`,
	);
}

const BASE = {
	workingSize: 1024, threshold: 128, thresholdMode: "otsu", maxAspect: 0.06, aspectSteps: 7,
	sauvolaRadius: 24, sauvolaK: 0.2, scaleSearchMin: 0.6, scaleSearchMax: 2.5, scaleSearchSteps: 19,
	maxAngleDeg: 2, angleSteps: 5, positionToleranceAngleDeg: 1, printTolerance: 3, backgroundTolerance: 2,
	alignSearch: 16, positionToleranceXMm: 2, positionToleranceYMm: 2, positionToleranceXPx: 16,
	positionToleranceYPx: 16, inkMargin: 8, blockSize: 16, blockThreshold: 0.15, failThreshold: 0.3,
	failRatio: 0.002, mmPerPixelNative: null, localAlign: true, localAlignTile: 96, localAlignMax: 3,
	toneThreshold: 0.3, toneMargin: 3, speckThreshold: 0.3, speckMinArea: 2, speckMaxCount: 8, speckMaxArea: 48,
	debugStages: true, outputPrintHeatmap: true, outputBackgroundHeatmap: true, outputToneHeatmap: true,
	outputSpeckHeatmap: true, thumbnailWidth: 200, outputHeatmap: true,
};

const MODES = {
	js: {},
	nativeFast: { nativeFastAlign: true },
	nativeRejected: { nativeFastAlign: true, maxAngleDeg: 0 },
	seed: { nativeAlignSeed: true, pinnedScale: { mx: 1, my: 1 } },
	nativeFastPinned: { nativeFastAlign: true, pinnedScale: { mx: 1, my: 1 } },
	edge: { edgeMargin: 80 },
	serialDiff: { printTolerance: 2.5 },
	noStages: { debugStages: false },
	noThumb: { thumbnailWidth: 0 },
	frameStagesOff: { frameStages: false },
	noStagesNative: { debugStages: false, nativeFastAlign: true },
	noLocal: { localAlign: false },
	sauvola: { thresholdMode: "sauvola" },
	fixed: { thresholdMode: "fixed" },
	mm: { mmPerPixelNative: 0.1 },
	scaleDrift: { nativeFastAlign: true, pinnedScale: { mx: 1.1, my: 1.1 } },
};
const FORMATS = { raw: { heatmapFormat: "raw" }, png: {} };
const QUICK_PAIRS = new Set(["shift", "print", "trayRaw", "heavy"]);
const QUICK_CORE = new Set(["nativeFast", "nativeRejected", "seed"]);
const QUICK_EXTRA = new Set(["serialDiff", "scaleDrift", "edge", "noStages", "noThumb", "frameStagesOff"]);

function inQuick(pair, mode, workers, format) {
	if (!QUICK_PAIRS.has(pair)) return false;
	if (mode === "js") return !(workers === 1 && format === "png");
	if (workers !== 4 || format !== "raw") return false;
	return QUICK_CORE.has(mode) || (QUICK_EXTRA.has(mode) && (pair === "shift" || pair === "print"));
}

function pathOf(transform) {
	const t = transform || {};
	if (t.native) return "native";
	if (t.seeded) return "seeded";
	const why = t.nativeFallback;
	if (!why) return "js";
	if (/scale drift/.test(why)) return "fallback:scaleDrift";
	if (/angle/.test(why)) return "fallback:angle";
	if (/score/.test(why)) return "fallback:score";
	if (/no alignment/.test(why)) return "fallback:noAlign";
	return "fallback:other";
}

function pathCounts(cases) {
	const counts = {};
	for (const c of Object.values(cases)) {
		const p = pathOf(c.tree.transform);
		counts[p] = (counts[p] || 0) + 1;
	}
	return counts;
}

async function buildPairs(sharp) {
	const { labelOnTray } = require("../test/helpers/synthetic.js");
	const png = (svg) => sharp(svg).png().toBuffer();
	const W = 1200, H = 1600;
	const golden = await png(labelSvg(W, H));
	const trayG = labelOnTray(800, 600, { angleDeg: 0, channels: 3 });
	const trayF = labelOnTray(800, 600, { angleDeg: 1.2, channels: 3 });
	const specks = Array.from({ length: 12 }, (_, i) => ({ x: 200 + i * 60, y: 1500, w: 3, h: 3 }));
	return {
		clean: { golden, frame: await png(labelSvg(W, H)) },
		shift: { golden, frame: await png(labelSvg(W, H, { shiftX: 11, shiftY: -9, rotate: 0.6 })) },
		tone: { golden, frame: await png(labelSvg(W, H, { rects: [{ x: 650, y: 1250, w: 160, h: 120, fill: "#999" }, ...specks] })) },
		print: { golden, frame: await png(labelSvg(W, H, { missingBar: true, rects: [{ x: 650, y: 1250, w: 40, h: 30 }] })) },
		trayRaw: {
			golden: await sharp(trayG.data, { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer(),
			frame: trayF.data,
			targetRaw: { width: 800, height: 600, channels: 3 },
		},
		heavy: { golden, frame: await png(labelSvg(W, H, { shiftX: 4, rects: [{ x: 100, y: 300, w: 1000, h: 700 }] })) },
	};
}

function isBinary(v) {
	return ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer);
}

function digest(result) {
	let hashes = 0;
	const walk = (v) => {
		if (isBinary(v)) {
			const buf = ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.from(new Uint8Array(v));
			hashes++;
			return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length, type: v.constructor.name };
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const o = {};
			for (const k of Object.keys(v)) {
				if (k === "timings" || k === "timing") o[k] = v[k] && typeof v[k] === "object" ? `keys:${Object.keys(v[k]).join(",")}` : "<ms>";
				else if (/Ms$/.test(k)) o[k] = "<ms>";
				else o[k] = walk(v[k]);
			}
			return o;
		}
		if (typeof v === "number" && !Number.isFinite(v)) return `num:${v}`;
		if (v === undefined) return "<undefined>";
		return v;
	};
	return { tree: walk(result), hashes };
}

async function child(libDir, outFile, quick) {
	const sharp = require("sharp");
	const { prepareGolden, compareFrame } = require(path.join(libDir, "compare.js"));
	const kernels = require(path.join(libDir, "nativeKernels.js"));
	const pairs = await buildPairs(sharp);
	const cases = {};
	const run = async (key, p, cfg) => {
		const golden = await prepareGolden(p.golden, cfg);
		cases[key] = digest(await compareFrame(p.frame, golden, cfg));
	};
	for (const [pn, p] of Object.entries(pairs)) {
		for (const [mn, m] of Object.entries(MODES)) {
			for (const workers of [1, 4]) {
				for (const [fn, f] of Object.entries(FORMATS)) {
					if (pn === "heavy" && fn === "png") continue;
					if (quick && !inQuick(pn, mn, workers, fn)) continue;
					await run(`${pn}|${mn}|w${workers}|${fn}`, p, { ...BASE, ...m, ...f, workers, ...(p.targetRaw ? { targetRaw: p.targetRaw } : {}) });
				}
			}
		}
	}
	const fake = Object.create(require(path.join(libDir, "engine.js")).engine());
	fake.imageAlign = async () => {
		throw new Error("forced");
	};
	// the cvAlign module, whatever this ref calls its file: the one compare.js
	// loaded from libDir that exposes the engine seam
	const libReal = fs.realpathSync(libDir) + path.sep;
	const seam = Object.values(require.cache).find(
		(m) => m.filename.startsWith(libReal) && typeof m.exports._setEngine === "function",
	);
	if (!seam) throw new Error(`no module under ${libDir} exports _setEngine`);
	const cvAlign = seam.exports;
	cvAlign._setEngine(fake);
	for (const pn of quick ? ["shift"] : ["shift", "tone"]) {
		for (const workers of quick ? [4] : [1, 4]) {
			await run(`${pn}|noAlign|w${workers}|raw`, pairs[pn], { ...BASE, nativeFastAlign: true, heatmapFormat: "raw", workers });
		}
	}
	cvAlign._resetEngine();
	const st = kernels.status();
	fs.writeFileSync(outFile, JSON.stringify({ kernels: { mode: kernels.mode(), root: path.dirname(libDir), ...st }, cases }));
	require(path.join(libDir, "pool.js")).shutdown();
}

function extractRef(ref, dir) {
	fs.mkdirSync(dir, { recursive: true });
	const has = (p) => spawnSync("git", ["cat-file", "-e", `${ref}:${p}`], { cwd: REPO }).status === 0;
	const tar = spawnSync("git", ["--no-pager", "archive", "--format=tar", ref, "lib", ...(has("prebuilds") ? ["prebuilds"] : [])], { cwd: REPO, maxBuffer: 1 << 30 });
	if (tar.status !== 0) throw new Error(`git archive ${ref}: ${tar.stderr}`);
	const x = spawnSync("tar", ["-xf", "-"], { cwd: dir, input: tar.stdout, maxBuffer: 1 << 30 });
	if (x.status !== 0) throw new Error(`tar -x: ${x.stderr || x.error}`);
	return path.join(dir, "lib");
}

const kernelLine = (side, k) =>
	`kernels ${side}: VISION_TOOLS_KERNELS=${k.mode}, ran ${k.native ? `kernels addon ${path.join(k.root, k.file)}` : `JS kernels (${k.reason})`}`;

function diffTree(a, b, at, out) {
	if (out.length >= 20) return;
	if (JSON.stringify(a) === JSON.stringify(b)) return;
	if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b) && !("sha256" in a)) {
		const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
		const before = out.length;
		for (const k of keys) diffTree(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : `${at}.${k}`, out);
		if (out.length === before) out.push(`${at} (key order)`);
		return;
	}
	out.push(`${at}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
}

let outDir = null;
let tempDir = false;

function main() {
	const ref = arg("ref", "HEAD");
	const explicit = arg("out", null);
	outDir = explicit ? path.resolve(explicit) : fs.mkdtempSync(path.join(os.tmpdir(), "compare-parity-"));
	tempDir = !explicit;
	if (explicit) fs.rmSync(path.join(outDir, "ref"), { recursive: true, force: true });
	const quick = process.argv.includes("--quick");
	const timeout = (quick ? 5 : 20) * 60 * 1000;
	const refLib = extractRef(ref, path.join(outDir, "ref"));
	const modules = path.join(REPO, "node_modules");
	const env = { ...process.env, NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
	const started = Date.now();
	const results = {};
	for (const [side, libDir] of [["ref", refLib], ["work", LIB]]) {
		const outFile = path.join(outDir, `${side}.json`);
		fs.rmSync(outFile, { force: true });
		const r = spawnSync(process.execPath, [__filename, "--child", libDir, outFile, ...(quick ? ["--quick"] : [])], { stdio: "inherit", env, cwd: REPO, timeout });
		if (r.error && r.error.code === "ETIMEDOUT") {
			console.error(`${side} run timed out after ${timeout / 60000} min; killed`);
			process.exitCode = 2;
			return;
		}
		if (r.status !== 0) {
			console.error(`${side} run failed (exit ${r.status}${r.signal ? `, ${r.signal}` : ""})`);
			process.exitCode = 2;
			return;
		}
		results[side] = JSON.parse(fs.readFileSync(outFile, "utf8"));
	}
	const { ref: a, work: b } = results;
	console.log(kernelLine("ref ", a.kernels));
	console.log(kernelLine("work", b.kernels));
	if (a.kernels.native !== b.kernels.native) {
		console.error("KERNELS DIFFER: one side ran native, the other JS; the comparison would say nothing. Not comparing.");
		process.exitCode = 2;
		return;
	}
	const paths = { ref: pathCounts(a.cases), work: pathCounts(b.cases) };
	console.log(`paths ref : ${JSON.stringify(paths.ref)}`);
	console.log(`paths work: ${JSON.stringify(paths.work)}`);
	const wantsNative = Object.values(MODES).some((m) => m.nativeFastAlign || m.nativeAlignSeed);
	const hollow = Object.entries(paths).filter(([, c]) => wantsNative && !c.native).map(([side]) => side);
	if (hollow.length) {
		console.error(`NO NATIVE ALIGNMENT on ${hollow.join(" and ")}: no OpenCV engine took a case; the OpenCV fast-align paths were not compared.`);
		process.exitCode = 2;
		return;
	}
	const diffs = [];
	let hashes = 0;
	let differing = 0;
	for (const key of new Set([...Object.keys(a.cases), ...Object.keys(b.cases)])) {
		const x = a.cases[key], y = b.cases[key];
		if (!x || !y) {
			differing++;
			diffs.push(`${key}: only in ${x ? "ref" : "work"}`);
			continue;
		}
		hashes += x.hashes;
		if (JSON.stringify(x.tree) === JSON.stringify(y.tree)) continue;
		differing++;
		diffTree(x.tree, y.tree, key, diffs);
	}
	console.log(`ref ${ref} vs working tree, ${quick ? "quick" : "full"} matrix, ${((Date.now() - started) / 1000).toFixed(1)}s`);
	console.log(`cases ${Object.keys(a.cases).length}, buffer hashes compared ${hashes}`);
	if (diffs.length === 0) {
		console.log("identical");
		process.exitCode = 0;
		return;
	}
	console.log(`DIFFERENT: ${differing} of ${Object.keys(a.cases).length} cases; first ${Math.min(20, diffs.length)} keys:`);
	for (const d of diffs.slice(0, 20)) console.log(`  ${d}`);
	process.exitCode = 1;
}

if (process.argv[2] === "--child") {
	child(process.argv[3], process.argv[4], process.argv.includes("--quick")).then(
		() => process.exit(0),
		(err) => {
			console.error(err);
			process.exit(1);
		},
	);
} else {
	try {
		main();
	} catch (err) {
		console.error(err.message);
		process.exitCode = 2;
	}
	if (tempDir && process.exitCode === 0) fs.rmSync(outDir, { recursive: true, force: true });
	else if (outDir) console.log(`outputs kept in ${outDir}`);
}
