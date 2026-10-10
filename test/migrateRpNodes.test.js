/**
 * scripts/migrate-rp-nodes.js: rp-resize to image-resize with the same
 * sizes, rp-heat-diff removed from wires and groups, and a refusal - with
 * nothing changed - for anything it cannot carry over exactly.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { migrate } = require("../scripts/migrate-rp-nodes.js");
const { targetSize } = require("../image-resize.js");

// rp-resize as the editor saves it, with the options the rig's flows use
function rpResize(id, extra = {}) {
	return {
		id,
		type: "rp-resize",
		z: "tab",
		g: "grp",
		name: "halve",
		inputPath: "payload",
		inputPathType: "msg",
		outputPath: "payload",
		outputPathType: "msg",
		outputFormat: "raw",
		outputQuality: 90,
		pngOptimize: false,
		debugEnabled: false,
		widthMode: "multiply",
		widthValue: "0.5",
		widthType: "num",
		heightMode: "set",
		heightValue: "",
		heightType: "num",
		inferenceEnabled: false,
		x: 10,
		y: 20,
		wires: [["next"]],
		l: false,
		...extra,
	};
}

const flow = () => [
	{ id: "tab", type: "tab", label: "t" },
	{ id: "grp", type: "group", z: "tab", nodes: ["a", "b", "hd"] },
	{ id: "src", type: "function", z: "tab", wires: [["a", "hd"]] },
	rpResize("a"),
	rpResize("b", { outputFormat: "png", outputQuality: 80 }),
	{ id: "hd", type: "rp-heat-diff", z: "tab", g: "grp", name: "heat diff", wires: [[]] },
	{ id: "next", type: "debug", z: "tab", wires: [] },
];

test("rp-resize becomes image-resize in place, with rp-resize's sizes", () => {
	const { flow: out, changes } = migrate(flow());
	const a = out.find((n) => n.id === "a");
	assert.deepStrictEqual(a, {
		id: "a",
		type: "image-resize",
		z: "tab",
		g: "grp",
		name: "halve",
		inputPath: "payload",
		outputPath: "payload",
		widthMode: "multiply",
		widthValue: "0.5",
		heightMode: "auto",
		heightValue: "",
		outputFormat: "raw",
		outputQuality: 90,
		x: 10,
		y: 20,
		wires: [["next"]],
		l: false,
	});
	assert.strictEqual(out.find((n) => n.id === "b").outputFormat, "png");
	assert.strictEqual(out.find((n) => n.id === "b").outputQuality, 80);
	// rp-resize's own arithmetic for multiply 0.5 / set "": round(w * 0.5),
	// then round(w' * h / w)
	for (const [w, h] of [[2950, 4250], [3001, 2001], [1, 7]]) {
		const width = Math.round(w * 0.5) || 1;
		assert.deepStrictEqual(targetSize(w, h, a), { width, height: Math.round((width * h) / w) });
	}
	assert.strictEqual(changes.length, 3);
});

test("rp-heat-diff is removed from the flow, every wire and its group", () => {
	const { flow: out } = migrate(flow());
	assert.ok(!out.some((n) => n.id === "hd"));
	assert.deepStrictEqual(out.find((n) => n.id === "src").wires, [["a"]]);
	assert.deepStrictEqual(out.find((n) => n.id === "grp").nodes, ["a", "b"]);
	assert.strictEqual(out.length, flow().length - 1);
});

test("anything it cannot carry over exactly stops the migration, naming every node", () => {
	const bad = [
		rpResize("x", { widthType: "flow" }),
		rpResize("y", { outputFormat: "webp" }),
		rpResize("z", { widthMode: "percent" }),
		rpResize("w", { inputPathType: "flow" }),
		rpResize("v", { widthMode: "set", widthValue: "" }),
		{ id: "u", type: "rp-crop", name: "c" },
	];
	assert.throws(
		() => migrate(bad),
		(err) => ["x", "y", "z", "w", "v", "rp-crop u"].every((id) => err.message.includes(id)),
	);
	// set with a size stays set
	const { flow: out } = migrate([rpResize("s", { widthMode: "set", widthValue: "800", heightMode: "set", heightValue: "600" })]);
	assert.deepStrictEqual([out[0].widthMode, out[0].widthValue, out[0].heightMode, out[0].heightValue], ["set", "800", "set", "600"]);
});

test("the CLI never overwrites its input", () => {
	const { spawnSync } = require("node:child_process");
	const script = path.join(__dirname, "..", "scripts", "migrate-rp-nodes.js");
	const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "vt-migrate-"));
	const input = path.join(dir, "flows.json");
	fs.writeFileSync(input, JSON.stringify(flow(), null, 4));
	const same = spawnSync(process.execPath, [script, input, input], { encoding: "utf8" });
	assert.strictEqual(same.status, 2);
	const ok = spawnSync(process.execPath, [script, input], { encoding: "utf8" });
	assert.strictEqual(ok.status, 0, ok.stderr);
	const written = JSON.parse(fs.readFileSync(path.join(dir, "flows.migrated.json"), "utf8"));
	assert.ok(written.some((n) => n.type === "image-resize"));
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(input, "utf8")), flow());
	fs.rmSync(dir, { recursive: true, force: true });
});
