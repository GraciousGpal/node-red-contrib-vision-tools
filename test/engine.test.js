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
		assert.match(selected.error.message, /own: no opencv5 binary/);
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

test("the retired value native is read as own", () => {
	withMode("native", () => {
		assert.strictEqual(engineModule.mode(), "own");
	});
	withMode("NATIVE", () => {
		assert.strictEqual(engineModule.mode(), "own");
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
	// frame; with either engine installed that state is unreachable.
	const { available } = require("../lib/labelCrop.js");
	assert.strictEqual(available(), true);
});
