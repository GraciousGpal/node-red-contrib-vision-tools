/**
 * barcode-locate Node-RED node.
 *
 * Finds and decodes barcodes (1D and 2D) in an image using zxing-wasm, a
 * WebAssembly build of the zxing-cpp engine. Detection and decode logic
 * lives in lib/locate.js so it can be exercised outside Node-RED.
 *
 * The point of this node over just calling zxing-wasm directly on the full
 * image every time: on a fixed camera rig (same assumption
 * golden-compare/checkerboard-calibrate already make - see their docs),
 * barcodes land in roughly the same place shot to shot, so pre-defining
 * where to look and scanning only those regions is 1-2 orders of magnitude
 * faster than scanning the whole frame. "Regions, then full image if
 * nothing found" keeps the whole-image scan available as a safety net
 * (label repositioned, region mis-measured, etc.) without paying its cost
 * on every normal run.
 *
 * Regions come from one of three places, first match wins: msg.regions;
 * with regionSource "profile", the golden's profile file (the barcodes
 * golden-compare found on the artwork, mapped into this payload through
 * the trained transform by lib/goldenRegions.js); else the configured
 * list. The profile file is msg.result.profile.path (golden-compare
 * upstream resolved it), else msg.profile as a name under profileDir,
 * else the configured profilePath. Mapped regions are cached per
 * (profile path, its mtimeMs and size, payload size, calibration and its
 * mtimeMs, pad), so a message costs one fs.stat of the profile (plus one
 * of the calibration when set) and a header read for the payload's size.
 * Every problem with a profile is warned once per profile path and leaves
 * the message with no profile regions - the full-image fallback still
 * runs - rather than failing it.
 *
 * Input (msg.payload): Buffer / Uint8Array / ArrayBuffer with image bytes,
 * a file path string, or an object { data | buffer | path }; bare pixels
 * as { data, width, height, channels } or bytes plus msg.rawInfo, as
 * golden-compare accepts them.
 * Optional per-message overrides: msg.regions (array), msg.mode,
 * msg.profile (a profile name).
 *
 * Output: one message per barcode found, in the order regions were scanned
 * (then, if used, the full-image fallback) - msg.text, msg.format,
 * msg.roi, msg.symbol, msg.regionLabel, msg.regionSource, msg.source
 * ("region"|"fullImage"), msg.expectedText/msg.textMatches (profile
 * regions; null otherwise), msg.decodeMs, msg.timings, msg.payload (a
 * preview crop of that barcode's region). If nothing is found at all,
 * sends one message with msg.text = null.
 */

const fsp = require("fs").promises;
const sharp = require("sharp");
const { locateBarcodes, DEFAULT_FORMATS } = require("./lib/locate.js");
const { resolveImage, rawGeometry, assertRawFits, clampInt, clampFloat, pickMode } = require("./lib/nodeInput.js");
const { formatMs } = require("./lib/formatMs.js");
const profileStore = require("./lib/profileStore.js");
const { mapProfileRegions } = require("./lib/goldenRegions.js");
const { readScaleFile } = require("./lib/scaleFile.js");

// Mapped-region cache entries per node: one per (profile, payload size,
// calibration) combination in use. A rig alternates a handful of
// products, not hundreds.
const REGION_CACHE_MAX = 16;
// Warn-once keys per node; cleared past this so a long-running flow
// cycling through many profile names cannot grow it without bound (the
// worst case is a repeat of a warning already given).
const WARNED_MAX = 256;

module.exports = (RED) => {
	function normalizeRegions(regions) {
		if (!Array.isArray(regions)) return [];
		return regions
			.map((r) => ({
				label: String(r.label || "").trim(),
				x: parseInt(r.x, 10) || 0,
				y: parseInt(r.y, 10) || 0,
				width: parseInt(r.width, 10) || 0,
				height: parseInt(r.height, 10) || 0,
			}))
			.filter((r) => r.width > 0 && r.height > 0);
	}

	function statKey(st) {
		return st ? `${st.mtimeMs}:${st.size}` : "none";
	}

	async function statOrNull(p) {
		try {
			return await fsp.stat(p);
		} catch (err) {
			if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
			throw err;
		}
	}

	function BarcodeLocateNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.mode = config.mode === "regionsOnly" || config.mode === "autoOnly" ? config.mode : "regionsThenAuto";
		node.regions = normalizeRegions(config.regions);
		node.regionSource = pickMode(config.regionSource, "list", ["list", "profile"]);
		node.profilePath = String(config.profilePath || "").trim();
		node.profileDir = String(config.profileDir || "").trim();
		node.scaleFilePath = String(config.scaleFilePath || "").trim();
		node.regionPad = clampFloat(config.regionPad, 0.2, [0, 2]);
		node.regionPadMinPx = clampInt(config.regionPadMinPx, 64, [0, 4000]);

		const enabledFormats = DEFAULT_FORMATS.concat(["EAN8"]).filter((f) => config[f]);
		node.readerOptions = {
			tryHarder: config.tryHarder !== false,
			tryRotate: config.tryRotate !== false,
			maxNumberOfSymbols: 20,
			formats: enabledFormats.length ? enabledFormats : DEFAULT_FORMATS,
		};

		node.regionCache = new Map();
		node.warned = new Set();

		// One warning per (profile path, kind of problem): a profile that is
		// wrong is wrong on every frame, and a warning per frame at line
		// rate buries everything else in the debug sidebar.
		function warnOnce(key, text) {
			if (node.warned.has(key)) return;
			if (node.warned.size >= WARNED_MAX) node.warned.clear();
			node.warned.add(key);
			node.warn(`barcode-locate: ${text}`);
		}

		// The profile file for this message, or null (warned) when there is
		// none to read.
		function profileFileFor(msg) {
			const upstream = msg.result && msg.result.profile;
			if (upstream && typeof upstream.path === "string" && upstream.path) return upstream.path;
			if (msg.profile != null && msg.profile !== "") {
				if (!node.profileDir) {
					warnOnce(
						"no-profile-dir",
						"msg.profile is set but this node has no profile directory to look it up in - " +
							"set Profile directory (msg.profile ignored)",
					);
				} else {
					try {
						const { id } = profileStore.profileIdFor({ name: msg.profile });
						return profileStore.profilePath(node.profileDir, id);
					} catch {
						warnOnce(`bad-name:${String(msg.profile)}`, `msg.profile ${JSON.stringify(msg.profile)} is not a usable profile name (ignored)`);
					}
				}
			}
			if (node.profilePath) return node.profilePath;
			warnOnce(
				"no-profile",
				'region source is "profile" but there is no profile to read: no msg.result.profile.path ' +
					"(golden-compare upstream), no msg.profile, no Profile file configured",
			);
			return null;
		}

		// Read, check and map one profile for one payload size. Returns
		// { regions, warnings: [[key, text]], contentKey, transform, calibration }
		// - every problem is a warning with no regions, never a throw.
		async function buildEntry(file, frame) {
			const none = (key, text, extra = {}) => ({ regions: [], warnings: [[key, text]], contentKey: null, ...extra });
			const read = await profileStore.readProfile(file);
			if (!read) return none("missing", `profile ${file} does not exist (yet) - no regions from it`);
			if (read.error) return none("unreadable", `${read.error} - no regions from it`);
			const { profile } = read;
			// The identity to hold against golden-compare's is the barcodes
			// section's own key, not golden.contentKey: every section write
			// merges the golden record, so after a nuisance training for a
			// revised artwork B the file says B while its barcodes (and
			// transform) are still A's - and A's boxes would be mapped onto
			// B's frames.
			const contentKey = profile.barcodes && profile.barcodes.goldenContentKey ? profile.barcodes.goldenContentKey : null;
			const transform = profile.transform;
			const barcodes = profile.barcodes;
			if (!barcodes || !Array.isArray(barcodes.regions)) {
				return none(
					"no-barcodes",
					`profile ${file} has no barcodes yet - turn on "Barcode regions" in golden-compare, ` +
						"which derives them from the golden",
					{ contentKey },
				);
			}
			if (!transform) {
				return none("no-transform", `profile ${file} has barcodes but no trained transform to place them with - train the transform`, { contentKey });
			}
			if (barcodes.goldenContentKey !== transform.goldenContentKey) {
				return none(
					"section-keys",
					`profile ${file} holds barcodes of one golden and a transform of another; retrain or re-derive`,
					{ contentKey },
				);
			}

			let calibration = null;
			if (node.scaleFilePath) {
				const scale = await readScaleFile(node.scaleFilePath);
				if (!scale) {
					return none("calibration", `calibration ${node.scaleFilePath} does not exist - cannot undo the rectification, no regions`, { contentKey });
				}
				if (scale.error) return none("calibration", `${scale.error} - no regions`, { contentKey });
				if (!scale.homography) {
					return none(
						"calibration",
						`calibration ${node.scaleFilePath} has no homography - re-run checkerboard-calibrate with msg.save:true; no regions`,
						{ contentKey },
					);
				}
				calibration = { homography: scale.homography, nativeWidth: scale.nativeWidth, nativeHeight: scale.nativeHeight };
			}

			const goldenNative = {
				width: barcodes.nativeWidth || (profile.golden && profile.golden.nativeWidth),
				height: barcodes.nativeHeight || (profile.golden && profile.golden.nativeHeight),
			};
			let mapped;
			try {
				mapped = mapProfileRegions({ transform, barcodes, goldenNative }, frame, calibration, {
					pad: node.regionPad,
					padMinPx: node.regionPadMinPx,
				});
			} catch (err) {
				return none("mapping", `profile ${file}: ${err.message.replace(/^goldenRegions: /, "")}`, { contentKey });
			}
			const warnings = mapped.warnings.map((w) => [`map:${w}`, `profile ${file}: ${w}`]);

			// The barcodes are only legible at the camera's resolution: the
			// compare's halved frame read both codes in 23/149 photos, the
			// native one in 149/149. Mapping still proceeds - it is right,
			// just likely to read nothing (or worse, something wrong).
			const tooSmall = frame.width <= transform.frameNativeWidth || (calibration && frame.width < calibration.nativeWidth);
			if (tooSmall) {
				warnings.push([
					"resolution",
					`payload ${frame.width}x${frame.height} is no larger than the frame the compare saw ` +
						`(${transform.frameNativeWidth}x${transform.frameNativeHeight})` +
						(calibration ? ` or smaller than the calibration photo (${calibration.nativeWidth}x${calibration.nativeHeight})` : "") +
						"; if golden-compare already inspects the native camera frame this is expected, otherwise " +
						"decode the native frame - barcodes decode reliably only at the camera's resolution, see Help",
				]);
			}
			return { regions: mapped.regions, warnings, contentKey };
		}

		// A profile that cannot be used is the profile's problem, not the
		// frame's: whatever goes wrong reading it (EACCES, EPERM, a NUL in a
		// path a flow built) is warned once and the message carries on with
		// no profile regions, exactly as for a missing file.
		async function profileRegions(msg, buffer, raw) {
			const file = profileFileFor(msg);
			if (!file) return { regions: [], file: null };
			// outside the try: an unreadable payload is the frame's error and
			// still fails the message, as it would in the decode
			let frame = raw ? { width: raw.width, height: raw.height } : null;
			if (!frame) {
				const meta = await sharp(buffer).metadata();
				frame = { width: meta.width, height: meta.height };
			}
			try {
				return await mappedProfileRegions(msg, frame, file);
			} catch (err) {
				const code = (err && err.code) || (err && err.message) || String(err);
				warnOnce(`${file}|error:${code}`, `profile ${JSON.stringify(file)} cannot be used: ${err && err.message ? err.message : err} - no regions from it`);
				return { regions: [], file };
			}
		}

		async function mappedProfileRegions(msg, frame, file) {
			const [profileStat, scaleStat] = await Promise.all([
				statOrNull(file),
				node.scaleFilePath ? statOrNull(node.scaleFilePath) : null,
			]);
			const key = [
				file,
				statKey(profileStat),
				`${frame.width}x${frame.height}`,
				node.scaleFilePath,
				statKey(scaleStat),
				node.regionPad,
				node.regionPadMinPx,
			].join("|");
			let entry = node.regionCache.get(key);
			if (!entry) {
				entry = await buildEntry(file, frame);
				if (node.regionCache.size >= REGION_CACHE_MAX) {
					node.regionCache.delete(node.regionCache.keys().next().value);
				}
				node.regionCache.set(key, entry);
			}
			// keyed on the file's (mtimeMs, size) too: a profile fixed and then
			// broken again is a new problem and is warned again
			const version = `${statKey(profileStat)}|${statKey(scaleStat)}`;
			for (const [k, text] of entry.warnings) warnOnce(`${file}|${version}|${k}`, text);

			// a perspective-rectified payload with a calibration set is
			// un-rectified twice; the payload being the size rectify wrote is
			// the cheap tell
			const r = msg.rectify;
			if (node.scaleFilePath && r && r.applied && r.width === frame.width && r.height === frame.height) {
				warnOnce(
					`${file}|rectified-twice`,
					"this payload has been through perspective-rectify and a calibration file is set as well, so regions " +
						"are un-rectified twice - clear Calibration file when the payload is already rectified",
				);
			}

			// golden-compare upstream says which golden this frame was
			// inspected against; a profile holding another golden's barcodes
			// would put regions on the wrong artwork
			const upstream = msg.result && msg.result.profile;
			if (upstream && upstream.contentKey && entry.contentKey && upstream.contentKey !== entry.contentKey) {
				warnOnce(
					`${file}|${version}|upstream-key|${upstream.contentKey}`,
					`profile ${file} is for another golden than the one golden-compare just inspected against - no regions from it`,
				);
				return { regions: [], file };
			}
			return { regions: entry.regions, file };
		}

		// The profile region a result was read in, among those whose box
		// holds the symbol's centre: one expecting exactly this text, else
		// the same format, else whichever region's centre is nearest. Padded
		// regions overlap - the demo label's two Code128s sit side by side
		// and tall, so at regionPad 0.2 the second code's centre lies in
		// both boxes, and taking the first box paired every good read of it
		// with the other code's text (textMatches false on good frames, on
		// the rig). Works for full-image finds too, so a code that slipped
		// out of its padded region still gets its expected text checked.
		function expectedFor(result, regions) {
			if (!regions.length || !result.symbol) return null;
			const cx = result.symbol.x + result.symbol.width / 2;
			const cy = result.symbol.y + result.symbol.height / 2;
			const inside = regions.filter((g) => cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height);
			if (!inside.length) return null;
			const match = inside.find((g) => g.text != null && String(g.text) === result.text);
			if (match) return match;
			const sameFormat = inside.filter((g) => g.format === result.format);
			const pool = sameFormat.length ? sameFormat : inside;
			const dist = (g) => Math.hypot(g.x + g.width / 2 - cx, g.y + g.height / 2 - cy);
			return pool.reduce((best, g) => (dist(g) < dist(best) ? g : best));
		}

		node.on("input", async (msg, send, done) => {
			send = send || function () { node.send.apply(node, arguments); };
			const started = performance.now();
			try {
				const buffer = await resolveImage(msg.payload, "msg.payload");
				const raw = rawGeometry(msg, msg.payload);
				assertRawFits(buffer, raw, "msg.payload");
				const mode = msg.mode || node.mode;

				let regions;
				let regionSource;
				let profileFile = null;
				let fromProfile = [];
				if (msg.regions !== undefined) {
					regions = normalizeRegions(msg.regions);
					regionSource = "msg";
				} else if (node.regionSource === "profile") {
					regionSource = "profile";
					// a full-image-only scan needs no regions, so do not pay
					// for (or warn about) a profile it would not use
					if (mode !== "autoOnly") {
						const got = await profileRegions(msg, buffer, raw);
						fromProfile = got.regions;
						profileFile = got.file;
					}
					regions = fromProfile;
				} else {
					regions = node.regions;
					regionSource = "list";
				}

				node.status({
					fill: "blue",
					shape: "dot",
					text: `scanning ${regions.length} ${regionSource === "profile" ? "profile " : ""}region${regions.length === 1 ? "" : "s"}…`,
				});

				const { results, timings, usedFullImage } = await locateBarcodes(buffer, {
					regions,
					mode,
					readerOptions: node.readerOptions,
					raw,
				});

				if (results.length === 0) {
					const noneMsg = Object.assign({}, msg, {
						barcodeIndex: 0,
						barcodeCount: 0,
						text: null,
						format: null,
						roi: null,
						symbol: null,
						regionLabel: null,
						regionSource,
						expectedText: null,
						textMatches: null,
						source: usedFullImage ? "fullImage" : "region",
						timings,
					});
					send(noneMsg);
					node.status({
						fill: "yellow",
						shape: "ring",
						text: `none found · ${formatMs(performance.now() - started)}`,
					});
					done();
					return;
				}

				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					const expected = regionSource === "profile" ? expectedFor(r, fromProfile) : null;
					const expectedText = expected && expected.text != null ? String(expected.text) : null;
					const textMatches = expectedText === null ? null : r.text === expectedText;
					if (textMatches === false) {
						warnOnce(
							// per (expected, read) pair: another wrong read is news
							`${profileFile}|text-mismatch|${expectedText}|${r.text}`,
							`read ${JSON.stringify(r.text)} where the golden's artwork has ${JSON.stringify(expectedText)} ` +
								`(${expected.label || expected.format}, profile ${profileFile})`,
						);
					}
					const outMsg = Object.assign({}, msg, {
						barcodeIndex: i,
						barcodeCount: results.length,
						text: r.text,
						format: r.format,
						roi: r.roi,
						symbol: r.symbol,
						regionLabel: r.regionLabel,
						regionSource,
						expectedText,
						textMatches,
						source: r.source,
						decodeMs: r.decodeMs,
						timings,
						payload: r.previewBuffer,
					});
					send(outMsg);
				}

				node.status({
					fill: "green",
					shape: "dot",
					text: `${results.length} found (${usedFullImage ? "full image" : "regions"}) · ${formatMs(performance.now() - started)}`,
				});
				done();
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: "error" });
				// done(err) routes the failure through node.error exactly
				// once; an explicit node.error here reported every failure
				// twice (double log lines, Catch nodes firing twice)
				done(err);
			}
		});
	}

	RED.nodes.registerType("barcode-locate", BarcodeLocateNode);
};
