const { rawImage } = require("./synthetic.js");

/**
 * An engine fake whose crop really cuts pixels.
 *
 * The label-crop suites' other fakes hand back zero-filled images of the
 * right size, which is enough to assert geometry but says nothing about
 * bytes. This one copies the requested window out of the image it is
 * given (zeros where the window runs past the edge), so two runs that
 * reach the same crop geometry produce the same bytes and two that do not,
 * do not. rotate returns its input unchanged - the rotation is asserted
 * on the recorded call, not on pixels - and colorConvert, resize and
 * filter are pass-throughs sized for a one-channel frame. Every call is
 * recorded on `calls` as { op, ...args }.
 */
function pixelEngine() {
	const calls = [];
	return {
		calls,
		async colorConvert(image, space, fmt) {
			calls.push({ op: "colorConvert", space, fmt });
			return { image, timing: {} };
		},
		async resize(image, wMode, wVal, hMode, hVal, fmt) {
			calls.push({ op: "resize", wVal, hVal, fmt });
			if (fmt === "jpg") {
				return { image: Buffer.from(`${image.width}x${image.height}`), timing: {} };
			}
			return {
				image: rawImage(Buffer.alloc(wVal * hVal), wVal, hVal, 1, "GRAY"),
				timing: {},
			};
		},
		async filter(image, type) {
			calls.push({ op: "filter", type });
			return { image, timing: {} };
		},
		async crop(image, x, y, w, h, normalized, fmt) {
			calls.push({ op: "crop", x, y, w, h, fmt });
			const ch = image.channels || 1;
			const out = Buffer.alloc(w * h * ch);
			for (let row = 0; row < h; row++) {
				const sy = y + row;
				if (sy < 0 || sy >= image.height) continue;
				for (let col = 0; col < w; col++) {
					const sx = x + col;
					if (sx < 0 || sx >= image.width) continue;
					const src = (sy * image.width + sx) * ch;
					const dst = (row * w + col) * ch;
					for (let c = 0; c < ch; c++) out[dst + c] = image.data[src + c];
				}
			}
			return { image: rawImage(out, w, h, ch, image.colorSpace), timing: {} };
		},
		async rotate(image, angle) {
			calls.push({ op: "rotate", angle });
			return { image, timing: {} };
		},
	};
}

module.exports = { pixelEngine };
