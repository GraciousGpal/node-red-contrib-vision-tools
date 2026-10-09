/**
 * Replay NodeRed-Test's golden-compare input handler without deploying a flow.
 * Run inside that container with NODE_PATH=/usr/src/node-red/node_modules.
 * VISION_BENCH_ROOT selects installed code or an isolated source snapshot.
 *
 * node bench/golden-container-bench.js --workers 12,1,2,4,8,16 --iterations 3
 * node bench/golden-container-bench.js --workers 12,4 --limit 0 --iterations 1
 * VISION_TOOLS_ENGINE=opencv-js node bench/golden-container-bench.js --workers 4
 *
 * Settings come from /data/flows.json; --config overrides them for diagnosis.
 * --files selects comma-separated basenames; --expect-labels asserts all verdicts.
 * --stages DIR saves diagnostic PNGs (not representative performance timings).
 * Files, PDF rendering and upstream resizes are outside the comparison timer.
 * Only --out/--stages/--dump are written; training and deployment are disabled.
 * --iterations N makes N passes over the whole set (never one frame twice in a
 * row); --dump FILE writes every msg.result as JSON lines for parity checks;
 * --native off forces the JS search. BENCH_DATA_DIR and BENCH_SCALE_FILE point
 * the flow's /data/golden paths at a copy, so a run never writes the live data.
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i < 0 ? fallback : process.argv[i + 1];
}
const root = path.resolve(
	process.env.VISION_BENCH_ROOT || path.join(__dirname, ".."),
);
const installed = "/usr/src/node-red/node_modules";
const bridge = require(
	`${installed}/@rosepetal/node-red-contrib-image-tools/node-red-contrib-image-tools/lib/cpp-bridge.js`,
);
const inspector = require(path.join(root, "lib/inspector.js"));
const iterations = Number(arg("iterations", 3));
const limit = Number(arg("limit", 5)); // 0 = all, per class
const workers = String(arg("workers", "12,1,2,4,8,16")).split(",").map(Number);
const namedModes = String(arg("named", "0,1")).split(",").map(Number);
const selectedFiles = arg("files", "").split(",").filter(Boolean);
assert(Number.isInteger(iterations) && iterations > 0);
assert(Number.isInteger(limit) && limit >= 0);
assert(workers.every((n) => Number.isInteger(n) && n >= 1 && n <= 64));
assert(namedModes.every((n) => n === 0 || n === 1));

// Same small RED seam as test/fingerprint.test.js; the real handler and
// inspector worker do all config validation, caching and image processing.
function makeNode(file, cfg) {
	let Constructor;
	const RED = {
		log: { error: console.error },
		// [scratch] HEAD registers admin routes at load and publishes the
		// preview thumbnail over comms; stub both (publish is a no-op so the
		// thumbnail JPEG encode the live node does is still timed)
		httpAdmin: { get() {}, post() {}, delete() {} },
		auth: { needsPermission: () => (_req, _res, next) => next && next() },
		comms: { publish() {} },
		nodes: {
			createNode(node) {
				node.handlers = {};
				node.warnings = new Set();
				node.on = (event, fn) => {
					node.handlers[event] = fn;
				};
				node.warn = (text) => node.warnings.add(text);
				node.error = console.error;
				node.log = node.status = () => {};
			},
			registerType(_name, ctor) {
				Constructor = ctor;
			},
		},
	};
	require(file)(RED);
	return new Constructor(cfg);
}

function send(node, msg) {
	return new Promise((resolve, reject) => {
		let output;
		node.handlers.input(
			msg,
			(value) => {
				output = value;
			},
			(err) => {
				if (err) reject(err);
				else if (output) resolve(output);
				else reject(new Error("node completed without output"));
			},
		);
	});
}

function stats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const q = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
	return {
		n: sorted.length,
		p50: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
		p95: q(0.95),
		p99: q(0.99),
		max: sorted[sorted.length - 1],
	};
}
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");

async function main() {
	let flows;
	try {
		flows = JSON.parse(fs.readFileSync("/data/flows.json"));
	} catch (cause) {
		throw new Error("Cannot read the container's saved flow configuration", {
			cause,
		});
	}
	const config = flows.find((n) => n.type === "golden-compare");
	assert(config, "no golden-compare node in saved flows");
	if (arg("config", null)) {
		try {
			const overrides = JSON.parse(fs.readFileSync(arg("config", null)));
			assert(
				overrides && typeof overrides === "object" && !Array.isArray(overrides),
			);
			Object.assign(config, overrides);
		} catch (cause) {
			throw new Error("Cannot read benchmark config overrides", { cause });
		}
	}
	const stageDir = arg("stages", null);
	if (stageDir) config.debugStages = true;
	// Test a saved training resolution without rewriting its identity guards.
	config.workingSize = Number(arg("working", config.workingSize));
	assert(
		Number.isInteger(config.workingSize) &&
			config.workingSize >= 64 &&
			config.workingSize <= 4096,
	);
	const pdfCfg = flows.find(
		(n) => n.z === config.z && n.type === "pdf-to-image",
	);
	// [scratch] the saved flow's file-in reads msg.filename; the path lives on
	// the deploy inject's filename property
	let pdfPath = (flows.find(
		(n) => n.z === config.z && n.type === "file in" && /\.pdf$/i.test(n.filename),
	) || {}).filename;
	if (!pdfPath) {
		for (const n of flows.filter((n) => n.z === config.z && n.type === "inject")) {
			const p = (n.props || []).find((p) => p.p === "filename" && /\.pdf$/i.test(p.v || ""));
			if (p) pdfPath = p.v;
		}
	}
	assert(pdfCfg && pdfPath, "no PDF golden source in comparison tab");
	const pdf = makeNode(
		`${installed}/@graciousstar/node-red-contrib-pdf-to-image/pdf-to-image.js`,
		{
			...pdfCfg,
			outputMode: "message",
			splitPages: false,
		},
	);
	const rendered = await send(pdf, {
		payload: fs.readFileSync(pdfPath),
		filename: pdfPath,
	});
	// [scratch] the flow names the golden "pdf:<stem>:<dpi>:<w>x<h>" and its
	// profile by the stem (function "keep the golden for every frame")
	const stem = rendered.filename || path.parse(pdfPath).name;
	const dpi = rendered.dpi;
	assert(!Array.isArray(rendered.payload), "expected exactly one golden page");
	// Match the two deployed rp-resize nodes (0.5x), including OpenCV's filter.
	const half = async (image) =>
		(
			await bridge.resize(
				image,
				"num",
				Math.round(image.width / 2),
				"num",
				Math.round(image.height / 2),
				"raw",
			)
		).image;
	const golden = await half(rendered.payload);
	const goldenKey = `pdf:${stem}:${dpi}:${golden.width}x${golden.height}`;
	// [scratch] the flow's rectify node between "halve the frame" and compare
	const rectCfg = flows.find(
		(n) => n.z === config.z && n.type === "perspective-rectify",
	);
	const rectify = rectCfg
		? makeNode(path.join(root, "perspective-rectify.js"), {
				...rectCfg,
				scaleFilePath: process.env.BENCH_SCALE_FILE || rectCfg.scaleFilePath,
			})
		: null;
	// [scratch] point every file the node reads at a copy so nothing under
	// /data can be written (profile import / barcode derivation)
	if (process.env.BENCH_DATA_DIR) {
		const d = process.env.BENCH_DATA_DIR;
		const re = (p) => (p ? p.replace(/^\/data\/golden/, d) : p);
		config.profileDir = re(config.profileDir);
		config.transformFilePath = re(config.transformFilePath);
		config.nuisancePath = re(config.nuisancePath);
		config.scaleFilePath = re(config.scaleFilePath);
	}
	const fixturePaths = ["good", "bad"].flatMap((label) => {
		const dir = `/data/Inspection/sample_images/${label}`;
		const files = fs
			.readdirSync(dir)
			.filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
			.filter((f) => selectedFiles.length === 0 || selectedFiles.includes(f))
			.sort();
		return (limit ? files.slice(0, limit) : files).map((f) => ({
			label,
			file: path.join(dir, f),
		}));
	});
	assert(fixturePaths.length > 0, "no image fixtures");
	const meta = {
		root,
		engine: process.env.VISION_TOOLS_ENGINE || "auto",
		node: process.version,
		cores: os.availableParallelism(),
		iterations,
		limit,
		config,
		golden: {
			width: golden.width,
			height: golden.height,
			channels: golden.channels,
			sha256: goldenKey,
		},
		source: Object.fromEntries(
			["golden-compare.js", "lib/compare.js", "lib/nativeSeed.js"].map((f) => [
				f,
				hash(fs.readFileSync(path.join(root, f))),
			]),
		),
		fixtureCount: fixturePaths.length,
	};
	console.log(JSON.stringify(meta));
	let stages;
	let inspectCalls = 0;
	let inspectRoundTripMs = 0;
	let needGolden = 0;
	const inspect = inspector.inspect;
	inspector.inspect = async (args) => {
		inspectCalls++;
		const t = performance.now();
		const reply = await inspect(args);
		inspectRoundTripMs += performance.now() - t;
		if (reply.needGolden) needGolden++;
		if (reply.result) stages = reply.result.timings;
		return reply;
	};
	let prepareCalls = 0;
	const prepare = inspector.prepare;
	inspector.prepare = async (args) => {
		prepareCalls++;
		return prepare(args);
	};
	const results = [];
	// [med] parity dump: every msg.result and the heatmap bytes, per iteration
	const dumpPath = arg("dump", null);
	const dump = dumpPath ? fs.openSync(dumpPath, "w") : null;
	const imgHash = (im) =>
		im == null ? null : hash(Buffer.isBuffer(im) ? im : Buffer.from(im.data.buffer, im.data.byteOffset, im.data.byteLength)) + (im.width ? `:${im.width}x${im.height}x${im.channels}` : "");
	// Baseline first; every variant keeps the same image resolution and policy.
	for (const count of workers) {
		for (const named of namedModes) {
			const node = makeNode(path.join(root, "golden-compare.js"), {
				...config,
				workers: count,
				trainTransform: false,
				...(arg("native", "keep") === "off"
					? { nativeFastAlign: false, nativeAlignSeed: false }
					: {}),
			});
			const samples = [];
			const cases = [];
			let coldMs;
			// Each iteration is a pass over the whole set, never the same frame
			// twice in a row: the native addon caches its last frame, so a
			// back-to-back repeat aligns in ~4 ms instead of ~18 and flatters
			// every number that includes it.
			for (let pass = 0; pass < iterations; pass++)
			for (const fixture of fixturePaths) {
				const decoded = await bridge.colorConvert(
					fs.readFileSync(fixture.file),
					"RGB",
					"raw",
				);
				let frame = await half(decoded.image);
				let rectifyMs = null;
				let rectified = false;
				if (rectify) {
					const t = performance.now();
					const out = await send(rectify, { payload: frame });
					rectifyMs = performance.now() - t;
					rectified = !!(out.rectify && out.rectify.applied);
					frame = out.payload;
				}
				const message = () => ({
					payload: frame,
					frame: decoded.image,
					golden,
					filename: fixture.file,
					topic: fixture.label,
					profile: stem,
					...(named ? { goldenKey } : {}),
				});
				// Separate first-frame/JIT cost; never overlap frames.
				if (coldMs === undefined) {
					const t = performance.now();
					await send(node, message());
					coldMs = performance.now() - t;
					await send(node, message());
				}
				let output;
				for (let i = pass; i <= pass; i++) {
					const c0 = inspectCalls;
					const p0 = prepareCalls;
					const n0 = needGolden;
					inspectRoundTripMs = 0;
					const started = performance.now();
					output = await send(node, message());
					const elapsed = performance.now() - started;
					assert(Number.isFinite(output.result.transform.score));
					assert.equal(typeof output.payload, "boolean");
					const tr = output.result.transform;
					if (dump) {
						fs.writeSync(dump, JSON.stringify({
							w: count, named, file: path.basename(fixture.file), iter: i,
							result: output.result,
							heatmap: imgHash(output.heatmap),
							printHeatmap: imgHash(output.printHeatmap),
							backgroundHeatmap: imgHash(output.backgroundHeatmap),
							toneHeatmap: imgHash(output.toneHeatmap),
							speckHeatmap: imgHash(output.speckHeatmap),
							stages: output.stages ? Object.keys(output.stages).sort() : null,
						}) + String.fromCharCode(10));
					}
					samples.push({
						file: fixture.file,
						label: fixture.label,
						elapsed,
						...stages,
						msgTotalMs: output.timings.totalMs,
						inspectRoundTripMs,
						plumbingMs: elapsed - stages.totalMs,
						ipcMs: inspectRoundTripMs - stages.totalMs,
						rectifyMs,
						rectified,
						inspectCalls: inspectCalls - c0,
						prepareCalls: prepareCalls - p0,
						needGolden: needGolden - n0,
						route: tr.native ? "native" : tr.seeded ? "js+seed" : "js",
						pinned: tr.pinned,
						nativeFallback: tr.nativeFallback,
						profile: output.result.profile || null,
						pass: output.result.pass,
						grade: output.result.match.grade,
					});
				}
				if (stageDir) {
					const dir = path.join(
						stageDir,
						`${count}-${named}`,
						path.parse(fixture.file).name,
					);
					fs.mkdirSync(dir, { recursive: true });
					for (const [name, bytes] of Object.entries(output.stages || {})) {
						fs.writeFileSync(path.join(dir, `${name}.png`), bytes);
					}
				}
				const r = output.result;
				if (pass === 0) cases.push({
					...fixture,
					pass: r.pass,
					gradedPass: r.pass && r.match.grade === "good",
					result: r,
				});
			}
			const row = {
				workers: count,
				named: Boolean(named),
				coldMs,
				wallMs: stats(samples.map((s) => s.elapsed)),
				byLabel: Object.fromEntries(
					["good", "bad"].map((l) => {
						const ss = samples.filter((s) => s.label === l);
						return [
							l,
							ss.length
								? {
										wallMs: stats(ss.map((s) => s.elapsed)),
										inspTotalMs: stats(ss.map((s) => s.totalMs)),
										plumbingMs: stats(ss.map((s) => s.plumbingMs)),
									}
								: null,
						];
					}),
				),
				stages: Object.fromEntries(
					[
						...Object.keys(stages),
						"msgTotalMs",
						"inspectRoundTripMs",
						"plumbingMs",
						"ipcMs",
						"rectifyMs",
					].map((k) => [k, stats(samples.map((s) => s[k] ?? 0))]),
				),
				routes: samples.reduce((a, s) => {
					const k = `${s.route}${s.pinned ? "/pinned" : "/unpinned"}${s.nativeFallback ? "/fallback" : ""}`;
					a[k] = (a[k] || 0) + 1;
					return a;
				}, {}),
				rectified: samples.filter((s) => s.rectified).length,
				extraInspect: samples.filter((s) => s.inspectCalls !== 1).length,
				prepareOnTimed: samples.filter((s) => s.prepareCalls > 0).length,
				profileSeen: samples[0] && samples[0].profile,
				goodRejected: cases.filter((c) => c.label === "good" && !c.gradedPass)
					.length,
				badAccepted: cases.filter((c) => c.label === "bad" && c.gradedPass).length,
				nativeUsed: cases.filter((c) => c.result.transform.native).length,
				warnings: [...node.warnings],
				cases,
				samples,
			};
			results.push(row);
			console.log(
				JSON.stringify({
					...row,
					cases: undefined,
					samples: undefined,
					warnings: row.warnings.slice(0, 2),
				}),
			);
		}
	}
	if (dump) fs.closeSync(dump);
	const out = arg("out", "/tmp/golden-container-bench.json");
	fs.writeFileSync(out, JSON.stringify({ meta, results }, null, 2));
	console.log(`wrote ${out}`);
	if (process.argv.includes("--expect-labels")) {
		for (const row of results) {
			assert.equal(row.goodRejected, 0, "good images must pass");
			assert.equal(row.badAccepted, 0, "bad images must be rejected");
		}
	}
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => inspector.shutdown());
