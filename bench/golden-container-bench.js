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
 * Only --out/--stages are written; training and deployment are disabled.
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
	return {
		p50: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
		p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
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
	const pdfInput = flows.find(
		(n) => n.z === config.z && n.type === "file in" && /\.pdf$/i.test(n.filename),
	);
	assert(pdfCfg && pdfInput, "no PDF golden source in comparison tab");
	const pdf = makeNode(
		`${installed}/@graciousstar/node-red-contrib-pdf-to-image/pdf-to-image.js`,
		{
			...pdfCfg,
			outputMode: "message",
			splitPages: false,
		},
	);
	const rendered = await send(pdf, {
		payload: fs.readFileSync(pdfInput.filename),
	});
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
	const goldenKey = hash(golden.data);
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
	const inspect = inspector.inspect;
	inspector.inspect = async (args) => {
		const reply = await inspect(args);
		if (reply.result) stages = reply.result.timings;
		return reply;
	};
	const results = [];
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
			for (const fixture of fixturePaths) {
				const decoded = await bridge.colorConvert(
					fs.readFileSync(fixture.file),
					"RGB",
					"raw",
				);
				const frame = await half(decoded.image);
				const message = () => ({
					payload: frame,
					golden,
					trainTransform: false,
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
				for (let i = 0; i < iterations; i++) {
					const started = performance.now();
					output = await send(node, message());
					const elapsed = performance.now() - started;
					assert(Number.isFinite(output.result.transform.score));
					assert.equal(typeof output.payload, "boolean");
					samples.push({ file: fixture.file, elapsed, ...stages });
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
				cases.push({
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
				stages: Object.fromEntries(
					Object.keys(stages).map((k) => [k, stats(samples.map((s) => s[k]))]),
				),
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
