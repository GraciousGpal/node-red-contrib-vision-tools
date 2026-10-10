/**
 * Move a flow off @rosepetal/node-red-contrib-image-tools.
 *
 *   node scripts/migrate-rp-nodes.js flows.json [out.json]
 *
 * Writes out.json (default: flows.json beside itself as
 * flows.migrated.json) and prints what it changed. Nothing else is
 * touched; the input file is never overwritten.
 *
 *  - rp-resize becomes image-resize, this package's resize node: the same
 *    id, tab, group, position, wires and name. Its width and height rules
 *    carry over (multiply stays multiply; set with a size stays set; set
 *    with no size, rp-resize's "auto from the other side", becomes auto),
 *    as do the msg input and output paths and raw/png/jpg output with its
 *    quality.
 *  - rp-heat-diff is removed, and its id from every wire and group: it is
 *    a debug view, and image-resize has no equivalent; golden-compare's
 *    own heat map and overlay show what it compared.
 *
 * Anything this cannot carry over exactly - a size from a flow or env
 * variable, a webp output, an rp-resize option this package has no
 * equivalent for switched on, any other rp-* node - stops the migration
 * with the node's id and the reason, and nothing is written: a flow half
 * moved is worse than one not moved.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function sizeOf(node, side) {
	const mode = node[`${side}Mode`];
	const value = node[`${side}Value`];
	const type = node[`${side}Type`];
	if (type !== undefined && type !== "num") {
		throw new Error(`${side} comes from ${type}, not a number`);
	}
	const blank = value === undefined || value === null || String(value).trim() === "";
	if (mode === "multiply") {
		if (blank) throw new Error(`${side} factor is blank`);
		return { mode: "multiply", value: String(value) };
	}
	if (mode === "set") return blank ? { mode: "auto", value: "" } : { mode: "set", value: String(value) };
	throw new Error(`${side} mode "${mode}" has no equivalent`);
}

function msgPath(node, key) {
	const type = node[`${key}Type`];
	if (type !== undefined && type !== "msg") throw new Error(`${key} is a ${type} property, not msg`);
	return String(node[key] || "payload");
}

/** The image-resize node for one rp-resize node. Throws when it cannot be exact. */
function resizeNode(rp) {
	const width = sizeOf(rp, "width");
	const height = sizeOf(rp, "height");
	if (width.mode === "auto" && height.mode === "auto") throw new Error("both sides are auto");
	const fmt = String(rp.outputFormat || "raw").toLowerCase();
	const outputFormat = { raw: "raw", png: "png", jpg: "jpg", jpeg: "jpg" }[fmt];
	if (!outputFormat) throw new Error(`output format "${rp.outputFormat}" has no equivalent`);
	if (rp.inferenceEnabled) throw new Error("its inference option is on, which has no equivalent");
	const out = {
		id: rp.id,
		type: "image-resize",
		z: rp.z,
		...(rp.g !== undefined ? { g: rp.g } : {}),
		name: rp.name || "",
		inputPath: msgPath(rp, "inputPath"),
		outputPath: msgPath(rp, "outputPath"),
		widthMode: width.mode,
		widthValue: width.value,
		heightMode: height.mode,
		heightValue: height.value,
		outputFormat,
		outputQuality: Number.isFinite(Number(rp.outputQuality)) ? Number(rp.outputQuality) : 90,
		x: rp.x,
		y: rp.y,
		wires: rp.wires,
	};
	if (rp.l !== undefined) out.l = rp.l;
	if (rp.d !== undefined) out.d = rp.d;
	return out;
}

/**
 * The migrated flow and a list of what changed. Throws, naming every node
 * it could not carry over, before changing anything.
 */
function migrate(flow) {
	if (!Array.isArray(flow)) throw new Error("not a flows array");
	const problems = [];
	const changes = [];
	const removed = new Set();
	const replaced = new Map();
	for (const node of flow) {
		if (typeof node.type !== "string" || !node.type.startsWith("rp-")) continue;
		try {
			if (node.type === "rp-resize") replaced.set(node.id, resizeNode(node));
			else if (node.type === "rp-heat-diff") removed.add(node.id);
			else throw new Error(`no equivalent for ${node.type}`);
		} catch (err) {
			problems.push(`${node.type} ${node.id} "${node.name || ""}": ${err.message}`);
		}
	}
	if (problems.length) throw new Error(`cannot migrate exactly:\n  ${problems.join("\n  ")}`);
	const out = [];
	for (const node of flow) {
		if (removed.has(node.id)) {
			changes.push(`removed ${node.type} ${node.id} "${node.name || ""}"`);
			continue;
		}
		let next = replaced.get(node.id) || node;
		if (replaced.has(node.id)) {
			changes.push(
				`${node.id} "${node.name || ""}": rp-resize -> image-resize ` +
					`(width ${next.widthMode} ${next.widthValue}, height ${next.heightMode} ${next.heightValue}, ${next.outputFormat})`,
			);
		}
		if (removed.size && Array.isArray(next.wires)) {
			const wires = next.wires.map((port) => port.filter((id) => !removed.has(id)));
			if (JSON.stringify(wires) !== JSON.stringify(next.wires)) next = { ...next, wires };
		}
		if (removed.size && next.type === "group" && Array.isArray(next.nodes)) {
			const nodes = next.nodes.filter((id) => !removed.has(id));
			if (nodes.length !== next.nodes.length) next = { ...next, nodes };
		}
		out.push(next);
	}
	return { flow: out, changes };
}

if (require.main === module) {
	const [input, output] = process.argv.slice(2);
	if (!input) {
		console.error("usage: node scripts/migrate-rp-nodes.js flows.json [out.json]");
		process.exit(2);
	}
	const target = output || path.join(path.dirname(input), "flows.migrated.json");
	if (path.resolve(target) === path.resolve(input)) {
		console.error("refusing to overwrite the input; name another output file");
		process.exit(2);
	}
	try {
		const text = fs.readFileSync(input, "utf8");
		const { flow, changes } = migrate(JSON.parse(text));
		// keep the input's indentation, so the diff is the migration alone
		const indent = /^\[\s*\n(\s+)/.exec(text);
		fs.writeFileSync(target, `${JSON.stringify(flow, null, indent ? indent[1] : 4)}\n`);
		for (const c of changes) console.log(c);
		console.log(`${changes.length} change${changes.length === 1 ? "" : "s"}; wrote ${target}`);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

module.exports = { migrate, resizeNode };
