/**
 * The camera model: turn a golden-space raster into something that looks
 * like a photograph of the printed label on the rig.
 *
 * golden-compare's whole difficulty is that the golden is artwork and the
 * frame is a photograph, and nothing about the two shares a coordinate
 * system or a grey level (see the header of lib/compare.js). A benchmark
 * that fed the node a clean crop of its own golden would measure nothing
 * the node actually has to do. So every frame here goes through:
 *
 *   levels        ink is grey 30-80, paper 200-240 - never 0 and 255
 *   magnification independent mx / my in [1, 2] with up to +-6% stretch
 *                 between the axes, because a press stretches print along
 *                 its media-feed axis relative to the artwork
 *   rotation      up to +-1.5 degrees
 *   framing       placed on a larger grey tray with a paper margin around
 *                 it, off-centre - the node has to find it, not assume it
 *   illumination  a linear gradient across the frame plus a mild vignette
 *   optics        gaussian blur 0.4-1.5 px
 *   sensor        gaussian noise sigma 2-8
 *   codec         optional JPEG 70-95
 *
 * Every value is drawn from the preset's range through the caller's prng
 * and returned in `params`, so the manifest records the exact frame the
 * detector was asked to solve - including the noise, which is generated
 * from the same stream and so reproduces byte for byte.
 *
 * Deliberately not modelled: perspective (the rig is square to the part -
 * perspective-rectify is a different node's problem), lens distortion,
 * motion blur, colour, and specular hotspots. Each would be a real effect;
 * none of them is what the golden-compare pipeline is being scored on
 * here, and every extra unmodelled axis makes a failure harder to
 * attribute.
 */

"use strict";

const sharp = require("sharp");

/**
 * Three points on the capture-quality axis, so a sweep can separate "the
 * detector cannot find this defect" from "the detector cannot see through
 * this photograph". Ranges, not values - `capture` samples within them.
 */
const capturePresets = {
	"clean-rig": {
		mag: [1.0, 1.2],
		stretch: [-0.01, 0.01],
		angleDeg: [-0.3, 0.3],
		ink: [45, 70],
		paper: [225, 240],
		tray: [110, 140],
		margin: [0.07, 0.12],
		offsetPx: [0, 4],
		gradient: [0.0, 0.05],
		vignette: [0.0, 0.05],
		blurSigma: [0.4, 0.7],
		noiseSigma: [2, 3],
		jpegQuality: null,
	},
	typical: {
		mag: [1.05, 1.6],
		stretch: [-0.03, 0.03],
		angleDeg: [-0.8, 0.8],
		ink: [35, 75],
		paper: [210, 235],
		tray: [95, 150],
		margin: [0.06, 0.16],
		offsetPx: [0, 8],
		gradient: [0.03, 0.1],
		vignette: [0.03, 0.12],
		blurSigma: [0.6, 1.0],
		noiseSigma: [3, 5],
		jpegQuality: [85, 95],
	},
	harsh: {
		mag: [1.2, 2.0],
		stretch: [-0.06, 0.06],
		// inside the node's default 1 degree position tolerance, like the
		// offset: a label rotated past it is a position fail by design and
		// the blemish channels would never be scored
		angleDeg: [-0.9, 0.9],
		ink: [30, 80],
		paper: [200, 225],
		tray: [90, 160],
		margin: [0.05, 0.18],
		offsetPx: [0, 12],
		gradient: [0.1, 0.15],
		vignette: [0.1, 0.2],
		blurSigma: [1.0, 1.5],
		noiseSigma: [5, 8],
		jpegQuality: [70, 80],
	},
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Rounded for the manifest. The `=== 0` branch is there for -0: JSON
// writes it as 0, so without it the manifest returned from generate()
// stops deep-equalling the manifest it just wrote to disk.
function round(v, places) {
	const f = 10 ** places;
	const r = Math.round(v * f) / f;
	return r === 0 ? 0 : r;
}

/**
 * Take a single-channel raw buffer out of a sharp pipeline.
 *
 * Several operations here quietly promote a 1-channel raw image to sRGB:
 * `affine` because its background is given as a colour, `composite`
 * because it returns RGBA, and `blur` on its own. Every stage below works
 * a byte per pixel, so a promoted buffer is read at a third of the stride
 * and the label arrives as a diagonal moire over flat grey rather than as
 * anything that looks wrong in the code. Hence the explicit collapse and
 * the byte-count check on the way out.
 */
async function grayRaw(pipeline, width, height) {
	const data = await pipeline
		.removeAlpha()
		.toColourspace("b-w")
		.raw()
		.toBuffer();
	if (data.length !== width * height) {
		throw new Error(
			`expected ${width * height} grey bytes, got ${data.length}`,
		);
	}
	return data;
}

function resolvePreset(preset) {
	if (typeof preset === "string") {
		const p = capturePresets[preset];
		if (!p) {
			throw new Error(
				`unknown capture preset "${preset}" - have ${Object.keys(capturePresets).join(", ")}`,
			);
		}
		return p;
	}
	return preset;
}

/**
 * @param {{data:Uint8Array,width:number,height:number}} golden 0 = ink
 * @param {string|object} preset a name from capturePresets, or ranges
 * @param {object} prng from prng.js
 * @returns {Promise<{buffer:Buffer, format:"png"|"jpg", params:object}>}
 */
async function capture(golden, preset, prng) {
	const p = resolvePreset(preset);
	const mx = prng.uniform(p.mag[0], p.mag[1]);
	const stretch = prng.uniform(p.stretch[0], p.stretch[1]);
	const my = clamp(mx * (1 + stretch), 1, 2);
	const angleDeg = prng.uniform(p.angleDeg[0], p.angleDeg[1]);
	const ink = Math.round(prng.uniform(p.ink[0], p.ink[1]));
	const paper = Math.round(prng.uniform(p.paper[0], p.paper[1]));
	const trayGrey = Math.round(prng.uniform(p.tray[0], p.tray[1]));
	const margin = prng.uniform(p.margin[0], p.margin[1]);
	const gradient = prng.uniform(p.gradient[0], p.gradient[1]);
	const vignette = prng.uniform(p.vignette[0], p.vignette[1]);
	const blurSigma = prng.uniform(p.blurSigma[0], p.blurSigma[1]);
	const noiseSigma = prng.uniform(p.noiseSigma[0], p.noiseSigma[1]);
	const jpegQuality = p.jpegQuality
		? Math.round(prng.uniform(p.jpegQuality[0], p.jpegQuality[1]))
		: null;

	// Artwork levels -> print levels, linearly. Pure black never photographs
	// as 0 and paper never as 255, and both blemish checks binarize, so a
	// frame that kept the artwork's levels would hand the thresholder a much
	// easier problem than the rig does.
	const span = paper - ink;
	const printed = Buffer.allocUnsafe(golden.data.length);
	for (let i = 0; i < printed.length; i++) {
		printed[i] = ink + Math.round((golden.data[i] * span) / 255);
	}

	// Scale and rotate in one resample. Doing it as resize-then-rotate would
	// interpolate twice and quietly soften the fine strokes this fixture
	// exists to exercise.
	const theta = (angleDeg * Math.PI) / 180;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const placed = await sharp(printed, {
		raw: { width: golden.width, height: golden.height, channels: 1 },
	})
		.affine(
			[
				[cos * mx, -sin * my],
				[sin * mx, cos * my],
			],
			{
				background: { r: trayGrey, g: trayGrey, b: trayGrey },
				interpolator: "bicubic",
			},
		)
		.removeAlpha()
		.toColourspace("b-w")
		.raw()
		.toBuffer({ resolveWithObject: true });
	if (placed.info.channels !== 1) {
		throw new Error(`affine produced ${placed.info.channels} channels`);
	}

	const frameWidth = Math.round(placed.info.width * (1 + 2 * margin));
	const frameHeight = Math.round(placed.info.height * (1 + 2 * margin));
	const slackX = frameWidth - placed.info.width;
	const slackY = frameHeight - placed.info.height;
	// Off-centre by a few pixels, never by much. The node's position check
	// measures the deviation from "centred in whatever margin the frame has"
	// against a 16px default tolerance, so a label placed anywhere in the
	// margin fails every frame on position and the blemish channels are
	// never scored. The offset stays inside that tolerance at every
	// magnification; placement itself is a different benchmark.
	const offX = prng.sign() * prng.uniform(p.offsetPx[0], p.offsetPx[1]);
	const offY = prng.sign() * prng.uniform(p.offsetPx[0], p.offsetPx[1]);
	const dx = Math.round(clamp(slackX / 2 + offX, 0, slackX));
	const dy = Math.round(clamp(slackY / 2 + offY, 0, slackY));

	const tray = Buffer.alloc(frameWidth * frameHeight, trayGrey);
	let frame = await grayRaw(
		sharp(tray, {
			raw: { width: frameWidth, height: frameHeight, channels: 1 },
		}).composite([
			{
				input: placed.data,
				raw: {
					width: placed.info.width,
					height: placed.info.height,
					channels: 1,
				},
				left: dx,
				top: dy,
			},
		]),
		frameWidth,
		frameHeight,
	);

	// Illumination: a plane tilted in a random direction plus a radial
	// falloff. Applied before the blur, because the lighting is in front of
	// the lens and the noise is behind it.
	const gAngle = prng.uniform(0, Math.PI * 2);
	const gx = Math.cos(gAngle);
	const gy = Math.sin(gAngle);
	const halfDiag2 = 0.25 * (1 + (frameHeight / frameWidth) ** 2);
	for (let y = 0; y < frameHeight; y++) {
		const ny = y / frameHeight - 0.5;
		for (let x = 0; x < frameWidth; x++) {
			const nx = x / frameWidth - 0.5;
			const gain =
				(1 + gradient * 2 * (nx * gx + ny * gy)) *
				(1 - vignette * ((nx * nx + ny * ny) / halfDiag2));
			const i = y * frameWidth + x;
			frame[i] = clamp(Math.round(frame[i] * gain), 0, 255);
		}
	}

	frame = await grayRaw(
		sharp(frame, {
			raw: { width: frameWidth, height: frameHeight, channels: 1 },
		}).blur(blurSigma),
		frameWidth,
		frameHeight,
	);

	for (let i = 0; i < frame.length; i++) {
		frame[i] = clamp(Math.round(frame[i] + prng.gaussian(0, noiseSigma)), 0, 255);
	}

	const img = sharp(frame, {
		raw: { width: frameWidth, height: frameHeight, channels: 1 },
	});
	const buffer =
		jpegQuality == null
			? await img.png({ compressionLevel: 6 }).toBuffer()
			: await img.jpeg({ quality: jpegQuality }).toBuffer();

	return {
		buffer,
		format: jpegQuality == null ? "png" : "jpg",
		params: {
			mx: round(mx, 4),
			my: round(my, 4),
			angleDeg: round(angleDeg, 3),
			dx,
			dy,
			ink,
			paper,
			gradient: round(gradient, 4),
			blurSigma: round(blurSigma, 3),
			noiseSigma: round(noiseSigma, 3),
			jpegQuality,
			frameWidth,
			frameHeight,
			// recorded but outside the manifest's documented core, for anyone
			// correlating a failure with the frame that produced it
			trayGrey,
			vignette: round(vignette, 4),
			margin: round(margin, 4),
		},
	};
}

module.exports = { capture, capturePresets };
