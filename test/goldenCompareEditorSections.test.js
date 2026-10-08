/**
 * The golden-compare editor's collapsible sections, checked on the markup.
 *
 * The dialog's 63 fields are grouped under six headers, two of them with
 * a collapsed sub-section. Moving rows around is how a field gets dropped
 * or lands outside every section (and so can never be hidden, or is hidden
 * under the wrong header), and nothing at runtime notices: Node-RED simply
 * stops saving a setting whose input is gone. So the template is parsed
 * here - no DOM, just the div nesting - and the field list is pinned to the
 * one the flat form had before the sections went in.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "golden-compare.html"), "utf8");
const TEMPLATE = (() => {
	const m = html.match(
		/<script type="text\/html" data-template-name="golden-compare">([\s\S]*?)<\/script>/,
	);
	assert.ok(m, "no golden-compare template");
	return m[1];
})();

// every node-input id the flat form had at 6629ebf, in its order
const IDS_BEFORE_SECTIONS = [
	"name", "goldenPath", "workingSize", "threshold", "alignSearch",
	"thresholdMode", "sauvolaRadius", "sauvolaK", "inkMargin", "profileDir",
	"barcodeRegions", "transformFilePath", "nuisancePath", "noveltyThreshold",
	"trainNuisance", "trainTransform", "mismatchScore", "minCoverage", "workers",
	"nativeFastAlign", "nativeAlignSeed", "localAlign", "localAlignTile",
	"localAlignMax", "alignCandidates", "scaleSearchMin", "scaleSearchMax",
	"scaleSearchSteps", "maxAspect", "aspectSteps", "maxAngleDeg", "angleSteps",
	"positionToleranceAngleDeg", "printTolerance", "backgroundTolerance",
	"edgeMargin", "toneThreshold", "toneMargin", "toneMarginAuto",
	"speckThreshold", "speckMinArea", "speckMaxCount", "speckMaxArea",
	"scaleFilePath", "positionToleranceXMm", "positionToleranceYMm",
	"positionToleranceXPx", "positionToleranceYPx", "blockSize",
	"blockThreshold", "failThreshold", "failRatio", "printMissingFraction",
	"outputHeatmap", "outputPrintHeatmap", "outputBackgroundHeatmap",
	"outputToneHeatmap", "outputSpeckHeatmap", "heatmapFormat",
	"heatmapQuality", "debugStages", "previewEnabled", "previewWidth",
];

const TOP_SECTIONS = ["golden", "ink", "alignment", "position", "blemish", "output"];

/**
 * Walk the template's div tags with a stack. Returns the headers and
 * bodies in document order (with the bodies enclosing each one) and, for
 * every node-input id, the chain of section bodies it sits in, outermost
 * first.
 */
function parse(markup) {
	const headers = [];
	const bodies = [];
	const fields = [];
	const stack = [];
	const re = /<div\b([^>]*)>|<\/div\s*>|\bid="node-input-(\w+)"/g;
	let m;
	const sectionsOpen = () => stack.filter((d) => d.body).map((d) => d.section);
	while ((m = re.exec(markup)) !== null) {
		if (m[2]) {
			fields.push({ id: m[2], chain: sectionsOpen() });
		} else if (m[0].startsWith("</")) {
			assert.ok(stack.length > 0, `unbalanced </div> at offset ${m.index}`);
			stack.pop();
		} else {
			const attrs = m[1];
			const cls = (/\bclass="([^"]*)"/.exec(attrs) || [])[1] || "";
			const section = (/\bdata-section="([^"]*)"/.exec(attrs) || [])[1] || null;
			const classes = cls.split(/\s+/);
			const entry = {
				body: classes.includes("golden-compare-section-body"),
				header: classes.includes("golden-compare-section-header"),
				section,
			};
			if (entry.header) {
				headers.push({ section, chain: sectionsOpen(), index: m.index });
			}
			if (entry.body) {
				bodies.push({ section, chain: sectionsOpen(), index: m.index });
			}
			stack.push(entry);
		}
	}
	assert.strictEqual(stack.length, 0, "a div is never closed");
	return { headers, bodies, fields };
}

const parsed = parse(TEMPLATE);
const innermost = (field) => field.chain[field.chain.length - 1];

test("the set of fields is the one the flat form had", () => {
	const ids = parsed.fields.map((f) => f.id);
	assert.strictEqual(new Set(ids).size, ids.length, "an id appears twice");
	assert.deepStrictEqual([...ids].sort(), [...IDS_BEFORE_SECTIONS].sort());
});

test("every field sits in exactly one innermost body, at most two deep", () => {
	for (const field of parsed.fields) {
		assert.ok(field.chain.length >= 1, `${field.id} is outside every section`);
		assert.ok(
			field.chain.length <= 2,
			`${field.id} is nested ${field.chain.length} bodies deep: ${field.chain.join(" > ")}`,
		);
		assert.ok(
			TOP_SECTIONS.includes(field.chain[0]),
			`${field.id}'s outer body "${field.chain[0]}" is not a top-level section`,
		);
	}
});

test("every header has exactly one body of the same name, right after it", () => {
	const headerNames = parsed.headers.map((h) => h.section);
	const bodyNames = parsed.bodies.map((b) => b.section);
	assert.ok(headerNames.every(Boolean), "a header has no data-section");
	assert.ok(bodyNames.every(Boolean), "a body has no data-section");
	assert.strictEqual(new Set(headerNames).size, headerNames.length, "two headers share a name");
	assert.strictEqual(new Set(bodyNames).size, bodyNames.length, "two bodies share a name");
	assert.deepStrictEqual([...headerNames].sort(), [...bodyNames].sort());
	for (const header of parsed.headers) {
		const body = parsed.bodies.find((b) => b.section === header.section);
		assert.ok(body.index > header.index, `${header.section}'s body comes before its header`);
		// the header sits beside its body, inside the same parent section
		assert.deepStrictEqual(header.chain, body.chain, `${header.section} header and body are not siblings`);
		// and nothing else opens between them
		const between = [...parsed.headers, ...parsed.bodies].filter(
			(x) => x.index > header.index && x.index < body.index,
		);
		assert.deepStrictEqual(between, [], `something sits between the ${header.section} header and body`);
	}
});

test("the top-level sections come in the planned order", () => {
	const top = parsed.headers.filter((h) => h.chain.length === 0).map((h) => h.section);
	assert.deepStrictEqual(top, TOP_SECTIONS);
	const subs = parsed.headers
		.filter((h) => h.chain.length > 0)
		.map((h) => `${h.chain.join(" > ")} > ${h.section}`);
	assert.deepStrictEqual(subs, ["golden > legacy", "alignment > advanced"]);
});

test("each field is under the section the plan puts it in", () => {
	const where = {};
	for (const field of parsed.fields) where[field.id] = field.chain.join(" > ");
	const expect = {
		golden: ["name", "goldenPath", "workingSize", "profileDir", "barcodeRegions",
			"trainTransform", "trainNuisance"],
		"golden > legacy": ["transformFilePath", "nuisancePath"],
		ink: ["threshold", "thresholdMode", "sauvolaRadius", "sauvolaK", "inkMargin"],
		alignment: ["alignSearch", "localAlign", "localAlignTile", "localAlignMax",
			"mismatchScore", "minCoverage"],
		"alignment > advanced": ["scaleSearchMin", "scaleSearchMax", "scaleSearchSteps",
			"maxAspect", "aspectSteps", "maxAngleDeg", "angleSteps", "alignCandidates",
			"workers", "nativeFastAlign", "nativeAlignSeed"],
		position: ["scaleFilePath", "positionToleranceXMm", "positionToleranceYMm",
			"positionToleranceXPx", "positionToleranceYPx", "positionToleranceAngleDeg"],
		blemish: ["printTolerance", "backgroundTolerance", "edgeMargin", "blockSize",
			"blockThreshold", "failThreshold", "failRatio", "printMissingFraction",
			"noveltyThreshold", "toneThreshold", "toneMargin", "toneMarginAuto",
			"speckThreshold", "speckMinArea", "speckMaxCount", "speckMaxArea"],
		output: ["outputHeatmap", "outputPrintHeatmap", "outputBackgroundHeatmap",
			"outputToneHeatmap", "outputSpeckHeatmap", "heatmapFormat", "heatmapQuality",
			"debugStages", "previewEnabled", "previewWidth"],
	};
	const listed = Object.values(expect).flat();
	assert.deepStrictEqual([...listed].sort(), [...IDS_BEFORE_SECTIONS].sort(), "the table below misses a field");
	for (const [chain, ids] of Object.entries(expect)) {
		for (const id of ids) {
			assert.strictEqual(where[id], chain, `${id} is under "${where[id]}", expected "${chain}"`);
		}
	}
	// and within a section the order is the planned one
	for (const [chain, ids] of Object.entries(expect)) {
		const order = parsed.fields.filter((f) => f.chain.join(" > ") === chain).map((f) => f.id);
		assert.deepStrictEqual(order, ids, `order inside ${chain}`);
	}
	assert.strictEqual(innermost(parsed.fields.find((f) => f.id === "nuisancePath")), "legacy");
});

test("the rows the script reaches by id are still in the template", () => {
	for (const id of [
		"golden-compare-preview-width-row",
		"golden-compare-barcode-regions-row",
		"golden-compare-barcode-regions-hint",
	]) {
		assert.ok(TEMPLATE.includes(`id="${id}"`), `${id} is gone`);
	}
});

test("no `defaults:` text before the editor script's own defaults block", () => {
	// editorDefaults and labelCropExamples both take the first `defaults:`
	// in the file; one in a hint or comment would be read as the block
	const script = html.indexOf('<script type="text/javascript">');
	assert.ok(script > 0, "no editor script");
	assert.strictEqual(html.slice(0, script).indexOf("defaults:"), -1);
	assert.ok(html.indexOf("defaults:") > script);
});
