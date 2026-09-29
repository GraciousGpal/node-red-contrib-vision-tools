/**
 * synthetic-defects Node-RED node.
 *
 * A test bench for golden-compare, inside the editor. Give it a golden
 * and it emits a synthetic frame set one message at a time - the same
 * frames bench/synth/generate.js writes to disk, from the same
 * lib/synth/cases.js - each carrying the golden it was made from and the
 * exact ground truth of the defect painted into it. Wire output 1 into
 * golden-compare and an image preview and you can watch what every defect
 * family and severity looks like and what the node says about it, without
 * a scratch directory, a CLI, or a customer's parts.
 *
 * Input (msg.payload): the golden - Buffer / Uint8Array / ArrayBuffer, a
 * file path string, an object carrying data/buffer/path, or a raw
 * { data, width, height, channels } descriptor. Empty or absent draws the
 * synthetic label at the configured width/height.
 * Optional per-message overrides: msg.seed, msg.perVariant, msg.preset,
 * msg.families, msg.severities, msg.intervalMs.
 *
 * Output 1: one message per frame - msg.payload (the frame bytes),
 * msg.golden (the golden as PNG), msg.goldenKey, msg.filename, msg.synth.
 * Output 2: one message, first, carrying the golden itself.
 *
 * Frames are pulled from the async generator one at a time rather than
 * built up front: a default set is ~170 frames and ~300MB of PNG, and
 * the first frame should be on the wire long before the last one exists.
 *
 * Deliberately not done: this does not inspect, score or compare
 * anything. It is a source. Scoring a whole set and printing recall is
 * bench/synth/run.js's job offline, where it can run frames strictly one
 * at a time and time them; a node doing both would be measuring itself
 * inside the flow's own event loop.
 */

"use strict";

const crypto = require("node:crypto");
const sharp = require("sharp");
const { resolveImage, isBytes, clampInt, pickMode } = require("./lib/nodeInput.js");
const { FAMILIES, SEVERITIES } = require("./lib/synth/defects.js");
const { capturePresets } = require("./lib/synth/capture.js");
const { planCases, makeCases, goldenRaster } = require("./lib/synth/cases.js");

// The checkbox flags, every one on by default. Spelled out rather than
// derived, because the editor has one checkbox per name and the two lists
// have to be edited together anyway - a family added to defects.js needs a
// checkbox here before it can be switched off.
const DEFAULT_FLAGS = [
	"scratch", "mark", "misprint", "overprint", "random",
	"tiny", "small", "medium", "large",
];
const FAMILY_NAMES = DEFAULT_FLAGS.filter((n) => n in FAMILIES);
const SEVERITY_NAMES = DEFAULT_FLAGS.filter((n) => SEVERITIES.includes(n));
const PRESETS = Object.keys(capturePresets);

module.exports = (RED) => {
	/** The checked subset of `all`, or null when it is all of them. */
	function chosen(config, all) {
		const on = all.filter((name) => config[name]);
		return on.length === all.length ? null : on;
	}

	/** A msg override that is a list of known names, else the configured set. */
	function overrideList(value, all, fallback) {
		if (!Array.isArray(value)) return fallback;
		const kept = value.map(String).filter((n) => all.includes(n));
		return kept.length ? kept : fallback;
	}

	function SyntheticDefectsNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.seed = clampInt(config.seed, 1, [0, 2147483647]);
		node.perVariant = clampInt(config.perVariant, 1, [1, 50]);
		node.preset = pickMode(config.preset, "typical", PRESETS);
		node.intervalMs = clampInt(config.intervalMs, 500, [0, 60000]);
		node.width = clampInt(config.width, 1500, [64, 10000]);
		node.height = clampInt(config.height, 2100, [64, 10000]);
		// A node instance saved before a checkbox existed carries no property
		// for it, so "nothing ticked" and "never configured" look the same
		// here. Either way an empty restriction means "all of them" in
		// planCases - an all-off families list would emit clean frames only,
		// which reads as a broken node rather than as a setting.
		node.families = chosen(config, FAMILY_NAMES);
		node.severities = chosen(config, SEVERITY_NAMES);

		// One run at a time. A second input message while frames are still
		// going out stops the first: someone re-injecting wants the new
		// settings, not two interleaved sets on one wire.
		let run = 0;
		let timer = null;
		let wake = null;

		// Cancelling wakes the parked run rather than just dropping its
		// timer: a handler left awaiting a timer that was cleared never
		// returns, so its done() is never called and Node-RED keeps the
		// message open forever. It wakes, sees it is not the current run,
		// and closes itself out.
		function stop() {
			run++;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (wake) {
				const resume = wake;
				wake = null;
				resume();
			}
		}

		const wait = (ms) =>
			new Promise((resolve) => {
				wake = resolve;
				timer = setTimeout(() => {
					timer = null;
					wake = null;
					resolve();
				}, ms);
			});

		function fresh(topic) {
			const m = { topic };
			if (RED.util && RED.util.generateId) m._msgid = RED.util.generateId();
			return m;
		}

		node.on("input", async (msg, send, done) => {
			send = send || function () { node.send.apply(node, arguments); };
			stop();
			const mine = run;
			const alive = () => run === mine;
			try {
				const seed = clampInt(msg.seed, node.seed, [0, 2147483647]);
				const perVariant = clampInt(msg.perVariant, node.perVariant, [1, 50]);
				const preset = pickMode(msg.preset, node.preset, PRESETS);
				const intervalMs = clampInt(msg.intervalMs, node.intervalMs, [0, 60000]);
				const families = overrideList(msg.families, FAMILY_NAMES, node.families);
				const severities = overrideList(msg.severities, SEVERITY_NAMES, node.severities);

				node.status({ fill: "blue", shape: "dot", text: "preparing golden…" });

				// A raw descriptor never goes through resolveImage: it is
				// pixels, not an encoded image, and resolveImage would hand
				// sharp a headerless buffer to sniff.
				const p = msg.payload;
				const isRaw =
					p != null &&
					typeof p === "object" &&
					!isBytes(p) &&
					p.data != null &&
					p.width > 0 &&
					p.height > 0;
				const empty = p == null || p === "";
				let raster;
				let source;
				if (empty) {
					raster = await goldenRaster(null, {
						width: node.width,
						height: node.height,
						seed,
					});
					source = "synthetic";
				} else {
					raster = await goldenRaster(
						isRaw ? p : await resolveImage(p, "msg.payload"),
					);
					source = "input";
				}

				const goldenPng = await sharp(raster.data, {
					raw: { width: raster.width, height: raster.height, channels: 1 },
				})
					.png({ compressionLevel: 9 })
					.toBuffer();
				// golden-compare caches a prepared golden per key. Naming the
				// golden once here makes it prepare that golden once for the
				// whole run instead of re-hashing an identical buffer per frame.
				const goldenKey = `synth:${seed}:${crypto
					.createHash("sha1")
					.update(goldenPng)
					.digest("hex")}`;

				const plan = planCases({ perVariant, preset, families, severities });
				if (!alive()) return done();

				const first = fresh(msg.topic);
				first.payload = goldenPng;
				first.filename = "golden.png";
				first.goldenKey = goldenKey;
				first.synth = {
					kind: "golden",
					width: raster.width,
					height: raster.height,
					source,
					total: plan.length,
				};
				send([null, first]);

				let emitted = 0;
				for await (const c of makeCases({ raster, seed, plan })) {
					if (!alive()) return done();
					node.status({
						fill: "blue",
						shape: "dot",
						text: `${c.index + 1}/${c.total} ${c.variant ? `${c.family}/${c.variant}` : c.family}`,
					});
					const out = fresh(msg.topic);
					out.payload = c.buffer;
					out.golden = goldenPng;
					out.goldenKey = goldenKey;
					out.filename = `${c.id}.${c.format}`;
					out.synth = {
						id: c.id,
						index: c.index,
						total: c.total,
						family: c.family,
						variant: c.variant,
						severity: c.severity,
						preset: c.preset,
						capture: c.capture,
						defects: c.defects,
						expected: c.expected,
					};
					send([out, null]);
					emitted++;
					if (intervalMs > 0 && c.index + 1 < c.total) {
						await wait(intervalMs);
						if (!alive()) return done();
					}
				}

				node.status({
					fill: "green",
					shape: "dot",
					text: `done · ${emitted} frame${emitted === 1 ? "" : "s"}`,
				});
				done();
			} catch (err) {
				// A cancelled run's failure belongs to nobody - the run that
				// replaced it owns the status line now.
				if (!alive()) return done();
				node.status({ fill: "red", shape: "ring", text: "error" });
				// done(err) routes the failure through node.error exactly once
				done(err);
			}
		});

		node.on("close", () => {
			stop();
			node.status({});
		});
	}

	RED.nodes.registerType("synthetic-defects", SyntheticDefectsNode);
};
