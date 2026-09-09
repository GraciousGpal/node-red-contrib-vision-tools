const test = require("node:test");
const assert = require("node:assert");
const { labelCrop, available } = require("../lib/labelCrop.js");
const { rawImage } = require("./helpers/synthetic.js");

const nativeAvailable = process.platform !== "win32" && available();

test("native OpenCV integration deskews a rotated label instead of doubling its angle", {
	skip: !nativeAvailable,
}, async () => {
	const width = 800;
	const height = 600;
	const data = Buffer.alloc(width * height * 3, 30);
	const angle = 12;
	const ca = Math.cos((angle * Math.PI) / 180);
	const sa = Math.sin((angle * Math.PI) / 180);
	const cx = width / 2;
	const cy = height / 2;
	const labelWidth = 360;
	const labelHeight = 220;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = (x - cx) * ca + (y - cy) * sa;
			const v = -(x - cx) * sa + (y - cy) * ca;
			if (Math.abs(u) <= labelWidth / 2 && Math.abs(v) <= labelHeight / 2) {
				const i = (y * width + x) * 3;
				data[i] = data[i + 1] = data[i + 2] = 235;
			}
		}
	}

	const result = await labelCrop(rawImage(data, width, height, 3, "RGB"), {
		maxEdge: 400,
		polarity: "light",
		outputFormat: "raw",
	});
	assert.strictEqual(result.detected, true, result.metadata.reason);
	assert.ok(
		Math.abs(result.metadata.angleDeg - angle) < 2,
		`angle ${result.metadata.angleDeg}`,
	);
	assert.ok(
		Math.abs(
			result.image.width / result.image.height - labelWidth / labelHeight,
		) < 0.1,
	);

	let light = 0;
	const pixels = result.image.width * result.image.height;
	for (let i = 0; i < pixels; i++) {
		if (result.image.data[i * result.image.channels] > 128) light++;
	}
	assert.ok(light / pixels > 0.92, `deskewed label fill ${light / pixels}`);
});

test("native OpenCV edge refinement snaps the crop to the label boundary, not the bright blob", {
	skip: !nativeAvailable,
}, async () => {
	const width = 800;
	const height = 600;
	const data = Buffer.alloc(width * height * 3, 150); // grayish table
	// White label: x 200..600, y 100..500 (400x400).
	for (let y = 100; y < 500; y++) {
		for (let x = 200; x < 600; x++) {
			const i = (y * width + x) * 3;
			data[i] = data[i + 1] = data[i + 2] = 245;
		}
	}
	// A bright reflection blob touching the label's right edge. Same
	// brightness as the label, so Otsu lumps it in and the region rect
	// extends to x=680; the edge pass must snap the right side back to 600.
	for (let y = 280; y < 300; y++) {
		for (let x = 600; x < 680; x++) {
			const i = (y * width + x) * 3;
			data[i] = data[i + 1] = data[i + 2] = 245;
		}
	}

	const result = await labelCrop(rawImage(data, width, height, 3, "RGB"), {
		maxEdge: 400,
		polarity: "light",
		outputFormat: "raw",
	});
	assert.strictEqual(result.detected, true, result.metadata.reason);
	// Without refinement the rect would be 480 wide (x 200..680); the
	// boundary snap must bring it back to the 400x400 label.
	assert.ok(
		Math.abs(result.metadata.width - 400) <= 30,
		`width ${result.metadata.width}`,
	);
	assert.ok(
		Math.abs(result.metadata.height - 400) <= 30,
		`height ${result.metadata.height}`,
	);
	assert.ok(
		Math.abs(result.metadata.center.x - 400) <= 20,
		`cx ${result.metadata.center.x}`,
	);
	assert.ok(
		Math.abs(result.metadata.center.y - 300) <= 20,
		`cy ${result.metadata.center.y}`,
	);
	assert.ok(
		result.metadata.refinedSides.includes("right"),
		`refinedSides ${JSON.stringify(result.metadata.refinedSides)}`,
	);
	// The crop itself must exclude the reflection.
	assert.ok(
		Math.abs(result.image.width - 400) <= 30,
		`crop width ${result.image.width}`,
	);
});
