/**
 * OpenCV alignment experiments.
 *
 * "native" throughout this module (and in the nativeFastAlign /
 * nativeAlignSeed settings) means "solved by the OpenCV engine rather than
 * by the JS search". Which engine that is - the native addon or the
 * opencv.js WASM build - is lib/engine.js's decision; both implement
 * imageAlign against the same contract.
 *
 * Two paths share the same bridge call:
 *
 *  - seedTransform() preserves the conservative prototype: OpenCV only gives
 *    the JS pixel polish a starting point.
 *  - alignFrame() is the deliberately aggressive prototype: OpenCV solves the
 *    affine transform and returns the already-warped golden-sized grayscale
 *    frame, allowing compareFrame to skip both summed-area tables, every JS
 *    search/polish round, and the final JS global warp.
 *
 * Both paths are optional and return null on any native failure so the normal
 * JS implementation remains the fallback.
 */

"use strict";

const SEED_SCALE_MIN = 0.05;
const SEED_SCALE_MAX = 100;
const FAST_ALIGN_SCALE = 0.35;

let engine;
function loadEngine() {
	if (engine !== undefined) return engine;
	try {
		// Either OpenCV backend; lib/engine.js decides which, and both
		// implement imageAlign against the same contract.
		// eslint-disable-next-line global-require
		engine = require("./engine.js").engine();
		if (!engine || typeof engine.imageAlign !== "function") engine = null;
	} catch {
		engine = null;
	}
	return engine;
}

function available() {
	return loadEngine() !== null;
}

function _setEngine(fake) {
	engine = fake;
}

function _resetEngine() {
	engine = undefined;
}

function image(data, width, height, channels = 1) {
	return {
		data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
		width,
		height,
		channels,
		colorSpace: channels === 1 ? "GRAY" : channels === 4 ? "RGBA" : "RGB",
		dtype: "uint8",
	};
}

function rawResult(reply) {
	const out = reply && reply.image;
	if (!out || !out.data || !ArrayBuffer.isView(out.data)) return null;
	const bytes = out.width * out.height * out.channels;
	if (out.data.byteLength < bytes) return null;
	return {
		data: new Uint8Array(out.data.buffer, out.data.byteOffset, bytes),
		width: out.width,
		height: out.height,
		channels: out.channels,
		colorSpace: out.colorSpace,
	};
}

/** Decode through OpenCV so the fast path does not pay sharp's serial PNG inflate. */
async function decodeGray(input, raw) {
	const cv = loadEngine();
	if (cv === null || typeof cv.colorConvert !== "function") return null;
	const source = raw
		? image(input, raw.width, raw.height, raw.channels)
		: Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	try {
		const out = rawResult(await cv.colorConvert(source, "GRAY", "raw"));
		return out && out.channels === 1 ? out : null;
	} catch {
		return null;
	}
}

async function resizeGray(raw, width, height) {
	if (raw.width === width && raw.height === height) return raw.data;
	const cv = loadEngine();
	if (cv === null || typeof cv.resize !== "function") return null;
	try {
		const out = rawResult(
			await cv.resize(
				image(raw.data, raw.width, raw.height),
				"num",
				width,
				"num",
				height,
				"raw",
			),
		);
		return out && out.channels === 1 && out.width === width && out.height === height
			? out.data
			: null;
	} catch {
		return null;
	}
}

function decodeTransform(reply, gW, gH, tW, tH) {
	if (!reply || !reply.success || !reply.transformMatrix) return null;
	const m = reply.transformMatrix.matrix2x3;
	if (!Array.isArray(m) || m.length !== 6) return null;

	// imageAlign first normalises the target to the reference dimensions.
	// Its matrix maps reference coordinates into that normalised target, so
	// scale each matrix row back into the target working canvas before
	// decomposing it.
	const fx = tW / gW;
	const fy = tH / gH;
	const a = m[0] * fx;
	const b = m[1] * fx;
	const ox = m[2] * fx;
	const c = m[3] * fy;
	const d = m[4] * fy;
	const oy = m[5] * fy;
	const mx = Math.hypot(a, c);
	const my = Math.hypot(b, d);
	const theta = Math.atan2(c, a);

	if (![mx, my, theta, ox, oy].every(Number.isFinite)) return null;
	if (mx < SEED_SCALE_MIN || mx > SEED_SCALE_MAX) return null;
	if (my < SEED_SCALE_MIN || my > SEED_SCALE_MAX) return null;
	return { mx, my, theta, ox, oy };
}

/**
 * Keep the fast solve inside the geometry the inspection configuration says
 * is physically possible. OpenCV affine is intentionally freer than the JS
 * model; without this gate it can explain artwork differences as scale/shear.
 */
function validateAlignment(transform, pinnedScale, maxAngleDeg, scaleTolerance = 0.03) {
	if (!transform) return "OpenCV returned no transform";
	const angleDeg = Math.abs((transform.theta * 180) / Math.PI);
	if (Number.isFinite(maxAngleDeg) && angleDeg > maxAngleDeg + 1e-9) {
		return `OpenCV angle ${angleDeg.toFixed(2)}deg exceeds ${maxAngleDeg.toFixed(2)}deg`;
	}
	if (pinnedScale) {
		const dx = Math.abs(transform.mx / pinnedScale.mx - 1);
		const dy = Math.abs(transform.my / pinnedScale.my - 1);
		if (dx > scaleTolerance || dy > scaleTolerance) {
			return (
				`OpenCV scale drift ${(dx * 100).toFixed(2)}% x / ` +
				`${(dy * 100).toFixed(2)}% y exceeds ${(scaleTolerance * 100).toFixed(1)}%`
			);
		}
	}
	return null;
}

/**
 * Run OpenCV affine alignment and return both its transform and its full-size
 * aligned grayscale image. `scale` controls only the internal alignment copy;
 * the returned image is always gW x gH.
 */
async function alignFrame(
	goldenGray,
	gW,
	gH,
	targetGray,
	tW,
	tH,
	options = {},
) {
	const cv = loadEngine();
	if (cv === null) return null;
	const scale = Number.isFinite(options.scale)
		? Math.max(0.05, Math.min(1, options.scale))
		: FAST_ALIGN_SCALE;
	const iterations = Number.isFinite(options.iterations)
		? Math.max(1, Math.round(options.iterations))
		: 30;
	const epsilon = Number.isFinite(options.epsilon)
		? Math.max(1e-6, options.epsilon)
		: 1e-3;
	const eccRefine = options.eccRefine === "always" ? "always" : "auto";

	let reply;
	try {
		reply = await cv.imageAlign(
			image(goldenGray, gW, gH),
			image(targetGray, tW, tH),
			scale,
			iterations,
			epsilon,
			"raw",
			90,
			false,
			true,
			null,
			"affine",
			"features+ecc",
			eccRefine,
			"orb",
		);
	} catch {
		return null;
	}

	const transform = decodeTransform(reply, gW, gH, tW, tH);
	const out = reply && reply.image;
	if (!transform || !out || !out.data) return null;
	if (out.width !== gW || out.height !== gH || out.channels !== 1) return null;
	const data = out.data;
	if (!ArrayBuffer.isView(data) || data.byteLength < gW * gH) return null;
	const gray = new Uint8Array(data.buffer, data.byteOffset, gW * gH);
	return {
		transform,
		gray: blankOutsideSource(gray, gW, gH, transform, tW, tH),
		timing: reply.timing || null,
		scale,
	};
}

/**
 * OpenCV's warp fills everything that maps outside the frame with 0, and 0 is
 * the darkest possible ink. Where the golden's canvas reaches past the edge of
 * the photo - which it does on every frame whose label is not fully inside the
 * shot - that fill lands in the background check as a solid, full-density bar
 * of ink the part does not have, and fails it.
 *
 * lib/warp.js fills the same region with 255 for exactly this reason: blank
 * substrate reads as "no ink here", which the *print* check flags as missing
 * ink (true - the frame does not show it) instead of the background check
 * flagging it as extra ink (false - the frame shows nothing at all there).
 * The native path has no border-value parameter to pass, so restore the
 * convention here rather than let the two alignment paths disagree about what
 * an uncovered pixel means.
 */
function blankOutsideSource(gray, gW, gH, transform, tW, tH) {
	const { mx, my, theta, ox, oy } = transform;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	// target = (ox,oy) + R(theta) * diag(mx,my) * golden, the same mapping
	// warpGray samples under.
	const xFromGx = cos * mx;
	const yFromGx = sin * mx;
	const xFromGy = -sin * my;
	const yFromGy = cos * my;

	const out = new Uint8Array(gW * gH);
	for (let y = 0; y < gH; y++) {
		const baseX = ox + xFromGy * y;
		const baseY = oy + yFromGy * y;
		const row = y * gW;
		for (let x = 0; x < gW; x++) {
			const tx = baseX + xFromGx * x;
			const ty = baseY + yFromGx * x;
			out[row + x] =
				tx >= 0 && tx < tW && ty >= 0 && ty < tH ? gray[row + x] : 255;
		}
	}
	return out;
}

/** Conservative seed path retained for side-by-side benchmarking. */
async function seedTransform(goldenGray, gW, gH, targetGray, tW, tH) {
	const aligned = await alignFrame(goldenGray, gW, gH, targetGray, tW, tH, {
		scale: 1,
		iterations: 50,
		epsilon: 1e-4,
	});
	return aligned ? aligned.transform : null;
}

module.exports = {
	available,
	decodeGray,
	resizeGray,
	alignFrame,
	seedTransform,
	validateAlignment,
	SEED_SCALE_MIN,
	SEED_SCALE_MAX,
	FAST_ALIGN_SCALE,
	_setEngine,
	_resetEngine,
};
