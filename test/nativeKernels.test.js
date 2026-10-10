/**
 * The native kernels (native/kernels.cc) against the JS ones they stand in
 * for, to the byte: every buffer a dispatch writes - masks, counts, the
 * displacement field, the histograms - on synthetic dispatches built as
 * the pool builds them (test/helpers/kernelCases.js).
 *
 * Exactly, not closely, for the reason the pool's own tests give: a mask
 * that differed would be a verdict that depends on whether a binary
 * loaded on this host. Skipped where no binary loads (the JS kernels then
 * run, and are tested everywhere else).
 *
 * VISION_TOOLS_FUZZ_ROUNDS sets how many random dispatches each kernel
 * gets beyond the fixed ones (default 40; the CI's prebuild jobs run more).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nativeKernels = require("../lib/nativeKernels.js");
const { kernels } = require("../lib/poolWorker.js");
const { kernelCase, copyCtx, snapshot, KERNELS } = require("./helpers/kernelCases.js");

const status = nativeKernels.status();
const addon = status.native ? nativeKernels.load().addon : null;
const SKIP = status.native ? false : `no native kernels here: ${status.reason}`;
const ROUNDS = Number(process.env.VISION_TOOLS_FUZZ_ROUNDS) || 40;

/** Run one dispatch through both, from the same bytes; what differs. */
function compare(name, ctx, index) {
	const js = copyCtx(ctx);
	const nat = copyCtx(ctx);
	const before = snapshot(js);
	kernels[name](js, 0, ctx.total, index);
	// the addon itself, not withNative: a refused dispatch must fail here,
	// not quietly run the JS kernel
	addon[name](nativeKernels.views(nat), 0, ctx.total, index);
	const want = snapshot(js);
	const got = snapshot(nat);
	const differs = Object.keys(want).filter((k) => !want[k].equals(got[k]));
	const changed = Object.keys(want).some((k) => !want[k].equals(before[k]));
	return { differs, changed };
}

for (const name of KERNELS) {
	test(`native ${name} gives the JS kernel's bytes on ${ROUNDS + 24} synthetic dispatches`, { skip: SKIP }, () => {
		let changed = 0;
		const total = ROUNDS + 24;
		for (let seed = 1; seed <= total; seed++) {
			// the fixed 24 first, then the random ones from a seed of the day
			const s = seed <= 24 ? seed : seed * 7919 + (Number(process.env.VISION_TOOLS_FUZZ_SEED) || 0);
			const ctx = kernelCase(name, s);
			const r = compare(name, ctx, s % 4);
			assert.deepEqual(r.differs, [], `${name} seed ${s}: ${r.differs.join(", ")} differ`);
			if (r.changed) changed++;
		}
		// a kernel that wrote nothing would pass the comparison trivially
		assert.ok(changed >= total * 0.8, `${name}: only ${changed} of ${total} dispatches wrote anything`);
	});
}

test("the field search's AVX2 and baseline builds give the same field", { skip: SKIP }, () => {
	const was = addon.setIsa("auto");
	try {
		for (let seed = 100; seed < 120; seed++) {
			const ctx = kernelCase("localField", seed);
			const a = copyCtx(ctx);
			const b = copyCtx(ctx);
			addon.setIsa("auto");
			addon.localField(nativeKernels.views(a), 0, ctx.total, 0);
			assert.equal(addon.setIsa("base"), "base");
			addon.localField(nativeKernels.views(b), 0, ctx.total, 0);
			assert.deepEqual(snapshot(a), snapshot(b), `seed ${seed}`);
		}
	} finally {
		addon.setIsa(was === "base" ? "base" : "auto");
	}
});

test("a dispatch the addon cannot index is refused before it claims or writes anything", { skip: SKIP }, () => {
	const cases = [
		// a fractional dilation radius indexes rows by a fraction in the JS
		["diff", (c) => ({ ...c, radius: 1.5 })],
		["diff", (c) => ({ ...c, printBlocks: new SharedArrayBuffer(4) })],
		["localField", (c) => ({ ...c, searchable: null })],
		["localApply", (c) => ({ ...c, fx: new SharedArrayBuffer(8) })],
		["binarize", (c) => ({ ...c, width: c.width + 1 })],
		["toneCompare", (c) => ({ ...c, tileLevel: withLevel(c, 9) })],
		["toneCompare", (c) => ({ ...c, chunk: 0 })],
	];
	for (const [name, broken] of cases) {
		const ctx = broken(kernelCase(name, 3));
		const nat = copyCtx(ctx);
		const before = snapshot(nat);
		assert.throws(() => addon[name](nativeKernels.views(nat), 0, ctx.total, 0), { code: "ERR_VT_KERNEL_CTX" }, name);
		assert.equal(new Uint32Array(nat.next)[0], 0, `${name}: nothing claimed`);
		assert.deepEqual(snapshot(nat), before, `${name}: nothing written`);
	}
});

// a slack tile naming a level with no windows
function withLevel(ctx, level) {
	const t = new Uint8Array(new SharedArrayBuffer(ctx.tileLevel.byteLength));
	t.set(new Uint8Array(ctx.tileLevel));
	t[t.length - 1] = level;
	return t.buffer;
}

test("a refused dispatch runs on the JS kernel instead, with the JS kernel's bytes", { skip: SKIP }, () => {
	const run = nativeKernels.withNative(kernels, addon);
	const ctx = { ...kernelCase("diff", 5), radius: 2.5 };
	const js = copyCtx(ctx);
	const viaNative = copyCtx(ctx);
	kernels.diff(js, 0, ctx.total, 1);
	run.diff(viaNative, 0, ctx.total, 1);
	assert.deepEqual(snapshot(viaNative), snapshot(js));
});
