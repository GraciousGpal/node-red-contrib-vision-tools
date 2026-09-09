/**
 * Temporary diagnostic: probe Sobel edge evidence on a sample photo to
 * decide whether edge-based label detection is viable. Not part of the
 * test suite.
 */
const cv = require("@rosepetal/node-red-contrib-image-tools/node-red-contrib-image-tools/lib/cpp-bridge.js");
const fs = require("fs");

async function main() {
	const path = process.argv[2] || "/data/sample_images/13112025_003.png";
	const buf = fs.readFileSync(path);
	const { image: full } = await cv.colorConvert(buf, "RGB", "raw");
	console.log("full", full.width, "x", full.height);

	const scale = 640 / Math.max(full.width, full.height);
	const w = Math.round(full.width * scale);
	const h = Math.round(full.height * scale);
	const { image: small } = await cv.resize(full, "num", w, "num", h, "raw");
	const { image: gray } = await cv.colorConvert(small, "GRAY", "raw");
	const { image: edges } = await cv.filter(gray, "edge", 3, 1.0, "raw");
	console.log("detection copy", w, "x", h, "edge bytes", edges.data.length);

	const E = edges.data;
	const colTotal = new Float64Array(w);
	const rowTotal = new Float64Array(h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const v = E[y * w + x];
			colTotal[x] += v;
			rowTotal[y] += v;
		}
	}
	const px = (x) => Math.round(x / scale);

	console.log("\n--- vertical columns (every 6th) ---");
	for (let x = 0; x < w; x += 6) {
		const bar = "#".repeat(Math.min(60, Math.round(colTotal[x] / h / 4)));
		console.log(
			String(px(x)).padStart(5),
			String(Math.round(colTotal[x] / h)).padStart(4),
			bar,
		);
	}

	console.log("\n--- horizontal rows (every 8th) ---");
	for (let y = 0; y < h; y += 8) {
		const bar = "#".repeat(Math.min(60, Math.round(rowTotal[y] / w / 4)));
		console.log(
			String(px(y)).padStart(5),
			String(Math.round(rowTotal[y] / w)).padStart(4),
			bar,
		);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
