/**
 * Main-thread client for the inspection pipeline.
 *
 * Why this exists: `compareFrame` is ~600ms of CPU, and Node-RED has one
 * thread. Before this, an unpinned frame blocked the runtime's event loop
 * for 1499ms - measured - which stalls every other flow in the instance,
 * the editor websocket, HTTP endpoints and MQTT keepalives along with it.
 * Moving the pipeline into a worker takes the main thread's share of a
 * frame to roughly 12ms.
 *
 * It does not make a frame faster. A 600ms frame is still 600ms; it stops
 * being 600ms of frozen runtime.
 *
 * One inspector per process, spawned on first use and never torn down -
 * the same decision lib/pool.js makes, for the same reason: a respawn
 * costs a worker start plus a ~280ms re-prepare of the golden, which a
 * redeploy would otherwise pay on its first frame. It is unref()'d, so an
 * idle inspector never holds the process open.
 *
 * The nested worker pool lives inside the inspector, not here.
 */

"use strict";

const path = require("node:path");
const { HAS_SAB } = require("./shared.js");
const core = require("./inspectorCore.js");

const WORKER_PATH = path.join(__dirname, "inspectorWorker.js");

let Worker = null;
try {
	({ Worker } = require("node:worker_threads"));
} catch {
	Worker = null;
}

/**
 * Inline means calling the same core functions on this thread instead of
 * in a worker. It is a fallback, not a second implementation - the
 * verdict cannot differ, because it is the same code. What *does* differ
 * is everything around the call: inline keeps real Buffers and the
 * original Error objects, where the worker path gets structured clones of
 * both. That is why the node-level tests run in both modes.
 */
const INLINE =
	process.env.GOLDEN_COMPARE_INLINE === "1" || !HAS_SAB || Worker === null;

let worker = null;
let pending = null;
let nextId = 1;

function spawn() {
	const w = new Worker(WORKER_PATH);
	const waiting = new Map();

	const rejectAll = (err) => {
		if (waiting.size === 0) return;
		const entries = Array.from(waiting.values());
		waiting.clear();
		w.unref();
		for (const entry of entries) entry.reject(err);
	};

	w.on("message", (msg) => {
		const entry = msg == null ? undefined : waiting.get(msg.id);
		if (!entry) return; // a reply for a request already rejected
		waiting.delete(msg.id);
		if (waiting.size === 0) w.unref();
		if (msg.error) {
			const err = new Error(msg.error.message);
			err.name = msg.error.name || "Error";
			if (msg.error.stack) err.stack = msg.error.stack;
			entry.reject(err);
		} else {
			entry.resolve(msg);
		}
	});
	const drop = (err) => {
		if (worker === w) {
			worker = null;
			pending = null;
		}
		rejectAll(err);
	};
	w.on("error", (err) => {
		drop(err);
		w.terminate();
	});
	w.on("exit", (code) =>
		drop(new Error(`inspector exited (code ${code}) before answering`)),
	);
	// idle: the listeners above would otherwise ref the port and keep the
	// process alive - the same trap lib/pool.js documents
	w.unref();
	worker = w;
	pending = waiting;
	return w;
}

function send(op, message) {
	const w = worker || spawn();
	const waiting = pending;
	return new Promise((resolve, reject) => {
		const id = nextId++;
		if (waiting.size === 0) w.ref();
		waiting.set(id, { resolve, reject });
		try {
			w.postMessage({ ...message, id, op });
		} catch (err) {
			waiting.delete(id);
			if (waiting.size === 0) w.unref();
			reject(err);
		}
	});
}

const call = (op, message) =>
	INLINE ? core[op](message) : send(op, message);

/**
 * Structured clone turns a Buffer into a plain Uint8Array, and the
 * difference is not academic: msg.printHeatmap is documented as a PNG
 * Buffer and wired straight into an image viewer in the demo flow, and
 *
 *   Buffer.toString("base64")     -> "AQID+g=="
 *   Uint8Array.toString("base64") -> "1,2,3,250"
 *
 * so the output would be silently wrong rather than an error. Re-wrapping
 * shares the same memory; it does not copy.
 *
 * The null checks matter as much as the wrap: heatmaps are null unless
 * asked for, and `stages` is null unless debugStages is on - which is the
 * default, so an unguarded version would fail on the first frame of a
 * default-configured flow.
 */
function asBuffer(value) {
	if (value == null) return value;
	if (Buffer.isBuffer(value)) return value;
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function rewrapResult(result) {
	if (!result) return result;
	if (result.printBlemish) {
		result.printBlemish.heatmap = asBuffer(result.printBlemish.heatmap);
	}
	if (result.backgroundBlemish) {
		result.backgroundBlemish.heatmap = asBuffer(
			result.backgroundBlemish.heatmap,
		);
	}
	if (result.stages) {
		for (const key of Object.keys(result.stages)) {
			result.stages[key] = asBuffer(result.stages[key]);
		}
	}
	return result;
}

/** Ensure a prepared golden exists for this key. Pass `golden` only after
 * a first call has answered `needGolden` - the bytes are expensive to
 * produce and the store usually already has them. */
async function prepare({ cacheKey, cfg, golden }) {
	return call("prepare", { cacheKey, cfg, golden });
}

async function inspect({ cacheKey, cfg, frame }) {
	const reply = await call("inspect", { cacheKey, cfg, frame });
	if (reply.needGolden) return reply;
	return { ...reply, result: rewrapResult(reply.result) };
}

async function calibrate({ cfg, image }) {
	return call("calibrate", { cfg, image });
}

/** Tests only. The inspector is process-wide and deliberately survives a
 * redeploy. */
function shutdown() {
	const w = worker;
	worker = null;
	pending = null;
	if (w) w.terminate();
	core.clear();
}

module.exports = { prepare, inspect, calibrate, shutdown, INLINE };
