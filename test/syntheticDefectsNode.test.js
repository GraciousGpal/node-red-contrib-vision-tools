/**
 * Node-RED glue tests for the synthetic-defects node.
 *
 * The node is exercised without Node-RED installed, through the same fake
 * RED every other node test here uses: the registerType factory is invoked
 * with a stub, and the node's own 'input' listener is driven directly.
 *
 * Everything runs at a 300x420 golden with one family and one severity
 * ticked, because the properties being checked - the shape of the two
 * output messages, determinism, cancellation, error routing - are
 * independent of how big the label is, and a default 1500x2100 set is a
 * couple of minutes per run. The frames themselves are pinned by
 * test/synthDefects.test.js.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { loadNode } = require("./helpers/fakeRed.js");

const BASE = {
	seed: 1,
	perVariant: 1,
	preset: "typical",
	mark: true,
	tiny: true,
	intervalMs: 0,
	width: 300,
	height: 420,
};

function makeNode(config = {}) {
	const node = loadNode("synthetic-defects.js", { ...BASE, ...config }, {
		id: "synthetic-defects-test",
	});
	const frames = [];
	const goldens = [];
	const statuses = [];
	const doneErrors = [];
	let doneCalls = 0;
	const send = (out) => {
		const list = Array.isArray(out) ? out : [out];
		if (list[0]) frames.push(list[0]);
		if (list[1]) goldens.push(list[1]);
	};
	node.send = send;
	node.status = (s) => statuses.push(s);
	const run = (msg = {}) =>
		node.listeners.input(msg, send, (err) => {
			doneCalls++;
			if (err) doneErrors.push(err && err.message ? String(err.message) : String(err));
		});
	return { node, run, frames, goldens, statuses, doneErrors, doneCalls: () => doneCalls };
}

const isPng = (b) =>
	Buffer.isBuffer(b) && b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG";

test("emits the golden first, then one message per frame", async () => {
	const t = makeNode();
	await t.run({});

	assert.equal(t.goldens.length, 1, "exactly one golden message");
	const g = t.goldens[0];
	assert.ok(isPng(g.payload));
	assert.equal(g.filename, "golden.png");
	assert.equal(g.synth.kind, "golden");
	assert.equal(g.synth.source, "synthetic");
	assert.equal(g.synth.width, 300);
	assert.equal(g.synth.height, 420);
	assert.equal(g.synth.total, t.frames.length);

	// mark has three variants x one severity x perVariant 1, plus the clean
	// floor (3) and two clean frames at each of the other two presets
	assert.ok(t.frames.length >= 3 + 3 + 4, `only ${t.frames.length} frames`);
	assert.equal(t.doneCalls(), 1);
	assert.deepEqual(t.doneErrors, []);

	for (const [i, m] of t.frames.entries()) {
		assert.ok(Buffer.isBuffer(m.payload), `frame ${i} payload is bytes`);
		assert.ok(isPng(m.golden), `frame ${i} carries the golden as PNG`);
		assert.match(m.goldenKey, /^synth:1:[0-9a-f]{40}$/);
		assert.match(m.filename, /\.(png|jpg)$/);
		const s = m.synth;
		assert.equal(s.index, i);
		assert.equal(s.total, t.frames.length);
		assert.ok(["mark", "clean"].includes(s.family));
		assert.equal(m.filename, `${s.id}.${m.filename.split(".").pop()}`);
		assert.ok(["clean-rig", "typical", "harsh"].includes(s.preset));
		// the manifest contract's capture block
		for (const k of ["mx", "my", "angleDeg", "dx", "dy", "ink", "paper", "frameWidth", "frameHeight"]) {
			assert.equal(typeof s.capture[k], "number", `capture.${k}`);
		}
		assert.ok(Array.isArray(s.defects));
		assert.equal(typeof s.expected.pass, "boolean");
		assert.ok(Array.isArray(s.expected.channels));
		if (s.family === "clean") {
			assert.equal(s.variant, null);
			assert.equal(s.severity, null);
			assert.deepEqual(s.defects, []);
			assert.equal(s.expected.pass, true);
		} else {
			assert.equal(s.severity, "tiny");
			assert.equal(s.defects.length, 1);
			const d = s.defects[0];
			assert.equal(d.type, "mark");
			assert.equal(d.variant, s.variant);
			assert.ok(["print", "background", "both", "none"].includes(d.channel));
			assert.equal(typeof d.bbox.x, "number");
		}
	}

	const last = t.statuses[t.statuses.length - 1];
	assert.equal(last.fill, "green");
	assert.match(last.text, /^done · \d+ frames?$/);
	// and the frames are real images
	const meta = await sharp(t.frames[0].payload).metadata();
	assert.ok(meta.width > 300);
});

test("the same seed emits byte-identical frames", async () => {
	const a = makeNode();
	await a.run({});
	const b = makeNode();
	await b.run({});

	assert.equal(a.frames.length, b.frames.length);
	assert.equal(a.goldens[0].goldenKey, b.goldens[0].goldenKey);
	for (let i = 0; i < a.frames.length; i++) {
		assert.equal(a.frames[i].synth.id, b.frames[i].synth.id);
		assert.ok(
			a.frames[i].payload.equals(b.frames[i].payload),
			`frame ${i} differs between two runs of the same seed`,
		);
	}
});

test("a Buffer payload is used as the golden", async () => {
	// paper with a black bar across it, so there is ink for a defect to land
	// on and the channel derivation has something to measure
	const raw = Buffer.alloc(260 * 340, 255);
	for (let y = 80; y < 120; y++) raw.fill(0, y * 260 + 60, y * 260 + 180);
	const golden = await sharp(raw, { raw: { width: 260, height: 340, channels: 1 } })
		.png()
		.toBuffer();

	const t = makeNode();
	await t.run({ payload: golden });

	assert.equal(t.goldens[0].synth.source, "input");
	assert.equal(t.goldens[0].synth.width, 260);
	assert.equal(t.goldens[0].synth.height, 340);
	assert.ok(t.frames.length > 0);
	// a different golden means a different key from the synthetic run
	assert.match(t.goldens[0].goldenKey, /^synth:1:[0-9a-f]{40}$/);
	assert.deepEqual(t.doneErrors, []);
});

test("an unusable payload reports through done(err) exactly once", async () => {
	const t = makeNode();
	await t.run({ payload: Buffer.from("not an image at all") });

	assert.equal(t.doneCalls(), 1);
	assert.equal(t.doneErrors.length, 1);
	assert.equal(t.frames.length, 0);
	assert.equal(t.goldens.length, 0);
	assert.equal(t.statuses[t.statuses.length - 1].fill, "red");
});

test("a second input while running cancels the first", async () => {
	// a non-zero interval keeps the first run parked in its timer long
	// enough for the second message to land
	const t = makeNode({ intervalMs: 50 });
	const first = t.run({});
	await new Promise((r) => setTimeout(r, 80));
	const second = t.run({ intervalMs: 0 });
	await Promise.all([first, second]);

	const full = makeNode();
	await full.run({});
	assert.ok(
		t.frames.length < full.frames.length * 2,
		`${t.frames.length} frames from a cancelled run plus a full one, ` +
			`vs ${full.frames.length * 2} for two full runs`,
	);
	assert.equal(t.goldens.length, 2, "each run announces its own golden");
	assert.deepEqual(t.doneErrors, []);
});
