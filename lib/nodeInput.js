/**
 * Input handling shared by the Node-RED nodes: bounded numeric settings
 * and the guarded image loader for msg.payload / msg.golden in every form
 * a flow hands over (Buffer / Uint8Array / ArrayBuffer, a file path, or an
 * object carrying `data` / `buffer` / `path`).
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;

// Image inputs are capped before anything copies, hashes, or reads
// them: an unbounded buffer would be copied and SHA-1'd on every
// message for no inspection value, and an unbounded path read would
// hang or OOM on a special file like /dev/zero. 512MB is far past the
// largest capture this pipeline is meant for (a 23MP framebuffer is
// ~90MB).
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

function clampInt(value, fallback, [min, max]) {
	const n = parseInt(value, 10);
	if (Number.isNaN(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function clampFloat(value, fallback, [min, max]) {
	const n = parseFloat(value);
	if (Number.isNaN(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function pickMode(value, fallback, allowed) {
	return allowed.includes(value) ? value : fallback;
}

function isBytes(v) {
	return Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof ArrayBuffer;
}

function assertUnderCap(data, label) {
	if (data.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(
			`${label} is ${data.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte cap`,
		);
	}
}

/**
 * Open an image file through one handle: open -> fstat -> guards. The
 * guards are the point. A pathExists() then readFile() pair is a race
 * (the file can be swapped between the two), and an unguarded path read
 * lets a flow point msg.golden at /dev/zero and hang the node on an
 * endless read. Returns null when the path does not exist, so callers
 * can keep distinguishing "missing" from "refused"; otherwise the open
 * handle with the stat the caller may fingerprint from. The caller
 * closes the handle.
 */
async function openRegularFile(p, label) {
	let fd;
	try {
		fd = await fsp.open(p, fs.constants.O_RDONLY);
	} catch (err) {
		if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
		throw err;
	}
	try {
		const stat = await fd.stat();
		if ((stat.mode & fs.constants.S_IFMT) !== fs.constants.S_IFREG) {
			throw new Error(
				`${label} is not a regular file: "${p}" - refusing to read it`,
			);
		}
		if (stat.size > MAX_IMAGE_BYTES) {
			throw new Error(
				`${label} is ${stat.size} bytes, above the ${MAX_IMAGE_BYTES}-byte cap: "${p}"`,
			);
		}
		return { handle: fd, mtimeMs: stat.mtimeMs, size: stat.size };
	} catch (err) {
		await fd.close();
		throw err;
	}
}

/** open -> fstat -> guards -> read -> close; the bytes, or null when the
 * path does not exist. */
async function readRegularFile(p, label) {
	const open = await openRegularFile(p, label);
	if (!open) return null;
	try {
		return await open.handle.readFile();
	} finally {
		await open.handle.close();
	}
}

/** Load an image source to a Buffer, with every guard above applied. */
async function resolveImage(source, label) {
	if (source == null || source === "") {
		throw new Error(`${label} is empty`);
	}
	if (isBytes(source)) {
		assertUnderCap(source, label);
		return Buffer.from(source);
	}
	if (typeof source === "string") {
		const file = await readRegularFile(source, label);
		if (!file) throw new Error(`${label} does not exist on disk: "${source}"`);
		return file;
	}
	if (typeof source === "object") {
		const data = source.data || source.buffer;
		if (isBytes(data)) {
			assertUnderCap(data, label);
			return Buffer.from(data);
		}
		if (typeof source.path === "string") {
			const file = await readRegularFile(source.path, label);
			if (file) return file;
		}
		throw new Error(
			`${label} object must contain "data"/"buffer" or an existing "path"`,
		);
	}
	throw new Error(`unsupported ${label} type: ${typeof source}`);
}

module.exports = {
	MAX_IMAGE_BYTES,
	clampInt,
	clampFloat,
	pickMode,
	isBytes,
	assertUnderCap,
	openRegularFile,
	readRegularFile,
	resolveImage,
};
