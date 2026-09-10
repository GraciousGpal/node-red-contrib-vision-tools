const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHeatmapGrid } = require("../lib/compare.js");
const { buildIntegral, blockSum } = require("../lib/integral.js");

// The original summed-area implementation is the exact-output oracle.
// Include clipped edge blocks, empty/full masks and the deployed geometry.
test("block densities match the integral reference byte-for-byte", () => {
	for (const [width, height] of [
		[1, 1],
		[3, 7],
		[64, 48],
		[67, 51],
		[1475, 2125],
	]) {
		for (const blockSize of [4, 8, 16, 96, 256]) {
			for (const mode of ["empty", "full", "pattern"]) {
				const mask = Uint8Array.from({ length: width * height }, (_, i) =>
					mode === "empty"
						? 0
						: mode === "full"
							? 1
							: (i * 37 + (i >>> 3)) % 101 < 17
								? 1
								: 0,
				);
				const table = buildIntegral(mask, width, height);
				const gridW = Math.ceil(width / blockSize);
				const gridH = Math.ceil(height / blockSize);
				const expected = new Float32Array(gridW * gridH);
				for (let gy = 0; gy < gridH; gy++) {
					for (let gx = 0; gx < gridW; gx++) {
						const x0 = gx * blockSize;
						const y0 = gy * blockSize;
						const x1 = Math.min(width, x0 + blockSize);
						const y1 = Math.min(height, y0 + blockSize);
						expected[gy * gridW + gx] =
							blockSum(table, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
					}
				}
				const actual = buildHeatmapGrid(mask, width, height, blockSize);
				assert.equal(actual.gridW, gridW);
				assert.equal(actual.gridH, gridH);
				assert.deepEqual(
					actual.density,
					expected,
					`${width}x${height}, block ${blockSize}, ${mode}`,
				);
			}
		}
	}
});
