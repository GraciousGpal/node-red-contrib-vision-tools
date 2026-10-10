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
 * modules' cached selection and load. */
function withEnv(vars, fn) {
	const previous = {};
	for (const k of Object.keys(vars)) {
		previous[k] = Object.hasOwn(process.env, k) ? process.env[k] : undefined;
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	engineModule._reset();
	own._reset();
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(previous)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		engineModule._reset();
		own._reset();
	}
}

const withMode = (value, fn) => withEnv({ VISION_TOOLS_ENGINE: value }, fn);

test("VISION_TOOLS_ENGINE=opencv-js pins the WASM engine", { skip: !cvjsInstalled }, () => {
	withMode("opencv-js", () => {
		const selected = engineModule.candidate();
		assert.strictEqual(selected.name, "opencv-js");
		assert.strictEqual(typeof selected.engine.imageAlign, "function");
		assert.strictEqual(typeof selected.engine.resize, "function");
	});
});

test("a pinned engine is never substituted when it cannot load", () => {
	// a benchmark that measured the wrong engine is worse than one that
	// refuses to run
	withEnv({ VISION_TOOLS_ENGINE: "own", OPENCV5_ADDON: "/nonexistent/opencv5.node" }, () => {
		const selected = engineModule.candidate();
		assert.strictEqual(selected.engine, null);
		assert.strictEqual(selected.name, null);
		assert.match(selected.error.message, /own: OPENCV5_ADDON is \/nonexistent\/opencv5\.node, which does not exist/);
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

test("resolve() agrees with candidate() and warmup() reports the name", { skip: !cvjsInstalled }, async () => {
	const previous = process.env.VISION_TOOLS_ENGINE;
	process.env.VISION_TOOLS_ENGINE = "opencv-js";
	engineModule._reset();
	try {
		const resolved = await engineModule.resolve();
		assert.strictEqual(resolved.name, "opencv-js");
		assert.strictEqual(engineModule.candidate().name, "opencv-js");
		assert.strictEqual(await engineModule.warmup(), "opencv-js");
	} finally {
		if (previous === undefined) delete process.env.VISION_TOOLS_ENGINE;
		else process.env.VISION_TOOLS_ENGINE = previous;
		engineModule._reset();
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

test("the engine is logged once per node type: info for opencv5, a warning for a fallback", { skip: !cvjsInstalled }, () => {
	const lines = [];
	const log = { info: (t) => lines.push(["info", t]), warn: (t) => lines.push(["warn", t]) };
	withEnv({ VISION_TOOLS_ENGINE: undefined, OPENCV5_ADDON: "/nonexistent/opencv5.node" }, () => {
		engineModule.logEngine(log, "label-crop");
		engineModule.logEngine(log, "label-crop");
	});
	assert.strictEqual(lines.length, 1);
	assert.strictEqual(lines[0][0], "warn");
	assert.match(lines[0][1], /opencv\.js, because opencv5 did not load \(own: /);
	lines.length = 0;
	withMode("opencv-js", () => engineModule.logEngine(log, "golden-compare"));
	assert.deepStrictEqual(lines, [["info", "golden-compare: OpenCV engine opencv.js (VISION_TOOLS_ENGINE=opencv-js)"]]);
	if (ownLoads) {
		lines.length = 0;
		withMode("auto", () => engineModule.logEngine(log, "golden-compare"));
		assert.deepStrictEqual(lines, [["info", "golden-compare: OpenCV engine opencv5"]]);
	}
	assert.strictEqual(engineModule.label("own"), "opencv5");
	assert.strictEqual(engineModule.label("opencv-js"), "opencv.js");
});
