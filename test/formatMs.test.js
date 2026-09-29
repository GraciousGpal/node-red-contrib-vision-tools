/**
 * The time every vision node appends to its status: milliseconds under a
 * second, seconds with two decimals from there.
 */

const test = require("node:test");
const assert = require("node:assert");
const { formatMs } = require("../lib/formatMs.js");

test("under a second is whole milliseconds", () => {
	assert.strictEqual(formatMs(0), "0ms");
	assert.strictEqual(formatMs(83.6), "84ms");
	assert.strictEqual(formatMs(999.4), "999ms");
});

test("from a second up it is seconds to two decimals", () => {
	assert.strictEqual(formatMs(1000), "1.00s");
	assert.strictEqual(formatMs(1234.5), "1.23s");
	assert.strictEqual(formatMs(61000), "61.00s");
});
