/**
 * Just enough DOM to run a node's `oneditprepare` under `node --test`.
 *
 * The line-finder editor is now a real piece of software - a zoomable
 * viewer with drag, resize, rotate and nudge - and none of it was
 * reachable by a test, because it lives inside an .html file and needs a
 * document and a canvas. Wiring up jsdom would not help either: it has
 * no 2D context, and the interesting logic here *is* the coordinate
 * arithmetic behind the drawing.
 *
 * So this is a deliberately small stand-in: elements that remember their
 * listeners, a canvas context that records the calls made to it, and
 * enough of `window` for the viewer to attach to. It models the browser
 * closely enough to catch what actually goes wrong in this kind of code -
 * bad screen/image coordinate conversions, state that survives a Cancel,
 * a handler that throws - and no more.
 */

class FakeElement {
	constructor(tag, id) {
		this.tagName = String(tag || "div").toUpperCase();
		this.id = id || "";
		this.style = { cssText: "", setProperty() {} };
		this.children = [];
		this.parent = null;
		this.listeners = {};
		this.textContent = "";
		this.value = "";
		this.checked = false;
		this.title = "";
		this.type = "";
		this.files = null;
		this.rect = { left: 0, top: 0, width: 900, height: 600 };
		this.clientWidth = 900;
		this.clientHeight = 600;
		// a canvas has an intrinsic pixel size as well as a CSS one, and code
		// that scales by it divides by NaN if this is missing
		this.width = 300;
		this.height = 150;
		this.removed = false;
		this.focused = false;
	}
	addEventListener(type, fn) {
		(this.listeners[type] ||= []).push(fn);
	}
	removeEventListener(type, fn) {
		this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
	}
	/** Fire a listener the way a browser event would, defaults filled in. */
	dispatch(type, event = {}) {
		const ev = {
			type,
			target: this,
			preventDefault() {},
			stopPropagation() {},
			...event,
		};
		for (const fn of this.listeners[type] || []) fn(ev);
		return ev;
	}
	dispatchEvent(ev) {
		return this.dispatch(ev.type, ev);
	}
	append(...nodes) {
		for (const n of nodes) this.appendChild(n);
	}
	appendChild(node) {
		node.parent = this;
		this.children.push(node);
		return node;
	}
	/** Swap every child for the given nodes, the way a list redraw does. */
	replaceChildren(...nodes) {
		for (const c of this.children) c.parent = null;
		this.children = [];
		for (const n of nodes) this.appendChild(n);
	}
	remove() {
		this.removed = true;
		if (this.parent) {
			this.parent.children = this.parent.children.filter((c) => c !== this);
			this.parent = null;
		}
	}
	contains(node) {
		if (node === this) return true;
		return this.children.some((c) => c.contains && c.contains(node));
	}
	getBoundingClientRect() {
		return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
	}
	focus() {
		this.focused = true;
	}
	click() {
		this.dispatch("click");
	}
	setPointerCapture() {}
	releasePointerCapture() {}
	hasPointerCapture() {
		return true;
	}
	getContext() {
		this.ctx ||= new FakeContext(this);
		return this.ctx;
	}
	toDataURL() {
		return "data:,";
	}
	/** Every element in this subtree, self included. */
	descendants() {
		return this.children.reduce((acc, c) => acc.concat(c.descendants ? c.descendants() : [c]), [this]);
	}
	findButton(label) {
		return this.descendants().find(
			(e) => e.tagName === "BUTTON" && String(e.textContent).includes(label),
		);
	}
}

/** A 2D context that records what it was asked to draw. */
class FakeContext {
	constructor(canvas) {
		this.canvas = canvas;
		this.calls = [];
		this.fillStyle = "";
		this.strokeStyle = "";
		this.lineWidth = 1;
		this.lineJoin = "";
		this.font = "";
		this.textAlign = "";
		this.imageSmoothingEnabled = true;
		this.imageSmoothingQuality = "";
		for (const op of [
			"clearRect", "fillRect", "strokeRect", "fillText", "strokeText", "drawImage",
			"beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke",
			"arc", "setLineDash", "save", "restore", "translate", "scale",
			"setTransform", "rotate", "clip", "quadraticCurveTo",
		]) {
			this[op] = (...args) => {
				this.calls.push({ op, args });
			};
		}
	}
	createPattern() {
		return { pattern: true };
	}
	measureText(t) {
		return { width: String(t).length * 6 };
	}
	ops() {
		return this.calls.map((c) => c.op);
	}
}

/**
 * Build a document/window pair, evaluate a node's editor <script>, and
 * hand back the registered type plus the fakes to poke at.
 *
 * Unknown ids are created on demand: the editor assumes its own markup
 * exists, and enumerating every input here would only duplicate the
 * template without testing anything.
 */
function makeEditorEnv({ script, imageSize = { width: 800, height: 600 } } = {}) {
	const byId = new Map();
	const notifications = [];
	const created = [];

	const document = {
		getElementById(id) {
			if (!byId.has(id)) byId.set(id, new FakeElement(id.includes("canvas") ? "canvas" : "div", id));
			return byId.get(id);
		},
		createElement(tag) {
			const el = new FakeElement(tag);
			created.push(el);
			return el;
		},
		createElementNS(_ns, tag) {
			return document.createElement(tag);
		},
		body: new FakeElement("body", "body"),
	};

	const windowListeners = {};
	const window = {
		devicePixelRatio: 2,
		addEventListener(type, fn) {
			(windowListeners[type] ||= []).push(fn);
		},
		removeEventListener(type, fn) {
			windowListeners[type] = (windowListeners[type] || []).filter((f) => f !== fn);
		},
		dispatch(type, event = {}) {
			const ev = { type, preventDefault() {}, stopPropagation() {}, ...event };
			for (const fn of [...(windowListeners[type] || [])]) fn(ev);
			return ev;
		},
		listenerCount(type) {
			return (windowListeners[type] || []).length;
		},
	};

	class FakeImage {
		set src(value) {
			this._src = value;
			this.naturalWidth = imageSize.width;
			this.naturalHeight = imageSize.height;
			if (this.onload) this.onload();
		}
		get src() {
			return this._src;
		}
	}

	const RED = {
		validators: { number: () => () => true },
		notify(message, kind) {
			notifications.push({ message, kind });
		},
		comms: { subscribe() {}, publish() {} },
		nodes: {
			registerType(name, def) {
				RED.registered = { name, def };
			},
		},
	};

	// counted rather than recorded: what a test wants to know is that
	// every URL made was revoked again
	const URL = {
		created: 0,
		revoked: 0,
		createObjectURL() {
			URL.created++;
			return "blob:fake";
		},
		revokeObjectURL() {
			URL.revoked++;
		},
	};

	new Function("RED", "document", "window", "Image", "URL", script)(
		RED,
		document,
		window,
		FakeImage,
		URL,
	);

	return {
		RED,
		def: RED.registered.def,
		document,
		window,
		URL,
		byId,
		created,
		notifications,
		field: (id) => document.getElementById("node-input-" + id),
		/** The topmost element appended straight to <body> - the modal overlay. */
		overlay: () => document.body.children[document.body.children.length - 1],
	};
}

module.exports = { FakeElement, FakeContext, makeEditorEnv };
