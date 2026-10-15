/**
 * Engine selection (lib/engine.js).
 *
 * The point of these is that the choice is predictable and that a caller
 * never silently gets an engine it did not ask for: pinning is honoured
 * even when the pinned engine cannot load, and "auto" only reaches for the
 * WASM build when our own addon is genuinely unavailable.
 */

const test = require("node:test");
const assert = require("node:assert");

const engineModule = require("../lib/engine.js");
const cvjs = require("../lib/cvjs.js");
const own = require("../lib/opencv5.js");

const cvjsInstalled = cvjs.available();
const ownLoads = own.available();

/** Run with these environment variables set, then restore them and the
 * modules' cached selection and load - after `fn` settles, if it is async. */
function withEnv(vars, fn) {
	const previous = {};
	for (const k of Object.keys(vars)) {
		previous[k] = Object.hasOwn(process.env, k) ? process.env[k] : undefined;
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	engineModule._reset();
	own._reset();
	const restore = () => {
		for (const [k, v] of Object.entries(previous)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		engineModule._reset();
		own._reset();
	};
	let result;
	try {
		result = fn();
	} catch (err) {
		restore();
		throw err;
	}
	if (result && typeof result.then === "function") return result.finally(restore);
	restore();
	return result;
}

const withMode = (value, fn) => withEnv({ VISION_TOOLS_ENGINE: value }, fn);

test("VISION_TOOLS_ENGINE=opencv-js pins the WASM engine, and resolve() and warmup() agree", { skip: !cvjsInstalled }, async () => {
	await withMode("opencv-js", async () => {
		assert.strictEqual(engineModule.candidate().name, "opencv-js");
		assert.strictEqual((await engineModule.resolve()).name, "opencv-js");
		assert.strictEqual(await engineModule.warmup(), "opencv-js");
	});
});

test("a pinned engine is never substituted when it cannot load", () => {
	// a benchmark that measured the wrong engine is worse than one that
	// refuses to run
	withEnv({ VISION_TOOLS_ENGINE: "own", OPENCV5_ADDON: "/nonexistent/opencv5.node" }, () => {
		const selected = engineModule.candidate();
		assert.strictEqual(selected.engine, null);
		assert.strictEqual(selected.name, null);
		assert.match(selected.error.message, /OPENCV5_ADDON .*does not exist/);
	});
});

test("auto picks our addon where it loads", { skip: !ownLoads }, () => {
	withMode("auto", () => {
		assert.strictEqual(engineModule.candidate().name, "own");
	});
});

test("auto falls back to the WASM engine where our addon does not load", { skip: !cvjsInstalled }, () => {
	withEnv({ VISION_TOOLS_ENGINE: undefined, OPENCV5_ADDON: "/nonexistent/opencv5.node" }, () => {
		assert.strictEqual(engineModule.candidate().name, "opencv-js");
	});
});

test("the retired value native is read as auto, so it keeps the fallback", () => {
	withMode("native", () => {
		assert.strictEqual(engineModule.mode(), "auto");
	});
	withMode("NATIVE", () => {
		assert.strictEqual(engineModule.mode(), "auto");
	});
});

test("an unrecognised VISION_TOOLS_ENGINE value falls back to auto", () => {
	withMode("nonsense", () => {
		assert.strictEqual(engineModule.mode(), "auto");
	});
});

test("the engine exposes every op both callers use", { skip: !cvjsInstalled }, () => {
	for (const name of ["opencv-js", ...(ownLoads ? ["own"] : [])]) {
		withMode(name, () => {
			const { engine } = engineModule.candidate();
			for (const op of ["colorConvert", "resize", "filter", "crop", "rotate", "imageAlign"]) {
				assert.strictEqual(typeof engine[op], "function", `${name} is missing ${op}`);
			}
		});
	}
});

test("label-crop reports the engine as available on this host", { skip: !cvjsInstalled && !ownLoads }, () => {
	// label-crop treats a missing engine as a setup error and refuses every
	// frame; with either engine installed, auto never reaches that state
	// (whatever VISION_TOOLS_ENGINE the suite itself runs under)
	withMode("auto", () => {
		const { available } = require("../lib/labelCrop.js");
		assert.strictEqual(available(), true);
	});
});

test("logEngine says once per node type which engine serves it, warning only on a fallback", { skip: !cvjsInstalled }, () => {
	const lines = [];
	const log = { info: (t) => lines.push(["info", t]), warn: (t) => lines.push(["warn", t]) };
	withEnv({ VISION_TOOLS_ENGINE: undefined, OPENCV5_ADDON: "/nonexistent/opencv5.node" }, () => {
		engineModule.logEngine(log, "label-crop");
		engineModule.logEngine(log, "label-crop");
	});
	assert.strictEqual(lines.length, 1);
	assert.strictEqual(lines[0][0], "warn");
	assert.match(lines[0][1], /^label-crop: .*opencv\.js, because opencv5 did not load/);
	lines.length = 0;
	withMode("opencv-js", () => engineModule.logEngine(log, "golden-compare"));
	assert.strictEqual(lines.length, 1);
	assert.strictEqual(lines[0][0], "info", "a pinned opencv.js is chosen, not a fallback");
	assert.match(lines[0][1], /^golden-compare: .*opencv\.js .*VISION_TOOLS_ENGINE=opencv-js/);
	if (ownLoads) {
		lines.length = 0;
		withMode("auto", () => engineModule.logEngine(log, "golden-compare"));
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0][0], "info");
		assert.match(lines[0][1], /^golden-compare: .*opencv5/);
	}
	assert.strictEqual(engineModule.label("own"), "opencv5");
	assert.strictEqual(engineModule.label("opencv-js"), "opencv.js");
});
