# Synthetic frame sets for `golden-compare`

A generator of camera frames with realistic label defects and exact ground
truth, so `golden-compare`'s detection quality can be measured **per defect
type and size** instead of by eye on a handful of real parts.

Nothing here is a customer image. The golden is either drawn from scratch
(`lib/synth/label.js`) or taken from a file path you pass in; frames are synthesised
from it. Point `--out` at a directory outside the repository.

## Generating a set

```
node bench/synth/generate.js --out ./set
node bench/synth/generate.js --out ./set --seed 7 --per-variant 3 --preset harsh
node bench/synth/generate.js --out ./set --golden /path/to/artwork.png
node bench/synth/generate.js --out ./set --width 3000 --height 4200
```

| flag | default | meaning |
| --- | --- | --- |
| `--out` | *required* | directory for `golden.png`, `frames/`, `manifest.json` |
| `--golden` | — | use this artwork instead of a synthetic label (not copied into the repo; the decoded copy is written into `--out`) |
| `--seed` | `1` | seeds everything; the same seed reproduces the set byte for byte |
| `--per-variant` | `3` | frames per (family, variant, severity) |
| `--preset` | `typical` | `clean-rig`, `typical` or `harsh` — see `lib/synth/capture.js` |
| `--width` / `--height` | `1500` / `2100` | synthetic golden size |
| `--rig` | `true` | one magnification and stretch for the whole set, drawn once, as a camera on a stand gives; angle and placement still vary per frame. `--rig false` draws them per frame, which measures the alignment search rather than the inspection. The manifest records the rig's `mx`/`my` |

The set is every (family, variant, severity) `--per-variant` times, plus a
`clean` family — no defect at all under the same capture variation, at no
less than a tenth of the set, plus two clean frames at each of the other
presets. The clean frames are the false-alarm measurement: without them a
detector that flags everything scores perfectly.

## Scoring a set

```
node bench/synth/run.js ./set
node bench/synth/run.js ./set --working 2100 --workers 0
node bench/synth/run.js ./set --cfg overrides.json --filter scratch
node bench/synth/run.js ./set --sweep blockThreshold=0.1,0.15,0.2
```

`run.js` prepares the golden once with the node's own defaults (heat maps
and debug stages off - they cost a second a frame and change no verdict),
runs every frame through `prepareGolden` / `compareFrame` strictly one
after another with one discarded warm-up frame, scores each against its
ground truth, prints the overall and per-family tables, and writes
`report.json` (everything, per case) and `report.md` into the set
directory. `--working` matters: the golden is never upscaled, so pass its
native long edge (2100 for the default synthetic label) to measure at
native resolution as a rig with `workingSize` at or above the artwork's
size does; the 1024 default resamples the golden and its 1-3px strokes
with it.

| flag | meaning |
| --- | --- |
| `--working N` / `--workers N` | `workingSize` and the pool size; `--workers` parallelises within a frame, never across frames |
| `--cfg file.json` | settings merged over the defaults |
| `--filter regex` / `--limit N` | a subset of case ids, the first N cases |
| `--json path` / `--md path` | report paths, default inside the set |
| `--sweep key=v1,v2,...` | run the whole set once per value of one setting and add a table of recall and false-fail rate per value; the report body is the last value's run |
| `--verbose` | one line per case as it runs |
| `--train` | pin magnification and stretch to what the full search finds on one clean frame of the run preset, as `golden-compare`'s `trainTransform` does on a line. Default: on for a rig set, off for a free one; `--train false` / `--train true` override. The report says what it pinned to |

The rules, from `score.js`, which is pure and tested without images:

- a case expected to pass (a clean frame, or one whose only defects have
  channel `none`) is **correct** when the result passes and a **false
  fail** otherwise, recorded with the check that tripped and the largest
  region reported anywhere;
- a case with a real defect is **detected** only when the result fails
  *and* a region in a channel that defect may appear in overlaps the
  defect's box, scaled to golden working pixels per axis and padded by
  one `blockSize` on every side because regions are block-quantised; a
  `both` defect is accepted in either channel;
- a passing result on a defect is a **miss**; a failing result with no
  region on the defect is a **wrong place**, and counts against recall
  exactly as a miss does. A frame that fails for the wrong reason is not
  a detection.

Recall is detected over all defect cases. The report also carries timing
percentiles split by pass and fail, the alignment grade rate, and every
miss and wrong-place with its defect size in pixels, so a tuning session
can go and look at them.

## Files

The library lives in `lib/synth/`, so the npm package ships it and the
`synthetic-defects` Node-RED node emits the same frames this CLI writes.
Only the command-line tools are under `bench/`.

| file | what it is |
| --- | --- |
| `lib/synth/prng.js` | seeded mulberry32 plus `uniform` / `int` / `pick` / `gaussian` / `shuffle`. Every random choice goes through one of these. |
| `lib/synth/label.js` | `syntheticLabel(w, h, seed)` → PNG of pure #000-on-#fff artwork: glyph-shaped type at three sizes down to 1–3px strokes, a barcode, a ruled table, a solid logo, a hairline border. No SVG `<text>` — fonts differ per machine and the set would stop reproducing. |
| `lib/synth/defects.js` | the defect library and `applyDefect` / `applyDefects`. Ground truth is measured by diffing the raster, not declared. |
| `lib/synth/capture.js` | `capture(raster, preset, prng)` — the camera model, and `capturePresets`. |
| `lib/synth/cases.js` | `planCases` / `expectedFrom` / `makeCases` / `goldenRaster` - the case plan and a lazy async generator that yields one finished frame at a time, from one prng consumed in plan order. Shared by the CLI and the node. |
| `bench/synth/generate.js` | the CLI above, and `generate(options)` for use from a script. |

## Manifest contract

`run.js` reads exactly this:

```json
{ "version": 1,
  "seed": 1, "preset": "typical",
  "golden": { "path": "golden.png", "width": 1500, "height": 2100, "source": "synthetic" | "file" },
  "cases": [
    { "id": "scratch-light-small-0003",
      "family": "scratch" | "mark" | "misprint" | "overprint" | "random" | "clean",
      "frame": "frames/scratch-light-small-0003.png",
      "capture": { "mx": 1.31, "my": 1.27, "angleDeg": 0.4, "dx": 118, "dy": 97, "ink": 48, "paper": 225,
                   "gradient": 0.1, "blurSigma": 0.8, "noiseSigma": 4, "jpegQuality": null,
                   "frameWidth": 2400, "frameHeight": 3300 },
      "defects": [ /* ground truth objects, below; [] for clean */ ],
      "expected": { "pass": false, "channels": ["print"] }
    } ] }
```

Each ground-truth object:

```
{ type: "scratch"|"mark"|"misprint"|"overprint"|"random",
  variant: string, severity: "tiny"|"small"|"medium"|"large",
  channel: "print"|"background"|"both"|"none",
  bbox: { x, y, w, h },            // golden native px, of the pixels that actually changed
  printPixels: n,                  // pixels that were ink in the golden and are now lighter by >= 64
  backgroundPixels: n,             // pixels that were paper and are now darker by >= 64
  params: { ...whatever describes the defect, e.g. width, length, opacity } }
```

`expected.pass` is `false` only when at least one defect's channel is not
`"none"`; `expected.channels` is the union of the non-`"none"` channels
(`"both"` contributes both). `capture` also carries `trayGrey`, `vignette`
and `margin`, which are outside the core contract — ignore them or use them
to correlate a failure with the frame that produced it.

`golden.source` is `"file"` when `--golden` was used, and the manifest then
also carries `sourcePath`, the absolute path the artwork came from.

## How each family maps to the node's channels

`golden-compare` runs two independent blemish checks (see README.md, "How
`golden-compare` works"): **print** — golden has ink the frame is missing;
**background** — the frame has ink the golden never has. `channel` in the
ground truth is *derived from the pixels*, not from the family name, so
these are the usual outcomes rather than guarantees:

| family / variant | usually | why |
| --- | --- | --- |
| `scratch` `light` | print | removes ink, so it only shows where it crosses type |
| `scratch` `dark` | background | lays ink on blank paper |
| `mark` `ink` / `smudge` / `spatter` | background | dark blobs on paper; `smudge` is partial-opacity grey and can fall under the floor |
| `misprint` `void` / `dropout` / `streak` | print | ink erased to paper — a patch, a whole glyph, a dead thermal-head column |
| `misprint` `faded` | print or **none** | partial ink loss; a faint fade is under the 64-level floor and the part is supposed to pass |
| `overprint` `ghost` / `bleed` | background or **none** | a second shifted impression, and ink spreading off existing strokes — where they land on existing ink they change nothing |
| `overprint` `stroke` / `fill` | background | an extra line, an extra filled block |
| `random` `dust` | background | specks on paper |
| `random` `void-spots` | print | white pinholes inside ink |
| `random` `stain` | **none** | 15–40 grey levels off paper, by construction under the floor — this variant exists to check the background channel does *not* fire |
| `random` `fold` | both | a crease: a highlight that lifts ink and a shadow that lays it |
| `random` `combo` | mixed | two or three of the above on one part |

A defect whose channel is `"none"` is a part the node must still **pass**.
That is the point of deriving the channel instead of declaring it: the
runner scores what a defect did to the pixels, not what its name promised.

## Capture presets

`clean-rig`, `typical` and `harsh` are three points on the capture-quality
axis — magnification, stretch, rotation, ink/paper levels, illumination
gradient, vignette, blur, noise and JPEG quality — so a sweep can separate
"the detector cannot find this defect" from "the detector cannot see
through this photograph". The ranges are in `lib/synth/capture.js`; every sampled
value is recorded in the manifest.

## Tests

`test/synthDefects.test.js` pins the properties that would silently
invalidate a benchmark: determinism, two-level artwork with a plausible ink
fraction, ground truth that matches an independently recomputed diff,
monotonic severity ladders, `stain` reporting `"none"`, capture parameters
inside their preset ranges, and a manifest matching the contract above.
