/**
 * barcode-locate placing a profile's barcode region through the transform
 * the real golden-compare solved for the frame, end to end, with geometry
 * that the hand-built fixtures of test/barcodeLocateProfile.test.js cannot
 * check: a rotated part and a different scale per axis.
 *
 * The golden is a synthetic label carrying a Code128 on a yellow patch
 * (black on yellow decodes like black on white; the yellow is only there
 * so the patch can be measured in the frame). The frame is that label
 * stretched 1.12 x 1.06, rotated 4 degrees and pasted off-centre onto a
 * larger white canvas; golden-compare registers it inline, and
 * barcode-locate, with no pad at all, gets the frame at twice that size,
 * as it gets the native camera frame on the rig. The region it searched
 * (msg.roi) has to be the measured box of the yellow patch to a few px,
 * so a sign flip of the angle or a swapped or wrong scale is caught here
 * rather than absorbed by a 128 px pad.
 */

"use strict";

process.env.GOLDEN_COMPARE_INLINE = "1";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const profileStore = require("../lib/profileStore.js");
const { loadNode } = require("./helpers/fakeRed.js");

// The writer is a test-only dependency, made offline as in test/locate.test.js
let writer = null;
let writerError = null;
try {
	writer = require("zxing-wasm/writer");
	const root = path.resolve(
		path.dirname(require.resolve("zxing-wasm/writer")),
		"..",
		"..",
		"..",
	);
	const wasmBinary = fs.readFileSync(
		path.join(root, "dist", "writer", "zxing_writer.wasm"),
	);
	writer
		.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true })
		.catch(() => {});
} catch (err) {
	writer = null;
	writerError = err;
}
const skip = writer
	? false
	: `zxing-wasm/writer did not load: ${writerError && writerError.message}`;

const TEXT = "VT-FRAME-128";
const W = 900;
const H = 1300;
// golden native px of the patch's top-left; its size is the written code's
const AT = { x: 200, y: 980 };
const STRETCH = { x: 1.12, y: 1.06 };
const ANGLE = 4;
const CANVAS = { width: 1500, height: 1900, left: 170, top: 95 };
const NATIVE = 2; // barcode-locate's payload is the frame at twice the size
// payload px (3 in the compare's frame): the compare solves the angle in
// steps of about 0.3 degrees, a few px across this code's width; the pad
// the node would otherwise add is 128
const TOL = 6;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vt-bc-frame-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BAR_Y = [
	0.1, 0.155, 0.19, 0.26, 0.3, 0.375, 0.41, 0.47, 0.545, 0.6, 0.68,
];
function labelSvg() {
	const bars = BAR_Y.map(
		(f, i) =>
			`<rect x="${Math.round(W * 0.14)}" y="${Math.round(H * f)}" width="${Math.round(W * (i % 3 === 0 ? 0.62 : i % 3 === 1 ? 0.44 : 0.31))}" height="${Math.round(H * 0.022)}" fill="#111"/>`,
	);
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>` +
			`<rect x="90" y="65" width="720" height="1170" fill="none" stroke="#111" stroke-width="9"/>` +
			bars.join("") +
			`</svg>`,
	);
}

// The Code128 with its quiet zones, white turned yellow: (v, v, 0)
async function yellowCode() {
	const r = await writer.writeBarcode(TEXT, {
		format: "Code128",
		scale: 2,
		addQuietZones: true,
	});
	if (r.error) throw new Error(`writeBarcode: ${r.error}`);
	const { data, info } = await sharp(Buffer.from(await r.image.arrayBuffer()))
		.greyscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const rgb = Buffer.alloc(info.width * info.height * 3);
	for (let i = 0; i < info.width * info.height; i++) {
		const v = data[i * info.channels];
		rgb[i * 3] = v;
		rgb[i * 3 + 1] = v;
		rgb[i * 3 + 2] = 0;
	}
	const png = await sharp(rgb, {
		raw: { width: info.width, height: info.height, channels: 3 },
	})
		.png()
		.toBuffer();
	return { png, width: info.width, height: info.height };
}

// bounding box of the yellow pixels (half coverage or more against white)
async function yellowBox(buf) {
	const { data, info } = await sharp(buf)
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < info.height; y++) {
		for (let x = 0; x < info.width; x++) {
			const i = (y * info.width + x) * info.channels;
			if (data[i] > 150 && data[i + 1] > 150 && data[i + 2] < 128) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	assert.ok(maxX >= 0, "precondition: the yellow patch is in the frame");
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test(
	"a rotated, anisotropically scaled frame: the region is where the code is, from golden-compare's transform",
	{ skip },
	async () => {
		const code = await yellowCode();
		const golden = await sharp(labelSvg())
			.composite([{ input: code.png, left: AT.x, top: AT.y }])
			.png()
			.toBuffer();
		const goldenPath = path.join(tmp, "Frame_Golden.png");
		fs.writeFileSync(goldenPath, golden);
		const profileDir = path.join(tmp, "profiles");

		const label = await sharp(golden)
			.resize(Math.round(W * STRETCH.x), Math.round(H * STRETCH.y), {
				fit: "fill",
			})
			.rotate(ANGLE, { background: "#ffffff" })
			.png()
			.toBuffer();
		const frame = await sharp({
			create: {
				width: CANVAS.width,
				height: CANVAS.height,
				channels: 3,
				background: "#ffffff",
			},
		})
			.composite([{ input: label, left: CANVAS.left, top: CANVAS.top }])
			.png()
			.toBuffer();
		const payload = await sharp(frame)
			.resize(CANVAS.width * NATIVE, CANVAS.height * NATIVE, {
				kernel: "nearest",
			})
			.png()
			.toBuffer();
		const truth = await yellowBox(payload);

		// golden-compare, untrained: this frame's own registration is all there is
		const gc = loadNode("golden-compare.js", {
			workers: 1,
			goldenPath,
			profileDir,
			trainTransform: false,
		});
		const gcSent = [];
		const gcErrors = [];
		gc.send = (m) => gcSent.push(m);
		gc.warn = () => {};
		gc.log = () => {};
		await gc.listeners.input(
			{ payload: frame },
			undefined,
			(err) => err && gcErrors.push(String(err.message || err)),
		);
		assert.deepStrictEqual(gcErrors, []);
		// its own barcode derivation writes the same section; let it finish
		// before this test writes the box it measures against
		await Promise.all([...gc.derivations.values()]);
		assert.strictEqual(gcSent.length, 1);
		const result = gcSent[0].result;
		assert.ok(
			["good", "marginal"].includes(result.match.grade),
			`precondition: graded ${result.match.grade}`,
		);
		const t = result.transform;
		assert.ok(
			Math.abs(t.angleDeg - ANGLE) < 0.5,
			`precondition: the compare solved the rotation (${t.angleDeg})`,
		);
		assert.ok(
			t.scaleY / t.scaleX < 0.97,
			`precondition: the compare solved two scales (${t.scaleX}, ${t.scaleY})`,
		);
		assert.ok(
			result.profile && result.profile.path && result.profile.contentKey,
			"precondition: the compare named its profile",
		);

		const box = {
			label: `Code128 ${TEXT}`,
			format: "Code128",
			text: TEXT,
			x: AT.x,
			y: AT.y,
			width: code.width,
			height: code.height,
		};
		await profileStore.writeProfileSection(result.profile.path, "barcodes", {
			source: "golden",
			goldenContentKey: result.profile.contentKey,
			nativeWidth: W,
			nativeHeight: H,
			regions: [box],
		});

		const bl = loadNode("barcode-locate.js", {
			regionSource: "profile",
			mode: "regionsOnly",
			regionPad: "0",
			regionPadMinPx: "0",
		});
		const out = [];
		const blErrors = [];
		bl.send = (m) => out.push(m);
		const blWarns = [];
		bl.warn = (w) => blWarns.push(String(w));
		bl.log = () => {};
		await bl.listeners.input(
			{ ...gcSent[0], payload },
			undefined,
			(err) => err && blErrors.push(String(err.message || err)),
		);
		assert.deepStrictEqual(blErrors, []);

		assert.strictEqual(
			out.length,
			1,
			JSON.stringify(out.map((m) => [m.text, m.source, m.roi])),
		);
		const [m] = out;
		assert.strictEqual(m.regionSource, "profile");
		assert.strictEqual(m.regionPlacement, "frame");
		// locate reports no roi for a region that read nothing
		assert.ok(
			m.roi,
			`nothing read in the profile region (${JSON.stringify({ text: m.text, source: m.source })}): it is not where the code is`,
		);
		for (const k of ["x", "y", "width", "height"]) {
			assert.ok(
				Math.abs(m.roi[k] - truth[k]) <= TOL,
				`roi.${k} ${m.roi[k]} vs measured ${truth[k]} (roi ${JSON.stringify(m.roi)}, measured ${JSON.stringify(truth)})`,
			);
		}
		assert.strictEqual(m.source, "region");
		assert.strictEqual(m.text, TEXT);
		assert.strictEqual(m.textMatches, true);
		assert.deepStrictEqual(blWarns, []);
	},
);
