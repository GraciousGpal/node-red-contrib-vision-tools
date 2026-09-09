/**
 * Worker side of the inspector: a thin messaging wrapper around
 * lib/inspectorCore.js.
 *
 * Nothing but plumbing belongs here. The core is what runs on the
 * Node-RED thread when worker threads are unavailable, so any logic that
 * crept in here would be logic the inline path does not have.
 *
 * Replies carry the id of the request they answer, for the reason
 * lib/pool.js documents at length: settling on "the next reply" lets two
 * concurrent requests take each other's answers.
 */

"use strict";

const { parentPort } = require("node:worker_threads");
const core = require("./inspectorCore.js");

parentPort.on("message", async (msg) => {
	const { id, op } = msg;
	try {
		const handler = core[op];
		if (typeof handler !== "function") {
			throw new Error(`unknown inspector op: ${op}`);
		}
		parentPort.postMessage({ id, ...(await handler(msg)) });
	} catch (err) {
		// name and stack are carried explicitly: structured clone keeps
		// neither an Error's own properties nor its class, so anything the
		// caller wants to see has to be named here.
		parentPort.postMessage({
			id,
			error: {
				message: err && err.message ? err.message : String(err),
				name: err && err.name ? err.name : "Error",
				stack: err && err.stack ? err.stack : undefined,
			},
		});
	}
});
