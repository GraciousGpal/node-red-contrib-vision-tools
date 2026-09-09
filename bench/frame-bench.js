/**
 * Frame benchmark for golden-compare.
 *
 * Deliberately outside `test/` and not named `*.test.js`, so `node --test`
 * never picks it up: this is a stopwatch, not an assertion, and its
 * numbers move with the machine.
 *
 * Two properties matter and are easy to get wrong:
 *
 *  - **Frames run strictly sequentially.** After the polish moved onto the
 *    worker pool, `searchMs`/`alignMs`/`totalMs` measure wall clock rather
 *    than CPU, so two overlapping frames each report roughly the whole
 *    window and the numbers become meaningless. Measured during review:
 *    two concurrent frames reported 881ms and 931ms against 1454ms of real
 *    time.
 *  - **`searchMs` is reported apart from `alignMs`.** `alignMs` has always
 *    spanned several awaits (warp, local refinement, threshold); only the
 *    transform search was ever one contiguous block, and it is the block
 *    this work is trying to break up.
 *
 * Usage:
 *   node bench/frame-bench.js                 # default sweep, prints a table
 *   node bench/frame-bench.js --json out.json # also write machine-readable
 *   node bench/frame-bench.js --frames 5 --working 2048
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { prepareGolden, compareFrame } = require("../lib/compare.js");
const { shutdown } = require("../lib/pool.js");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FRAMES = Number(arg("frames", 3));
const WORKING = Number(arg("working", 2048));
const JSON_OUT = arg("json", null);
// 0 is "auto" and resolves to min(16, cores-1), which is a different number on
// every host - so the sweep names explicit counts as well, and the acceptance
// gate is stated against one of those rather than against 0.
const WORKER_SWEEP = String(arg("workers", "0,1,2,4,8"))
	.split(",")
	.map(Number);
const PIN = (() => {
	const raw = arg("pin", null);
	if (!raw) return null;
	const [mx, my] = raw.split(",").map(Number);
	if (!Number.isFinite(mx) || !Number.isFinite(my)) {
		throw new Error(`--pin wants "mx,my", got "${raw}"`);
	}
	return { mx, my };
})();

// A label-ish fixture: irregularly spaced bars (evenly spaced ones make a
// vertical stretch genuinely ambiguous, since the stretched pattern aligns
// against its neighbour) plus one solid blob.
function labelSvg(w, h) {
	const bars = [];
	for (let i = 0; i < 40; i++) {
		bars.push(
			`<rect x="${60 + ((i * 37) % 400)}" y="${40 + i * 60}" ` +
				`width="${300 + ((i * 53) % 500)}" height="26" fill="#111"/>`,
		);
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
			`<rect width="100%" height="100%" fill="#fff"/>` +
			bars.join("") +
			`<circle cx="${(w * 0.7) | 0}" cy="${(h * 0.85) | 0}" r="${(h * 0.06) | 0}" fill="#111"/>` +
			`</svg>`,
	);
}

function baseCfg(workers) {
	return {
		workingSize: WORKING,
		threshold: 128,
		thresholdMode: "otsu",
		sauvolaRadius: 24,
		sauvolaK: 0.2,
		inkMargin: 8,
		scaleSearchMin: 0.6,
		scaleSearchMax: 2.5,
		scaleSearchSteps: 19,
		alignCandidates: 5,
		workers,
		mismatchScore: 0.15,
		localAlign: true,
		localAlignTile: 96,
		localAlignMax: 3,
		maxAspect: 0.06,
		aspectSteps: 7,
		maxAngleDeg: 2,
		angleSteps: 5,
		positionToleranceAngleDeg: 1,
		printTolerance: 2,
		backgroundTolerance: 1,
		alignSearch: 16,
		positionToleranceXMm: 2,
		positionToleranceYMm: 2,
		positionToleranceXPx: 16,
		positionToleranceYPx: 16,
		blockSize: 16,
		blockThreshold: 0.15,
		failThreshold: 0.3,
		failRatio: 0.002,
		outputPrintHeatmap: false,
		outputBackgroundHeatmap: false,
		debugStages: false,
		mmPerPixelNative: null,
		calibrationNativeWidth: null,
		calibrationNativeHeight: null,
	};
}

/**
 * Sample the event loop every 5ms and record the gaps. A stage that runs
 * synchronously shows up as one gap the length of the stage - which is the
 * number this work exists to reduce, and the one a per-stage stopwatch
 * cannot see.
 *
 * The subtlety: a gap is only *recorded* when the callback next runs, so a
 * frame that is entirely synchronous after its decode (workers: 1) starves
 * the interval and never lets it report. Traced: the ticks stop at t=308ms,
 * the search runs to t=2400ms, and the probe read 16ms. Yielding first does
 * not help - `setImmediate` is a check-phase callback and does not force the
 * starved timers phase to run.
 *
 * So `worst` also counts the gap that is still *open* at read time
 * (`now - last`). That needs no cooperation from the timer at all.
 */
function lagProbe() {
	let last = performance.now();
	let worst = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		const gap = now - last;
		last = now;
		if (gap > worst) worst = gap;
	}, 5);
	timer.unref();
	return {
		reset() {
			last = performance.now();
			worst = 0;
		},
		stop() {
			clearInterval(timer);
			return worst;
		},
		get worst() {
			// include the gap still open right now - see the header
			return Math.max(worst, performance.now() - last);
		},
	};
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function run() {
	const goldenBuf = await sharp(labelSvg(1844, 2656)).png().toBuffer();
	// Anisotropic on purpose: 2400/1844 = 1.3016 across, 3400/2656 = 1.2801
	// down, a ~1.7% stretch. An isotropic resize leaves nothing for the
	// stretch search to find and scores ~0.002, which is too easy a fixture
	// to detect an alignment regression against.
	const frameBuf = await sharp(labelSvg(1844, 2656))
		.resize(2400, 3400, { fit: "fill" })
		.png()
		.toBuffer();

	const results = [];
	for (const workers of WORKER_SWEEP) {
		const cfg = baseCfg(workers);
		const golden = await prepareGolden(goldenBuf, cfg);

		for (const pinned of [false, true]) {
			// The pinned magnification is whatever an unpinned run recovers, so
			// the two rows describe the same alignment problem with and without
			// the search for scale.
			//
			// --pin overrides that, and is what any *comparison between two
			// versions* has to use: letting each version pin to its own
			// recovered scale means the pinned rows are not solving the same
			// problem, and a score difference then says nothing.
			let pin = null;
			if (pinned) {
				if (PIN) {
					pin = PIN;
				} else {
					const probe = await compareFrame(frameBuf, golden, { ...cfg });
					pin = { mx: probe.transform.scaleX, my: probe.transform.scaleY };
				}
			}
			const runCfg = { ...cfg, pinnedScale: pin };

			// warm: first frame pays worker spawn and JIT
			await compareFrame(frameBuf, golden, { ...runCfg });

			const probe = lagProbe();
			const search = [];
			const align = [];
			const total = [];
			const blocks = [];
			let score = null;
			for (let i = 0; i < FRAMES; i++) {
				probe.reset();
				const t = performance.now();
				// strictly sequential - see the header
				const r = await compareFrame(frameBuf, golden, { ...runCfg });
				total.push(performance.now() - t);
				blocks.push(probe.worst);
				search.push(r.timings.searchMs != null ? r.timings.searchMs : NaN);
				align.push(r.timings.alignMs);
				score = r.transform.score;
			}
			probe.stop();

			results.push({
				workers,
				pinned,
				searchMs: Math.round(median(search)),
				alignMs: Math.round(median(align)),
				totalMs: Math.round(median(total)),
				worstBlockMs: Math.round(median(blocks)),
				score,
			});
		}
	}

	const meta = {
		pin: PIN,
		cores: os.cpus().length,
		node: process.version,
		workingSize: WORKING,
		frames: FRAMES,
	};
	console.log(
		`host: ${meta.cores} cores, node ${meta.node}, workingSize ${WORKING}, ` +
			`median of ${FRAMES}\n`,
	);
	console.log(
		"workers  pinned   searchMs   alignMs   totalMs   worstBlock   score",
	);
	for (const r of results) {
		console.log(
			`${String(r.workers).padStart(7)}  ${String(r.pinned).padStart(6)}  ` +
				`${String(r.searchMs).padStart(9)} ${String(r.alignMs).padStart(9)} ` +
				`${String(r.totalMs).padStart(9)} ${String(r.worstBlockMs).padStart(12)}   ` +
				`${r.score.toFixed(6)}`,
		);
	}
	if (JSON_OUT) {
		fs.writeFileSync(JSON_OUT, JSON.stringify({ meta, results }, null, 2));
		console.log(`\nwrote ${JSON_OUT}`);
	}
	shutdown();
}

run().catch((err) => {
	console.error(err);
	shutdown();
	process.exitCode = 1;
});
