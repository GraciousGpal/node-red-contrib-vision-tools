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
	assert.deepStrictEqual([...listed].sort(), [...IDS_BEFORE_SECTIONS].sort(), "the table misses or repeats a field");
	// grouped by the chain each field sits in: a field moved, dropped,
	// added or repeated changes a group, and a field outside every section
	// lands under "", which the table has no entry for
	const actual = {};
	for (const field of parsed.fields) (actual[field.chain.join(" > ")] ||= []).push(field.id);
	for (const ids of Object.values(actual)) ids.sort();
	const planned = Object.fromEntries(Object.entries(expect).map(([chain, ids]) => [chain, [...ids].sort()]));
	assert.deepStrictEqual(actual, planned);
});
