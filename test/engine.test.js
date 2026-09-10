/**
 * Engine selection (lib/engine.js).
 *
 * The point of these is that the choice is predictable and that a caller
 * never silently gets an engine it did not ask for: pinning is honoured
 * even when the pinned engine cannot load, and "auto" only reaches for the
 * WASM build when the native one is genuinely unavailable.
 */

const test = require("node:test");
const assert = require("node:assert");

const engineModule = require("../lib/engine.js");
const cvjs = require("../lib/cvjs.js");

const cvjsInstalled = cvjs.available();
const nativePlatform = engineModule.NATIVE_PLATFORMS.has(
	`${process.platform}-${process.arch}`,
);

/** Run with VISION_TOOLS_ENGINE set, then restore both the variable and
 * the module's cached selection. */
function withMode(value, fn) {
	const had = Object.hasOwn(process.env, "VISION_TOOLS_ENGINE");
	const previous = process.env.VISION_TOOLS_ENGINE;
	if (value === undefined) delete process.env.VISION_TOOLS_ENGINE;
	else process.env.VISION_TOOLS_ENGINE = value;
	engineModule._reset();
	try {
		return fn();
	} finally {
		if (had) process.env.VISION_TOOLS_ENGINE = previous;
		else delete process.env.VISION_TOOLS_ENGINE;
		engineModule._reset();
	}
}

test("VISION_TOOLS_ENGINE=opencv-js pins the WASM engine", { skip: !cvjsInstalled }, () => {
	withMode("opencv-js", () => {
		const selected = engineModule.candidate();
		assert.strictEqual(selected.name, "opencv-js");
		assert.strictEqual(typeof selected.engine.imageAlign, "function");
		assert.strictEqual(typeof selected.engine.resize, "function");
	});
});

test("a pinned engine is never substituted when it cannot load", () => {
	// Pinning native on a platform with no prebuilt binary must fail, not
	// quietly hand back the WASM engine - a benchmark that measured the
	// wrong engine is worse than one that refuses to run.
	if (nativePlatform) return; // the native engine may genuinely load here
	withMode("native", () => {
		const selected = engineModule.candidate();
		assert.strictEqual(selected.engine, null);
		assert.strictEqual(selected.name, null);
		assert.match(selected.error.message, /no prebuilt native addon/);
	});
});

test("an unrecognised VISION_TOOLS_ENGINE value falls back to auto", { skip: !cvjsInstalled }, () => {
	withMode("nonsense", () => {
		assert.ok(["native", "opencv-js"].includes(engineModule.candidate().name));
	});
});

test("auto picks the WASM engine where no native addon is prebuilt", { skip: !cvjsInstalled }, () => {
	if (nativePlatform) return;
	withMode("auto", () => {
		assert.strictEqual(engineModule.candidate().name, "opencv-js");
	});
});

test("the engine exposes every op both callers use", { skip: !cvjsInstalled }, () => {
	withMode("opencv-js", () => {
		const { engine } = engineModule.candidate();
		for (const op of ["colorConvert", "resize", "filter", "crop", "rotate", "imageAlign"]) {
			assert.strictEqual(typeof engine[op], "function", `missing ${op}`);
		}
	});
});

test("resolve() agrees with candidate() and warmup() reports the name", { skip: !cvjsInstalled }, async () => {
	const had = Object.hasOwn(process.env, "VISION_TOOLS_ENGINE");
	const previous = process.env.VISION_TOOLS_ENGINE;
	process.env.VISION_TOOLS_ENGINE = "opencv-js";
	engineModule._reset();
	try {
		const resolved = await engineModule.resolve();
		assert.strictEqual(resolved.name, "opencv-js");
		assert.strictEqual(engineModule.candidate().name, "opencv-js");
		assert.strictEqual(await engineModule.warmup(), "opencv-js");
	} finally {
		if (had) process.env.VISION_TOOLS_ENGINE = previous;
		else delete process.env.VISION_TOOLS_ENGINE;
		engineModule._reset();
	}
});

test("label-crop reports the engine as available on this host", { skip: !cvjsInstalled }, () => {
	// label-crop treats a missing engine as a setup error and refuses every
	// frame; with the WASM build installed that state is unreachable.
	// eslint-disable-next-line global-require
	const { available } = require("../lib/labelCrop.js");
	assert.strictEqual(available(), true);
});
