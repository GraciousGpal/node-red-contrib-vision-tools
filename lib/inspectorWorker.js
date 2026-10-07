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

const { parentPort, isMarkedAsUntransferable } = require("node:worker_threads");
const core = require("./inspectorCore.js");

/**
 * Post a reply, moving the stores in `transfer` rather than copying them.
 * A store sharp handed out is marked untransferable - the frame's grey
 * stage is one - and a single one in the list fails the whole post, so
 * those are left to be copied. Where Node cannot say (before 21), or a
 * store is unmovable some other way, the post fails before anything is
 * detached and the reply goes as a copy: slower, never wrong.
 */
function post(reply, transfer) {
	const movable =
		transfer && typeof isMarkedAsUntransferable === "function"
			? transfer.filter((store) => !isMarkedAsUntransferable(store))
			: [];
	if (movable.length) {
		try {
			parentPort.postMessage(reply, movable);
			return;
		} catch {
			// sent as a copy below
		}
	}
	parentPort.postMessage(reply);
}

parentPort.on("message", async (msg) => {
	const { id, op } = msg;
	try {
		const handler = core[op];
		if (typeof handler !== "function") {
			throw new Error(`unknown inspector op: ${op}`);
		}
		// a handler with nothing to say (clear) returns undefined
		const { transfer, ...reply } = (await handler(msg)) || {};
		post({ id, ...reply }, transfer);
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
