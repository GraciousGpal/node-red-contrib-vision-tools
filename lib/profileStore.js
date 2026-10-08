/**
 * Per-golden profile files: everything trained or derived for one artwork,
 * in one place, chosen by the artwork.
 *
 * Until now each kind of trained state had its own path on the node: the
 * pinned transform in `transformFilePath`, the nuisance map in
 * `nuisancePath`. Both records carry the golden's content hash and are
 * refused when the golden changes, which is right, but it means a rig that
 * runs two artworks through one node holds trained state for at most one of
 * them. Every product change silently drops back to a full search with no
 * nuisance map, and training product B overwrites what was trained for A.
 * Each new kind of training (register slack went into the transform file,
 * barcode regions would have been a third file) made that worse.
 *
 * So the unit of storage is the golden, not the node: `<dir>/<id>.json`.
 * The id is, in order, a name the flow gives (`msg.profile`), the stem of
 * the golden's source file (on the rig a `file in` node reads
 * `/data/Inspection/pdf/Demo_Good_60.pdf` and the profile is
 * `demo_good_60.json` - a name an operator recognises in a directory
 * listing), and only when the golden arrived as bare bytes, a prefix of its
 * content hash. The hash is the check, not the name: every section carries
 * the golden's content key and is validated strictly against it, so a
 * revised artwork saved under the same filename lands on the same profile
 * and has its sections refused until it is retrained, rather than being
 * inspected against the old artwork's training. A file holds independent
 * sections (`transform`, `nuisance`, `barcodes`, ...), each keeping its
 * own identity fields so the existing validators in lib/transformFile.js
 * and lib/nuisanceMap.js still guard it.
 *
 * Writes are serialised per path. Node-RED runs input handlers
 * concurrently, and transform training, nuisance training and barcode
 * derivation can all land on the same file within one frame's time: a
 * plain read-modify-write would let the last writer silently erase the
 * section the other one just wrote. A module-level chain of promises per
 * absolute path orders them, and each writer re-reads the file inside the
 * lock so it merges onto what the previous one wrote rather than onto what
 * it saw before waiting. That covers one process. Separate Node-RED
 * processes sharing a profile directory are NOT serialised against each
 * other; give each its own directory.
 *
 * Each write goes to a temporary file beside the target and is renamed
 * over it, so a reader never sees half a JSON document and a crash
 * mid-write leaves the old profile intact. On Windows a rename onto a file
 * another handle has open fails with EPERM/EACCES/EBUSY for as long as the
 * handle lives - a reader, an editor, an antivirus scan - so the rename is
 * retried briefly there; if it still fails the temporary file is removed
 * rather than left to accumulate.
 *
 * Readers are expected to cache a profile and revalidate it with one
 * fs.stat per message. The cache key is (mtimeMs, size), not mtime alone:
 * two writes inside the filesystem's timestamp resolution keep the same
 * mtime, and a section rewritten with different content nearly always
 * changes the size. Both readProfile and writeProfileSection return the
 * stat that matches the content they return, so a node can hand its own
 * write's result straight to its cache and never read back stale.
 */

"use strict";

const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const VERSION = 1;
const NAME_MAX = 64;

// Base names Windows refuses as files whatever the extension: `con.json`
// cannot be created there. A profile directory on a Windows dev box or a
// shared drive must not trip over a product called "Aux".
const RESERVED = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

// The top-level keys the store owns. A section by one of these names would
// overwrite the profile's own bookkeeping.
const RESERVED_SECTIONS = new Set(["version", "golden", "updatedAt"]);

// sha1:<40 hex>[:WxHxC], the form golden-compare's goldenContentKey() makes.
const CONTENT_KEY = /^sha1:([0-9a-f]{40})(?::(\d+x\d+x\d+))?$/i;

// Windows rename retries: the handle blocking it is usually a reader that
// lets go within a few ms. 5 tries, 20..100 ms apart, ~300 ms in total.
const RENAME_RETRIES = 5;
const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * A profile *name*, never a path. `msg.profile` comes from the flow, and a
 * value like "../../etc/x" or "C:\\x" must not be able to choose where the
 * file is written, so everything outside [a-z0-9._-] becomes "_" and
 * leading dots go (no hidden files, no "..").
 *
 * @param {unknown} name
 * @returns {string|null} null when nothing usable is left
 */
function sanitizeProfileName(name) {
	if (typeof name !== "string") return null;
	let s = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "_")
		.replace(/^\.+/, "")
		.slice(0, NAME_MAX);
	if (!s) return null;
	const base = s.split(".")[0];
	if (RESERVED.has(base)) s = `_${s}`.slice(0, NAME_MAX);
	return s;
}

/**
 * The profile name a golden's source file gives: its basename without the
 * extension, sanitised. Both separators are split on whatever the platform,
 * because the path may have been typed on a Windows editor and be read in
 * a Linux container. Only the last extension goes ("label.v2.pdf" keeps
 * "label.v2"). Page 1 and page 17 of one artwork PDF are different labels,
 * so a page above 1 is appended as "-p<page>"; page 1 is the plain stem so
 * a single-page PDF and its PNG export name the same profile.
 *
 * @param {unknown} source a path or a bare file name
 * @param {unknown} [page]
 * @returns {string|null}
 */
function sourceStem(source, page) {
	if (typeof source !== "string") return null;
	const base = source.trim().split(/[\\/]/).pop() || "";
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const n = Number(page);
	const suffix = Number.isInteger(n) && n > 1 ? `-p${n}` : "";
	const clean = sanitizeProfileName(stem);
	if (!clean) return null;
	return clean.slice(0, NAME_MAX - suffix.length) + suffix;
}

/**
 * The profile id and what chose it: the flow's explicit name, else the
 * golden's source file stem (see sourceStem), else the first 16 hex of the
 * content hash (64 bits - a collision between the artworks one rig runs is
 * not a practical concern) plus the raw geometry when there is one, since
 * the same bytes are a different image under another width/height/channels.
 *
 * @param {{ name?: unknown, source?: unknown, page?: unknown, contentKey?: string|null }} input
 * @returns {{ id: string, namedBy: "profile" | "source" | "content" }}
 */
function profileIdFor({ name, source, page, contentKey } = {}) {
	const named = sanitizeProfileName(name);
	if (named) return { id: named, namedBy: "profile" };
	const stem = sourceStem(source, page);
	if (stem) return { id: stem, namedBy: "source" };
	const m = typeof contentKey === "string" && CONTENT_KEY.exec(contentKey);
	if (m) {
		const id = m[1].slice(0, 16).toLowerCase();
		return { id: m[2] ? `${id}-${m[2]}` : id, namedBy: "content" };
	}
	throw new Error(
		"profile: no usable profile name, source file name or golden content key " +
			`(got name ${JSON.stringify(name)}, source ${JSON.stringify(source)}, ` +
			`contentKey ${JSON.stringify(contentKey)})`,
	);
}

function profilePath(dir, id) {
	return path.join(dir, `${id}.json`);
}

function statOf(st) {
	return { mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * Read a profile. Returns null when there is no file (the ordinary
 * untrained case), `{ error }` when one exists but cannot be used, and
 * `{ profile, stat }` otherwise. The stat comes from the same open handle
 * the content is read through, so a rename landing between the two cannot
 * pair new content with an old (mtimeMs, size).
 *
 * @param {string} filePath
 */
async function readProfile(filePath) {
	if (!filePath) return null;
	let fh;
	let text;
	let st;
	try {
		fh = await fsp.open(filePath, "r");
		st = await fh.stat();
		text = await fh.readFile("utf8");
	} catch (err) {
		if (err && err.code === "ENOENT") return null;
		return { error: `profile ${filePath} is not readable: ${err.message}` };
	} finally {
		if (fh) await fh.close().catch(() => {});
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return {
			error: `profile ${filePath} is not readable JSON: ${err.message}`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: `profile ${filePath} is not a JSON object` };
	}
	if (parsed.version !== VERSION) {
		return {
			error: `profile ${filePath} is version ${parsed.version}, this build reads ${VERSION}`,
		};
	}
	return { profile: parsed, stat: statOf(st) };
}

// absolute path -> the tail of that path's write chain
const writeChains = new Map();

function serialise(filePath, fn) {
	// Windows paths are case-insensitive: "C:/P/x.json" and "c:/p/x.json"
	// are one file, and two chains for it would lose a section between them
	const abs = path.resolve(filePath);
	const key = process.platform === "win32" ? abs.toLowerCase() : abs;
	const prev = writeChains.get(key) || Promise.resolve();
	// a failed write must not wedge every later one behind it
	const run = prev.catch(() => {}).then(fn);
	writeChains.set(key, run);
	const clear = () => {
		if (writeChains.get(key) === run) writeChains.delete(key);
	};
	run.then(clear, clear);
	return run;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(from, to) {
	for (let attempt = 0; ; attempt++) {
		try {
			await fsp.rename(from, to);
			return;
		} catch (err) {
			const retry =
				process.platform === "win32" &&
				RETRY_CODES.has(err && err.code) &&
				attempt < RENAME_RETRIES;
			if (!retry) throw err;
			await delay(20 * (attempt + 1)); // 20, 40, 60, 80, 100 ms
		}
	}
}

/**
 * Set one section of a profile, keeping every other section as it is on
 * disk at the moment of writing. `golden` ({ contentKey, key, label,
 * source, page, namedBy, nativeWidth, nativeHeight }) is merged into the
 * profile's golden record; fields left undefined keep their stored value
 * (null is stored - "no page" is a value).
 *
 * A profile that exists but cannot be read (corrupt, or written by a newer
 * build) is refused rather than replaced: replacing it would discard every
 * section in it, and a newer build's file is not this build's to rewrite.
 *
 * @param {string} filePath
 * @param {string} section
 * @param {object} record
 * @param {object} [golden]
 * @returns {Promise<{ profile: object, stat: { mtimeMs: number, size: number } }>}
 */
function writeProfileSection(filePath, section, record, golden) {
	if (!filePath) {
		return Promise.reject(new Error("profile: no file path to write to"));
	}
	if (
		typeof section !== "string" ||
		!section ||
		RESERVED_SECTIONS.has(section)
	) {
		return Promise.reject(
			new Error(`profile: ${JSON.stringify(section)} is not a section name`),
		);
	}
	return serialise(filePath, async () => {
		const current = await readProfile(filePath);
		if (current && current.error) {
			throw new Error(
				`${current.error} - not overwriting it; fix or remove the file`,
			);
		}
		const prior = current ? current.profile : {};
		const mergedGolden = { ...(prior.golden || {}) };
		for (const [k, v] of Object.entries(golden || {})) {
			if (v !== undefined) mergedGolden[k] = v;
		}
		const sections = { ...prior };
		for (const k of RESERVED_SECTIONS) delete sections[k];
		const profile = {
			version: VERSION,
			golden: mergedGolden,
			...sections,
			[section]: record,
			updatedAt: new Date().toISOString(),
		};

		await fsp.mkdir(path.dirname(filePath), { recursive: true });
		const rand = crypto.randomBytes(6).toString("hex");
		const tmp = `${filePath}.tmp-${process.pid}-${rand}`;
		try {
			await fsp.writeFile(tmp, JSON.stringify(profile, null, 2));
			await renameWithRetry(tmp, filePath);
		} catch (err) {
			await fsp.unlink(tmp).catch(() => {});
			throw err;
		}
		const st = await fsp.stat(filePath);
		return { profile, stat: statOf(st) };
	});
}

module.exports = {
	VERSION,
	sanitizeProfileName,
	sourceStem,
	profileIdFor,
	profilePath,
	readProfile,
	writeProfileSection,
};
