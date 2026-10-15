/**
 * Just enough DOM to run a node's flow-canvas preview under `node --test`.
 *
 * The preview panel is a foreignObject appended inside the node's own
 * <g>, whose origin is the node's top-left corner (Node-RED translates the
 * group to x - w/2, y - h/2 and keeps node.x/node.y as the centre).
 * Getting that wrong draws the panel over the node instead of under it,
 * and nothing errors - so the editor script is lifted out of the node's
 * .html and run against a stub RED that hands back the subscribe callback.
 *
 * This is a different fake from helpers/fakeEditorDom.js, which models the
 * edit dialog (listeners, a recording 2D context, window events); a
 * preview only builds a tree of elements under the node's group.
 */

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/** The editor <script> body of a node's .html in the package root. */
function editorScript(htmlFile) {
	const html = fs.readFileSync(path.join(__dirname, "..", "..", htmlFile), "utf8");
	const m = html.match(/<script type="text\/javascript">\n([\s\S]*)\n<\/script>\s*$/);
	assert.ok(m, `could not find the editor script in ${htmlFile}`);
	return m[1];
}

class El {
	constructor(tag) {
		this.tag = tag;
		this.id = "";
		this.attrs = {};
		this.style = {};
		this.children = [];
		this.parent = null;
		this.textContent = "";
	}
	setAttribute(name, value) {
		this.attrs[name] = value;
	}
	appendChild(child) {
		child.parent = this;
		this.children.push(child);
		return child;
	}
	remove() {
		if (this.parent) {
			this.parent.children = this.parent.children.filter((c) => c !== this);
			this.parent = null;
		}
	}
	find(pred) {
		if (pred(this)) return this;
		for (const c of this.children) {
			const hit = c.find(pred);
			if (hit) return hit;
		}
		return null;
	}
	findAll(pred, out = []) {
		if (pred(this)) out.push(this);
		for (const c of this.children) c.findAll(pred, out);
		return out;
	}
}

// never fires onload: the drawing onto the preview is not what is under test
class StubImage {}

/**
 * Evaluate `script` against a stub RED whose RED.nodes.node(id) is `node`,
 * and hand back the node's <g> plus publish(data), which fires the
 * `topic` subscription the way RED.comms would.
 *
 * Options, for a preview that needs more of the browser:
 *  - globals: extra names the script sees (Image, $); only these are bound,
 *    so a name not given resolves as it would in Node.
 *  - document, RED: extra members merged into the stubs.
 *  - El: the element class createElementNS makes (a subclass of El).
 *
 * getElementById searches the group, then document.body when one is given.
 */
function bootPreview(script, topic, node, { globals = {}, document: docExtra = {}, RED: redExtra = {}, El: Make = El } = {}) {
	const group = new Make("g");
	group.id = node.id;
	const subscriptions = {};
	const document = {
		getElementById(id) {
			return group.find((e) => e.id === id) || (document.body ? document.body.find((e) => e.id === id) : null);
		},
		createElementNS(_ns, tag) {
			return new Make(tag);
		},
		...docExtra,
	};
	const RED = {
		validators: { number: () => () => true },
		comms: {
			subscribe(t, fn) {
				subscriptions[t] = fn;
			},
		},
		nodes: {
			registerType() {},
			node(id) {
				return id === node.id ? node : undefined;
			},
		},
		...redExtra,
	};
	const scope = { RED, document, window: {}, ...globals };
	new Function(...Object.keys(scope), script)(...Object.values(scope));
	const publish = (data) => subscriptions[topic](null, data);
	const panel = () => group.find((e) => e.tag === "foreignObject");
	return { group, publish, panel };
}

module.exports = { editorScript, El, StubImage, bootPreview };
