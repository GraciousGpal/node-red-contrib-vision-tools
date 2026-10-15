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

function makeNode(config = {}, comms) {
	const node = loadNode("synthetic-defects.js", { ...BASE, ...config }, {
		id: "synthetic-defects-test",
		comms,
	});
	const frames = [];
	const goldens = [];
	const statuses = [];
	const doneErrors = [];
	let doneCalls = 0;
	const t = { node, frames, goldens, statuses, doneErrors, doneCalls: () => doneCalls, onFrame: null };
	const send = (out) => {
		const list = Array.isArray(out) ? out : [out];
		if (list[0]) {
			frames.push(list[0]);
			if (t.onFrame) t.onFrame(list[0]);
		}
		if (list[1]) goldens.push(list[1]);
	};
	node.send = send;
	node.status = (s) => statuses.push(s);
	t.run = (msg = {}) =>
		node.listeners.input(msg, send, (err) => {
			doneCalls++;
			if (err) doneErrors.push(err && err.message ? String(err.message) : String(err));
		});
	return t;
}

const isPng = (b) =>
	Buffer.isBuffer(b) && b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG";

// One full run at BASE with no RED.comms, shared by every test that only
// reads what it emitted; a test that changes the config runs its own.
let baseRun = null;
function base() {
	if (!baseRun) {
		baseRun = (async () => {
			const t = makeNode();
			await t.run({});
			return t;
		})();
	}
	return baseRun;
}

test("emits the golden first, then one message per frame", async () => {
	// BASE passes no comms, so this is also the no-RED.comms run: frames
	// flow and nothing complains
	const t = await base();

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
	assert.equal(t.frames.length, 3 + 3 + 4);
	assert.equal(t.doneCalls(), 1);
	assert.deepEqual(t.doneErrors, []);

	// the field contract is test/synthDefects.test.js's; this checks what
	// the node adds to each case
	assert.ok(g.goldenKey, "the golden message carries a key");
	for (const [i, m] of t.frames.entries()) {
		assert.ok(Buffer.isBuffer(m.payload), `frame ${i} payload is bytes`);
		assert.ok(isPng(m.golden), `frame ${i} carries the golden as PNG`);
		assert.equal(m.goldenKey, g.goldenKey, `frame ${i} names the run's golden`);
		assert.match(m.filename, /\.(png|jpg)$/);
		const s = m.synth;
		assert.equal(s.index, i);
		assert.equal(s.total, t.frames.length);
		assert.ok(["mark", "clean"].includes(s.family));
		assert.equal(m.filename, `${s.id}.${m.filename.split(".").pop()}`);
		assert.ok(["clean-rig", "typical", "harsh"].includes(s.preset));
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
		}
	}

	const last = t.statuses[t.statuses.length - 1];
	assert.equal(last.fill, "green");
	assert.match(last.text, new RegExp(`done.*\\b${t.frames.length} frames`));
	// and the frames are real images
	const meta = await sharp(t.frames[0].payload).metadata();
	assert.ok(meta.width > 300);
});

test("the same seed emits byte-identical frames", async () => {
	const a = await base();
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
	assert.notEqual(t.goldens[0].goldenKey, (await base()).goldens[0].goldenKey);
	assert.deepEqual(t.doneErrors, []);
});

test("a configured golden path is the golden when the payload is empty", async () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synth-golden-"));
	const file = path.join(dir, "artwork.png");
	const raw = Buffer.alloc(280 * 360, 255);
	for (let y = 100; y < 140; y++) raw.fill(0, y * 280 + 40, y * 280 + 200);
	fs.writeFileSync(
		file,
		await sharp(raw, { raw: { width: 280, height: 360, channels: 1 } }).png().toBuffer(),
	);
	try {
		const t = makeNode({ goldenPath: file });
		await t.run({});
		assert.deepEqual(t.doneErrors, []);
		assert.equal(t.goldens[0].synth.source, "file");
		assert.equal(t.goldens[0].synth.width, 280);
		assert.equal(t.goldens[0].synth.height, 360);
		assert.ok(t.frames.length > 0);

		// msg.payload still wins over the configured path
		const u = makeNode({ goldenPath: file });
		await u.run({ payload: fs.readFileSync(file) });
		assert.equal(u.goldens[0].synth.source, "input");

		// and msg.goldenPath overrides the configured one
		const v = makeNode({ goldenPath: "/nowhere/at/all.png" });
		await v.run({ goldenPath: file });
		assert.deepEqual(v.doneErrors, []);
		assert.equal(v.goldens[0].synth.source, "file");

		// a path that does not exist is an error, not a silent synthetic label
		const w = makeNode({ goldenPath: "/nowhere/at/all.png" });
		await w.run({});
		assert.equal(w.doneErrors.length, 1);
		assert.match(w.doneErrors[0], /golden path/);
		assert.equal(w.goldens.length, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a fixed rig shoots every frame at one magnification; a free one does not", async () => {
	const rig = makeNode({ perVariant: 2 });
	await rig.run({});
	assert.equal(rig.goldens[0].synth.rig, true);
	const mxs = new Set(rig.frames.map((m) => m.synth.capture.mx));
	const mys = new Set(rig.frames.map((m) => m.synth.capture.my));
	assert.equal(mxs.size, 1, `rig set drew ${mxs.size} magnifications`);
	assert.equal(mys.size, 1);
	for (const m of rig.frames) {
		assert.deepEqual(m.synth.rig, { mx: [...mxs][0], my: [...mys][0] });
	}
	// angle and placement still vary - the applicator is not a stand
	assert.ok(new Set(rig.frames.map((m) => m.synth.capture.angleDeg)).size > 1);

	const free = makeNode({ perVariant: 2, rig: false });
	await free.run({});
	assert.equal(free.goldens[0].synth.rig, false);
	assert.ok(new Set(free.frames.map((m) => m.synth.capture.mx)).size > 1, "a free set re-rolls magnification");
	assert.equal(free.frames[0].synth.rig, null);

	// msg.rig overrides the configured value either way
	const over = makeNode({ perVariant: 2, rig: false });
	await over.run({ rig: true });
	assert.equal(new Set(over.frames.map((m) => m.synth.capture.mx)).size, 1);
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
	// The first run sends its first frame, then parks in a 1 s interval.
	// The second input is sent from that frame's send(), deferred by one
	// setImmediate so the first run has entered its wait: no clock race.
	const t = makeNode({ intervalMs: 1000 });
	let second = null;
	t.onFrame = () => {
		t.onFrame = null;
		setImmediate(() => {
			second = t.run({ intervalMs: 0 });
		});
	};
	await t.run({});
	await second;

	const full = (await base()).frames.length;
	assert.equal(t.frames.length, 1 + full, "the cancelled run stops after its one frame");
	assert.equal(t.goldens.length, 2, "each run announces its own golden");
	assert.equal(t.doneCalls(), 2);
	assert.deepEqual(t.doneErrors, []);
});

// ---- preview ---------------------------------------------------------------

function fakeComms() {
	const events = [];
	return { events, publish: (topic, data) => events.push({ topic, data }) };
}

test("the preview shows the golden, then every frame with its box on the frame", async () => {
	const comms = fakeComms();
	const t = makeNode({ previewWidth: 120 }, comms);
	await t.run({});

	const events = comms.events;
	assert.ok(events.every((e) => e.topic === "synthetic-defects-preview"));
	assert.equal(events.length, 1 + t.frames.length, "one golden event plus one per frame");

	const g = events[0].data;
	assert.equal(g.id, "synthetic-defects-test");
	assert.equal(g.kind, "golden");
	assert.equal(g.imageWidth, 300);
	assert.equal(g.imageHeight, 420);
	assert.equal(g.total, t.frames.length);
	assert.equal(g.pass, true);
	assert.match(g.text, new RegExp(`^golden\\b.*\\b${t.frames.length} frames to come`));
	assert.deepEqual(g.boxes, []);
	// the thumbnail is a real JPEG no wider than asked
	const gm = await sharp(Buffer.from(g.image, "base64")).metadata();
	assert.equal(gm.format, "jpeg");
	assert.equal(gm.width, 120);

	for (const [i, e] of events.slice(1).entries()) {
		const d = e.data;
		const m = t.frames[i];
		assert.equal(d.kind, "frame");
		assert.equal(d.index, i + 1);
		assert.equal(d.total, t.frames.length);
		assert.equal(d.previewWidth, 120);
		assert.equal(d.imageWidth, m.synth.capture.frameWidth);
		assert.equal(d.imageHeight, m.synth.capture.frameHeight);
		assert.equal(d.pass, m.synth.expected.pass);
		assert.ok(d.text.startsWith(`${i + 1}/${t.frames.length} · ${m.synth.family}`), d.text);
		assert.match(d.text, m.synth.expected.pass ? /expect pass/ : /expect fail/);
		if (m.synth.family === "clean") {
			assert.deepEqual(d.boxes, []);
			assert.match(d.text, /expect pass$/);
		} else {
			assert.equal(d.boxes.length, 1);
			const b = d.boxes[0];
			assert.equal(b.type, "mark");
			assert.equal(b.channel, m.synth.defects[0].channel);
			assert.equal(b.corners.length, 4);
			// the box is on the frame, inside the label's placed footprint
			const c = m.synth.capture;
			for (const p of b.corners) {
				assert.ok(p.x >= c.dx - 1 && p.x <= c.frameWidth - c.dx + 1, `corner x ${p.x} in frame ${c.frameWidth}`);
				assert.ok(p.y >= c.dy - 1 && p.y <= c.frameHeight - c.dy + 1, `corner y ${p.y} in frame ${c.frameHeight}`);
			}
			// and it is the golden-space bbox grown by the magnification
			const bbox = m.synth.defects[0].bbox;
			const spanX = Math.max(...b.corners.map((p) => p.x)) - Math.min(...b.corners.map((p) => p.x));
			assert.ok(spanX >= bbox.w * c.mx - 1 && spanX <= bbox.w * c.my * 1.1 + 2, `span ${spanX} vs bbox ${bbox.w} at ${c.mx}x`);
		}
	}
	assert.deepEqual(t.doneErrors, []);
});

test("preview off publishes one clear and no images", async () => {
	const comms = fakeComms();
	const t = makeNode({ previewEnabled: false }, comms);
	await t.run({});
	assert.deepEqual(comms.events, [
		{ topic: "synthetic-defects-preview", data: { id: "synthetic-defects-test", clear: true } },
	]);
	assert.ok(t.frames.length > 0, "frames still flow without a preview");
});

test("msg.previewEnabled overrides the configured preview either way", async () => {
	const off = fakeComms();
	const a = makeNode({}, off);
	await a.run({ previewEnabled: false });
	assert.equal(off.events.length, 1);
	assert.equal(off.events[0].data.clear, true);

	const on = fakeComms();
	const b = makeNode({ previewEnabled: false }, on);
	await b.run({ previewEnabled: true, previewWidth: 90 });
	assert.ok(on.events.length > 1);
	assert.ok(on.events.every((e) => e.data.previewWidth === 90));
});
