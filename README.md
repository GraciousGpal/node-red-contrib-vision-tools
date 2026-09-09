# @graciousstar/node-red-contrib-vision-tools

Machine-vision nodes for Node-RED, built around one assumption: the camera
is fixed. Framing, scale and lighting hold from shot to shot, so the
expensive parts of inspection — where the part is, how many millimetres a
pixel covers, where the label edge falls — can be measured once at
commissioning and only checked afterwards.

For how the pipeline is put together and why each piece is shaped the way
it is, see [ARCHITECTURE.md](ARCHITECTURE.md). This file is the operator's
guide: what the settings do and how to use them. Version history is in
[CHANGELOG.md](CHANGELOG.md).

## The nodes

- **`golden-compare`** — compares a camera capture against a cached
  "golden" reference image: a **position** check (measured shift and angle
  vs. tolerance bands — a real position defect fails on its own, it isn't
  silently corrected away) plus two independent **blemish** checks —
  print (missing ink) and background (unwanted ink) — each with its own
  tolerance. Alignment recovers independent x/y magnification and
  rotation as well as translation, then refines what is left per tile, so
  the golden can be the label's PDF artwork rather than a capture off the
  same camera — including raw pixels handed straight over by
  `pdf-to-image`. The per-pixel stages run on a worker pool.
- **`checkerboard-calibrate`** — photograph a printed checkerboard of
  known pitch, measure the pixel pitch, and save or compare the resulting
  mm/px scale. Run once at commissioning and again after camera or
  mechanical maintenance, not per frame — the whole point of a fixed
  camera rig is that this doesn't need re-running per part.
- **`label-crop`** — deskews and crops a physical label out of a frame,
  either by thresholding the whole frame and taking the dominant blob or,
  when the label's own boundary is fainter than its printed artwork, by
  intersecting four caliper-measured edges.
- **`line-finder`** — finds one straight edge inside a region you draw. A
  row of calipers scans across it, each reports where the brightness
  steps, and a line is fitted through those points with outliers dropped.
  Pure JS, no native engine, and only the pixels inside the region are
  touched.
- **`barcode-locate`** — finds and decodes 1D and 2D barcodes, optionally
  restricted to pre-defined pixel regions with a whole-image fallback.

Built for speed — a ~23MP camera frame decodes, aligns, diffs and
heat-maps in well under a second: around 0.45s against a same-scale
golden, and roughly double that when magnification and stretch both have
to be searched over a wide range (see Notes).

## Install

From the Node-RED palette manager, search for
`@graciousstar/node-red-contrib-vision-tools`, or from your Node-RED user
directory (`~/.node-red`):

```bash
npm i @graciousstar/node-red-contrib-vision-tools
```

Node 18 or newer. `sharp` and `zxing-wasm` are required and ship prebuilt
binaries for the usual platforms.

`label-crop` and two optional `golden-compare` acceleration paths need a
native OpenCV addon, which is an **optional** dependency: the package
installs and every other node works without it, and `label-crop` reports a
clear setup error rather than failing a part. Prebuilt binaries for that
engine cover Linux x64/arm64, Alpine x64 and macOS arm64 — there is no
win32 build, which is why the test suite never touches it.

## How `golden-compare` works

1. **Golden reference** (`goldenPath`, or `msg.golden`) is decoded, grayscaled,
   downscaled to `workingSize` and binarized **once** and cached — not
   redone per frame, and neither are the density lattices the alignment
   search compares against. Its foreground mask is dilated by
   `backgroundTolerance` px to create the background-check's tolerance band.

   Binarizing uses `thresholdMode`: `otsu` (the default — one level per
   image, chosen to separate the two intensity modes, which absorbs
   uniform exposure change), `fixed` (one hand-set level — fastest and
   perfectly repeatable, but it drifts out of calibration as the lighting
   does), or `sauvola` (a per-pixel level from the local mean and standard
   deviation — also absorbs lighting *gradients* across the part). Otsu
   and Sauvola make golden and frame independently self-normalizing. That
   is the default for a reason: the golden is normally PDF artwork —
   synthetic pure black on pure white — and the frame is a photograph, and
   no single grey level is correct for both.

   Whichever mode is chosen the decision is still a hard cut, so
   `inkMargin` (grey levels, default 8) marks a pixel **ambiguous** when
   it lies within that many levels of the level it was judged against, on
   *either* side, and both blemish checks drop a pixel from the evidence
   when either image is ambiguous there. A defect claim is a claim about
   both images — "ink here, none there" — so ambiguity on either side
   voids it.

   This is not a fudge factor; it fixes two specific, reproducible
   failures against artwork. **On the frame side**, a screened tint
   renders lighter than the level in the PDF and dot gain prints it
   darker than the level in the photograph, so the identical design
   element binarizes to background on one side and ink on the other — on
   this project's pair, two false regions at densities 0.30 and 0.23 from
   a 9-level swing. **On the golden side**, and this one only appears
   above `workingSize` 1024, Otsu's level is not stable: it is re-derived
   from each image's histogram, and on this artwork it walks from 160 at
   1024 down to 145 at 3072. A flat "RX" panel sitting at grey 155 flips
   from ink to background partway up that range while the print
   reproduces it at 84 — solid ink — lighting up a whole 144×304 region
   at density 1.000 on a good part. Only the two-sided test catches that,
   because the artwork pixel there is *background*.

   Ambiguous pixels remain full evidence for *alignment*; the margin only
   withholds them from the defect claim. Set it to 0 for plain
   hard-threshold behaviour.
2. Each incoming frame is decoded **preserving its own aspect ratio** — a
   raw camera capture often includes background/margin beyond golden's own
   framing, and stretching it to golden's exact dimensions would distort
   it non-uniformly rather than crop it. The resize target is golden's
   *physical scale*, not its pixel dimensions: with a calibrated
   `scaleFilePath`, that's an exact mm/px conversion; without one, the
   frame inherits golden's own realized native→working scale — the
   same-rig assumption that one native pixel spans the same distance in
   both images (see `computeTargetWorkingSize` in `lib/compare.js`). Both
   sides go through one decode path at explicitly computed dimensions, so
   a frame compared against its own golden is bit-identical and scores an
   exactly-zero defect ratio.
3. The frame is binarized and `lib/align.js` searches for the transform
   — magnifications `mx`/`my`, rotation `θ`, translation `(ox,oy)` — that
   best places the golden template within it. The two magnifications are
   **independent**, which is what makes an artwork golden usable at all:
   a press stretches print along its media-feed axis relative to the
   artwork (5–6% on this project's own sample pairs), and a single
   isotropic scale can only split that error, leaving every feature
   several pixels out toward the ends of the long axis. On body text
   several pixels is the whole stroke, so ~12% of pixels disagree and both
   blemish checks fail a good part. Searching `mx` and `my` separately
   takes the same pairs to ~0.06%. Scoring is
   mean absolute ink-density difference over a lattice of cells, each read
   in O(1) from a summed-area table, so one candidate costs a few thousand
   operations no matter how large either image is. The search is
   coarse-to-fine: a wide sweep of the scale ladder over the whole frame, a
   joint scale+angle refine, a fine translation refine, and finally a
   **polish** that optimizes actual pixel disagreement instead of the
   coarse density proxy — the two stop agreeing at sub-pixel scale, and it
   is the pixels that the blemish checks go on to measure. The matched
   region is then resampled into golden's grid by `lib/warp.js`,
   area-averaging when the frame out-resolves the golden so fine text is
   downsampled rather than aliased.

   `alignSearch` adds translation slack beyond the pure size difference.
   Set `scaleSearchMin`/`Max` both to 1 to pin the magnification,
   `maxAspect` to 0 to assume both axes share a scale, and `maxAngleDeg`
   to 0 to disable the rotation search — worth doing for any of them if
   the rig is fixtured tightly enough that searching is only a chance to
   be wrong.
4. **Position check**: the recovered placement is compared against
   tolerance bands around *nominal* — centered in the available margin and
   square to the frame. (There's no separate "nominal" to capture, unlike
   their system's trained nominal from label-edge geometry; this reduces to
   a tolerance around exactly `(0,0)` when target and golden are already
   the same size.) Offsets in mm if `scaleFilePath` points at a calibration
   baseline (see below), else in px. Rotation is gated separately, in
   degrees, against `positionToleranceAngleDeg`: a part that is offset and
   a part that is skewed are different faults with different causes, so
   collapsing them into one number would throw away the more actionable
   half.
5. **Blemish checks**, both against the *matched/cropped* target:
   - *print* — golden has ink the target is missing, even after dilating
     the target's ink by `printTolerance` px
   - *background* — target has ink the golden never has, even after
     dilating the golden's ink by `backgroundTolerance` px

   These are provably disjoint per pixel (a pixel that's target-foreground
   can't simultaneously fail the "target lacks ink" test), so the two
   checks never double-count the same defect. Each diff is block-summed
   into a density grid (`blockSize` px) via a summed-area table,
   thresholded (`blockThreshold`), and flood-filled into defect bounding
   boxes; each fails independently if any region exceeds `failThreshold`
   or its overall defect ratio exceeds `failRatio`.
6. Overall `pass = position.pass && printBlemish.pass && backgroundBlemish.pass`.

Decode/resize uses [`sharp`](https://sharp.pixelplumbing.com) (native,
libvips) — the images here run 20+ MP, and a pure-JS decoder was too slow
for the "very fast" requirement this node was built for. Everything after
decode (threshold, dilation, alignment search, diff, block-sum) is plain
typed-array math with no further native dependencies — binary masks stay
`Uint8Array`/`Uint32Array`, while the grey summed-area tables use a
`Float64Array` accumulator so they cannot wrap on large frames (a `Uint32`
grey table wraps past ~16.8M bright pixels and silently corrupts the
area-average warp):
dilation is a separable sliding-window max filter (van Herk/Gil-Werman,
`lib/dilate.js`), so cost stays O(width×height) regardless of the
configured radius, and every density and area-average read in the
alignment search and the warp is an O(1) summed-area lookup
(`lib/integral.js`) rather than a re-scan.

### Input

`msg.payload` — camera frame as a `Buffer` (any format `sharp` can decode:
PNG/JPEG/etc.) or a file path string.

Per-message overrides are listed under **Speed** below. `msg.golden`
(path or Buffer) swaps and re-caches the golden reference if it differs
from what's cached.

### Loading the golden from a PDF

The golden is normally the label's artwork, so `pdf-to-image` can hand it
over directly. Set that node's **format** to `RAW` and wire one change
node:

```text
msg.golden = msg.payload
```

In RAW mode `msg.payload` is already
`{ data, width, height, channels, colorSpace, dtype }` — raw pixels carry
no container to hold a geometry, so the node hands it over alongside the
bytes, and that is exactly the shape this node accepts. No PNG encode, no
PNG decode, no temporary file. `PNG` output works too and needs no
geometry, at the cost of a round trip through the encoder.

Note `msg.images[]` is *per-page metadata only* — page, width, height,
channels, path — and carries no pixels. It is the wrong thing to reach
for here. When `msg.golden` is a path or a buffer that carries its own
container, `msg.images[]` geometry is ignored entirely — a stale `RAW`
message left over from an earlier step must not stamp the frame's
dimensions onto a file golden (the same guard the frame side has always
had).

Two things to know:

- **Get the rotation right first.** Artwork is often laid out at a quarter
  turn to how the camera sees the label, and the alignment search covers
  ±2°, not 90° — there is no finding the way back from a wrong
  orientation. Set `rotation` on the pdf-to-image node. Measured on this
  project's PDF: 270 places the golden within 56px of nominal, 90 lands it
  1013px out. **A comparison that fails everywhere with a large `dx`/`dy`
  is this until proven otherwise** — it is the cheapest thing to rule out
  and the least obvious.
- **Render at enough dpi.** The golden is never upscaled, so a render
  whose long edge is below `workingSize` caps the whole inspection at the
  golden's resolution and discards detail the camera did capture. At
  `workingSize` 3072 a 100mm label wants roughly 780 dpi. The node warns
  when the golden comes in short — including for a PNG golden, which is
  worth checking: this project's own 1844x2656 artwork means a
  `workingSize` above 2656 buys nothing.
- **Give it `msg.goldenKey`.** A buffer golden is keyed by a hash of its
  bytes, and hashing a ~12MB raw render on every message is real time
  spent learning something that did not change. `msg.goldenKey` names it
  instead — a path, a revision, an mtime — and the hash is genuinely
  skipped. (Before 1.0.2 it was not: the hash ran before the name was
  consulted, so the option saved nothing.)

  In exchange, **invalidation becomes yours**. The buffer's length is
  still checked, so a differently-sized render under a stale name is
  caught, but a *same-sized* one is served from cache. Change the key
  whenever the artwork changes.

  A golden loaded from a path needs no key: it is fingerprinted by mtime
  and size, which costs a stat and no read.
- **If the frame is raw too, say `msg.rawInfo`.** `msg.images[]` is only
  read for the frame when no golden travels on the same message, because
  when the golden *is* the PDF render, `msg.images` describes that and
  decoding a 23MP capture at the artwork's dimensions would give a
  confident wrong answer instead of an error.

A camera SDK handing over a framebuffer works the same way: either send
`msg.payload = { data, width, height, channels }`, or send the bare buffer
with `msg.rawInfo = { width, height, channels }`. On a 4096x5500 frame
that removes ~300ms of PNG decode — the largest serial cost left in an
inspection.

Raw descriptors are validated before `sharp` sees them: the buffer must
actually be `width × height × channels` bytes (a mismatch is a clear
error naming the real numbers, not a native crash), declared sizes are
capped, and any image input over 512 MB is refused before it is copied
or hashed.

### Grading, and telling a bad part from the wrong golden

`msg.result.match` reports how well the two images registered, separately
from whether the part is any good — a part can register perfectly and be
defective, and a flawless part can look ruined because the golden is
wrong.

```js
match: { score, grade, mismatchSuspected, reason }
```

`score` is the alignment residual, `grade` is `good` (< 0.06) / `marginal`
/ `poor` (≥ `mismatchScore`). Measured here: a correctly paired label
registers at **0.02–0.05**, a badly printed one at about **0.10**, and
another product's artwork at about **0.18**.

`mismatchSuspected` is the one worth wiring to an operator. Comparing one
product's artwork against another's photograph reports **1145 print
regions and a 6% defect ratio** — which reads as a spectacularly bad
print, when the real answer is "wrong golden". The two are distinguished
by the *shape* of the disagreement rather than its size: a defective part
disagrees in one direction and in places, two different labels disagree in
both directions and everywhere. So the claim needs poor registration
**and** both blemish checks saturated. That pairing is what keeps a
genuinely bad part out of it — the worst real one here registers at 0.10
but its two ratios are 0.006 and 0.011, lopsided and an order of magnitude
low. `mismatchScore: 0` disables it.

### Speed

A 4096×5500 PNG frame against a 1844×2656 golden, pinned, heat maps on,
12 workers, is ~1.05s in this project's container. What moves that,
largest first:

| lever | effect |
| --- | --- |
| `debugStages` | **+690ms** when on. Pure diagnostics |
| heat maps | **+~300ms** when on. Display output; the verdict does not use them |
| trained transform | **halves** the alignment, and accuracy is the reason to pin, not speed |
| `workers` | the per-pixel stages and both summed-area tables run on the pool. 0 picks one per core up to **16**; on a 16-core host, 8 → 12 workers took align 798ms → 680ms |
| `nativeFastAlign` | aggressive OpenCV prototype: 663ms → **243ms** on the clean PNG and 1065ms → **443ms** on the high-compression reject. See below |
| `nativeAlignSeed` | conservative prototype, off by default: align 545ms → 338ms. See **Native alignment seed** below |
| raw input instead of PNG | **−~75ms** on this frame (decode 143ms → 70ms for mono). The saving is the *decode*, so it scales with the PNG's compressed size rather than its pixel count — a 13.7MB PNG of the same dimensions decodes in ~560ms |
| the host's power profile | **~2.2×** on everything. Measured on a laptop that had dropped to battery mode mid-session: align 2020ms → 913ms on mains, no code or setting changed |

Docker is **not** on that list, and an earlier version of this table was
wrong to put it there. Running this project's own `bench/frame-bench.js`
inside the container reproduces the committed `bench/baseline.json` from
the host within ~10% (pinned search 236ms vs 222ms, unpinned align 2075ms
vs 2219ms). What looked like a container tax was the power profile above.

`workingSize` is the one that changes *what is detectable* rather than
just how long it takes — see the note on it above before lowering it.

Per-message overrides:
`msg.threshold`, `msg.thresholdMode`, `msg.sauvolaRadius`, `msg.sauvolaK`,
`msg.inkMargin`, `msg.printTolerance`, `msg.backgroundTolerance`,
`msg.alignSearch`, `msg.scaleSearchMin`/`Max`/`Steps`, `msg.maxAspect`,
`msg.aspectSteps`, `msg.maxAngleDeg`, `msg.angleSteps`,
`msg.alignCandidates`, `msg.localAlign`, `msg.localAlignTile`,
`msg.localAlignMax`, `msg.workers`, `msg.mismatchScore`,
`msg.trainTransform`, `msg.nativeAlignSeed`, `msg.nativeFastAlign`,
`msg.positionToleranceXMm`/`YMm`/`XPx`/`YPx`/`AngleDeg`, `msg.blockSize`,
`msg.blockThreshold`, `msg.failThreshold`, `msg.failRatio`,
`msg.outputPrintHeatmap`, `msg.outputBackgroundHeatmap`,
`msg.debugStages`.

Raw geometry rides alongside the image rather than as a setting:
`msg.rawInfo` for the frame, `msg.goldenRawInfo` for the golden, and
`msg.goldenKey` to name the golden for the cache. See **Input** above.

### OpenCV fast alignment (aggressive prototype)

Tick **Experimental OpenCV fast alignment** or send
`msg.nativeFastAlign = true` to move the complete affine solve and global
warp into OpenCV. This path also decodes through OpenCV. It bypasses both JS
summed-area tables, the density sweeps, pixel polish, and the final global
warp; local tile refinement and the blemish policy still run afterward.
`result.transform.native` reports which path produced the frame.

The native result is accepted only when it stays inside `maxAngleDeg`, remains
within 3% of each trained magnification, and its full-resolution disagreement
score is at most 0.15. Otherwise the same frame automatically falls back to
the trained JS alignment and `result.transform.nativeFallback` explains why.
This prevents OpenCV from explaining small artwork differences as large
scale/stretch changes.

This prototype is intentionally **not result-compatible** with the JS path.
OpenCV fits an unrestricted affine transform (including shear), uses nearest
neighbour for its warp, does not preserve the trained magnifications, and its
reported alignment score is full-resolution post-local mask disagreement
rather than the JS 320px polish objective. On the two available matching
fixtures it changed the clean image from fail to pass and still failed the
marked reject (four background regions).

Measured in the project container, 4096×5500 PNG, 12 workers, heat maps and
debug stages off, median of three warm frames:

| frame | JS | OpenCV full | speed-up |
| --- | ---: | ---: | ---: |
| clean | 663ms | **243ms** | 2.7× |
| high-compression reject | 1065ms | **443ms** | 2.4× |

Run `node bench/opencv-fast-bench.js [golden.png] [frame.png] [iterations]`
to compare the JS, conservative seed, and full OpenCV paths on another set.
A missing or failed native engine falls back to JS.

### Native alignment seed (prototype, off by default)

`nativeAlignSeed` starts the pinned search from an ORB+ECC alignment
measured by the optional native OpenCV
engine, instead of from the staged sweeps. On a 4096×5500 frame that took
align from 545ms to 338ms, and the search itself from 325ms to 125ms.

The engine is **not a dependency**. Without it the flag is inert and the
node behaves exactly as it does today, bit for bit —
`test/nativeSeed.test.js` asserts that. Installing the optional native
OpenCV engine enables it; it ships published
prebuilt binaries for Linux x64/arm64, Alpine x64, and macOS arm64.

A seed replaces the sweeps' **guess**, never their verdict. The trained
magnifications stay the trained ones — a seed is not allowed to reopen the
constant that pinning exists to fix — so only the angle and the placement
come from it, and the polish still refines against real pixels and still
produces the score. Every seed is range-checked against the same physical
bounds `lib/transformFile.js` applies and discarded on failure in favour
of the sweeps, because the engine reports `success: true` for results that
are plainly wrong: its features-only pipeline returned scaleX 33.7 at 97°
on this project's own sample. `result.transform.seeded` reports whether a
seed was actually used.

**Why it is not the default.** Across five fixtures every verdict matched,
but the evidence behind one did not: the reject sample resolves into two
background regions seeded and one unseeded, and the alignment residual
moves in both directions (0.040663 → 0.040401 on a clean part, 0.040558 →
0.040846 on a rotated one). ORB is feature matching, and a badly printed
label — the case this inspection exists for — is exactly where features
are poorest. Validate against a real set of rejects for your golden before
trusting it.

### Output

- `msg.payload` — `true`/`false` overall pass
- `msg.result` —
  `{ pass, position: { dxPx, dyPx, dxMm, dyMm, angleDeg, anglePass, scale, scaleX, scaleY, stretchPercent, pass }, transform: { pinned, native, nativeFallback?, seeded, pinRefused?, scaleX, scaleY, scale, stretchPercent, angleDeg, ox, oy, score }, match: { score, grade, mismatchSuspected, reason }, thresholds: { golden, target }, localAlign: { tiles, localised, meanPx, medianPx, maxPx }, printBlemish: { pass, defectRatio, regions: [{x,y,w,h,density,avgDensity,cells}] }, backgroundBlemish: { pass, defectRatio, regions } }`
  (region coordinates in the working-resolution image, same size as the
  heat maps — not the original camera resolution). `transform` is the raw
  recovered placement in frame-canvas pixels (`pinned` reports whether a
  trained transform was used, `seeded` whether that transform started from
  a native ORB+ECC seed rather than the staged sweeps — see **Native
  alignment seed** below — and `pinRefused` is present with the reason
  when there was a trained record the node declined to use — it also
  warns, but a warning is easy to miss and the fallback to a full search
  is otherwise invisible from the message); `thresholds` reports the grey level each
  side actually used, so exposure drift is visible rather than merely
  absorbed; `match` is the registration grade described under **Grading**
  below; `localAlign` is the per-tile refinement statistics (`tiles` =
  tiles examined, `localised` = tiles that found a trusted offset,
  `meanPx`/`medianPx`/`maxPx` = the recovered displacement magnitude in
  working px) and is `null` when refinement is off.

  `stretchPercent` — how far the two axis magnifications differ — is
  reported but deliberately **not** gated. Some stretch is just what the
  press does, and its normal value depends on media and machine, so any
  default threshold would be a guess that fails good parts. It is worth
  trending, though: a stretch that moves is a press drifting.
- `msg.printHeatmap` / `msg.backgroundHeatmap` — PNG `Buffer` overlays
  (only if the matching `outputPrintHeatmap`/`outputBackgroundHeatmap` is on)
- `msg.timings` — `{ decodeMs, alignMs, diffMs, heatmapMs, stagesMs, totalMs }`
- `msg.stages` — only if `debugStages` is on: PNG `Buffer`s for each
  pipeline step (`goldenGray`, `goldenFg`, `goldenFgDilatedBackground`,
  `targetGray`, `targetFg`, `targetGrayAligned`, `targetFgAligned`,
  `targetFgDilatedPrint`, `printDefect`, `backgroundDefect`) — for
  diagnosing *why* a comparison is failing rather than just that it did.
  `targetGray`/`targetFg` are the *full* pre-warp frame canvas (generally a
  different size than golden — useful for seeing where the match landed);
  everything from `targetGrayAligned` on is golden-sized.
  `targetGrayAligned` is the most useful single image when a result looks
  wrong: put next to `goldenGray` it shows immediately whether the
  transform found the part or something else. Golden-side stages are cheap
  (cached, computed once); target-side stages add real per-frame cost, so
  leave this off outside debugging.
- `node.status()` — green dot `pass · align <score> · Nms` / red ring
  `fail (position+print+background, whichever failed) · align <score> ·
  Nms`, or `different label? · align <score>` when `mismatchSuspected`.
  The node's log line additionally carries the recovered angle and
  magnification, which is usually the first thing worth looking at when a
  whole batch starts failing at once.

## How `checkerboard-calibrate` works

1. Decode the checkerboard photo at native resolution (no downscale — best
   measurement precision), Otsu-threshold it (checkerboards are strongly
   bimodal, so no manual threshold tuning needed), and connected-component
   label the dark squares (`lib/components.js`).
2. Arrange the blob centroids into a `checkerboardRows × checkerboardCols`
   grid and measure the median pixel pitch between adjacent same-colour
   squares, in both axes (`lib/checkerboard.js`). Centroid/pitch-based
   only — no sub-pixel corner refinement, no lens-distortion or
   perspective correction, consistent with `golden-compare`'s
   translation-only scope.
3. `mm/px = targetPitchMm / measured pitch`. Compared against the baseline
saved in `scaleFilePath` (`deviationPercent`, `pass` if within
`allowedErrorPercent`). With no baseline yet, the result is
informational only (`bootstrap: true`) — nothing to deviate from. A
photo too thin to measure a pitch is reported as **not detected** (with
a reason) rather than as a bogus scale.

Grid size counts **dark squares**, not physical squares:
`checkerboardCols` is the number of dark squares per row and
`checkerboardRows` the number of rows. A standard 4×6 physical board has
2 dark squares per row, so it is `cols: 2, rows: 6` — the editor
defaults (`4 × 6`) in fact describe an 8×6 board.
4. `msg.save: true` persists the freshly detected scale as the new
   baseline (`{ mmPerPixelNative, nativeWidth, nativeHeight, calibratedAt }`),
   read by `golden-compare`, which rescales it from the calibration
   photo's *own* native resolution to whatever `workingSize` is in use —
   mm/px is a property of the physical rig, not any one image's
   resolution. If the golden's native resolution differs from the
   calibration photo's (e.g. a PDF render at a different dpi), the node
   warns once; the mm conversion itself stays exact either way.

### Input

`msg.payload` — a photo of the printed checkerboard (Buffer or path).
`msg.save` (bool) — persist the freshly detected scale as the new
baseline. Optional per-message overrides: `msg.targetPitchMm`,
`msg.checkerboardCols`, `msg.checkerboardRows`, `msg.allowedErrorPercent`.

### Output

- `msg.payload` — `true`/`false` pass
- `msg.result` —
  `{ checkerboardDetected, currentScale, detectedScale, deviationPercent, bootstrap, pass, saved, pitchXPx, pitchYPx, nativeWidth, nativeHeight }`
  (scales in mm/px)
- `msg.timings` — `{ totalMs }`

## How `label-crop` works

`label-crop` deskews and tightly crops a physical label out of a camera
frame, so the rest of a flow sees the label straight and centred even when
the part sits at an angle or off-centre. It is the companion to
golden-compare's own alignment: label-crop removes the *placement*
variation (where the label is in the frame), and golden-compare then
measures the *print* (the artwork relative to itself). It is a separate
node so the cropped frame can be previewed, saved, or fed to other
inspection steps.

**Engine.** All pixel work (decode, resize, Otsu, rotate, crop, final
encoding) runs in the optional native OpenCV addon
— the same optional engine `nativeAlignSeed` uses. That package is now a
dependency; it ships published prebuilt binaries for Linux x64/arm64,
Alpine x64, and macOS arm64. If the binary is missing the node reports a
**setup error** on every message rather than silently passing frames
through, because a missing engine would otherwise look like "no label
found".

**Detection.** The frame is decoded once to a raw object, then downscaled
to `maxEdge` (640px long edge by default). OpenCV applies Otsu once; in
`auto` mode the small binary mask and its JS-inverted form cover both
polarities (dark-on-light and light-on-dark), and the better rectangle wins. The JS side only ever sees this small
mask: it finds connected components, takes the dominant rectangle-like
one, traces its exterior, and fits the minimum-area rectangle around the
convex boundary. Interior print holes therefore cannot skew the label angle.

Because the label is part of the bright blob, that rectangle always *contains*
the label. A boundary pass then snaps each side inward to the label's real
edge, so a label that is clipped by the frame or blends into a similarly-bright
table crops to its true boundary instead of the whole bright region. The
primary signal is the **brightness step** — the fraction of the rect that is
label-tone (the "proper white" versus the grayish table, or the inverse for a
dark label) — with the native Sobel **edge** accumulator as fallback for a
seam/shadow boundary on an equally-toned surface. A Sobel line is only trusted
when the strip between it and the region side is dimmer than the label itself,
so a printed barcode band inside the label is never mistaken for its edge.
Clipped sides (label tone reaching the frame edge) stay put. `refinedSides`
lists which sides moved.

Confidence gates turn bad evidence into a **miss**, never a wrong crop:
the blob must fall between `minAreaFraction` and `maxAreaFraction` of the
frame, fill at least `minRectangularity` of its exterior rectangle, and not
exceed `maxBorderContact`. The 0.5 border default permits a label clipped at
two opposite image edges while rejecting a component covering all four.
The candidate must also be at least `minDominance` times the second-best blob
and, optionally, match `aspectRatio` within `aspectTolerance` and cover
`expectedSizeFraction` of the frame within `sizeTolerance`. The combined
confidence must reach `minConfidence`. `auto` polarity reports which side won.

The **label size selector** in the node's edit dialog makes the size gate
visual: load any representative photo and open the **viewer** — a zoomable
modal (wheel / +/− / Fit / 100% zoom, Draw/Pan modes) that shows the image
large, so the drawn rectangle and its corner handles are clearly visible
while you fine-tune it. Apply copies the rectangle into
`aspectRatio` and `expectedSizeFraction` automatically
(resolution-independent: the fraction is relative to that image). The size
gate is applied **after** boundary refinement, so the clipped or
table-blended extents the refinement removes are not counted — a badly
detected rect (halo included, or the wrong product) becomes a clean
`size-mismatch` miss instead of a wrong crop.

**Deskew.** The label's axis-aligned bounding box (plus a small `cropMargin`
ring, so the rotate never samples past the ROI) is cropped from the full
frame and rotated using the detected angle in OpenCV's image-coordinate
convention — only the ROI is ever rotated, never the whole frame. In the rotated canvas the label rect is
axis-aligned, so the final crop is the centred `w × h` rectangle: exactly
tight to the label. No perspective correction; sub-`minRotateAngleDeg`
angles skip the rotate entirely. The final crop is encoded natively in
the chosen `outputFormat` (raw object by default, or jpg/png/webp).

### Input

`msg.payload` — an encoded image Buffer (JPEG/PNG/…) or a raw
`{ data, width, height, channels }` object (the same shapes
`golden-compare` accepts). Per-message overrides: `msg.maxEdge`,
`msg.polarity`, `msg.minAreaFraction`, `msg.maxAreaFraction`,
`msg.minRectangularity`, `msg.maxBorderContact`, `msg.minDominance`, `msg.minConfidence`,
`msg.aspectRatio`, `msg.aspectTolerance`, `msg.expectedSizeFraction`,
`msg.sizeTolerance`, `msg.cropMargin`, `msg.minRotateAngleDeg`,
`msg.previewEnabled`, `msg.previewWidth`, `msg.outputFormat`,
`msg.outputQuality`.

### Output

- `msg.payload` — the deskewed tight crop (raw object by default,
  encoded Buffer otherwise). On a **miss** the original payload passes
  through unchanged, so downstream nodes keep working while the
  detection is being tuned.
- `msg.labelCrop` —
  `{ detected, reason, polarity, angleDeg, center, corners, width,
  height, confidence, areaFraction, rectangularity, dominance,
  borderContact, refinedSides, smallSize, scale, crop, timings }` —
  corners are in the **original frame's** pixel coordinates; `timings`
  breaks the run into `decodeMs` / `detectCopyMs` / `maskMs` /
  `analysisMs` / `edgeMs` / `refineMs` / `rotateMs` / `cropMs` /
  `totalMs` plus per-op engine timings. When preview is enabled,
  `previewMs` records its additional diagnostic work.

Enable **Preview** to render labelled **Before** and **After** JPEG thumbnails
beside the node on the flow canvas. `previewWidth` controls each thumbnail's
width. Previewing does not change `msg.payload`, is off by default, and adds an
extra resize/encode (plus another decode when the original input is encoded).
Click the preview to hide it.

`bench/label-crop-bench.js` renders a synthetic 6000×4000 (24MP) frame
(dark tray, rotated light label with bars) and reports raw, JPEG and PNG
p50/p95 timings.
The 100–500ms/frame target is reported there, not asserted in the test
suite — wall-clock numbers move with the machine. The engine currently decodes
encoded Buffers synchronously while constructing its native worker, so raw
camera frames are preferable when Node-RED event-loop latency matters.

## How `line-finder` works

Find one straight edge inside a region you draw.

Use it when a whole-frame search finds the **wrong** edge - which happens
whenever the strongest contrast near the boundary you want belongs to
something else: printed artwork a few millimetres inside a label edge, a
frame vignette outboard of it, a conveyor rail. A drawn region settles it
by construction, because nothing outside the box can win.

Per region:

1. Sample it in its own (scan, line) axes with bilinear interpolation, so
   a rotated region needs no extra code path.
2. Split the line axis into `calipers` bands and average each band across
   its full width. The averaging is the trick: a 4 grey-level step under 3
   levels of sensor noise is invisible in one row and obvious across two
   hundred.
3. Smooth, differentiate, and take the extremum matching the configured
   polarity, with parabolic sub-pixel refinement - a half-pixel bias over
   a 3000px frame is a millimetre of error.
4. Fit by total least squares (ordinary least squares cannot represent a
   vertical line, and two edges of an upright label are vertical), peeling
   the single worst outlier per pass.

`msg.payload` passes through untouched; the result lands on
`msg.lineFinder` as `{ found, reason, line, angleDeg, score, calipers,
residualPx, points }`. A miss is a normal outcome - only an unusable
payload is an error.

No OpenCV engine is needed, and only the region's own pixels are read, so
the cost follows the box you drew rather than the frame size.

`line-finder` needs no OpenCV engine, and that is a measured choice rather
than a shortcut: the bridge has no reduce and no derivative, and its `resize`
samples instead of area-averaging, so it cannot build the banded mean profile
a caliper is made of. The search is also 2.7x faster than it was, by resolving
the interpolation weights once per region instead of once per sample for any
unrotated region. ARCHITECTURE.md, "Why the caliper search is not OpenCV", has
the numbers.

### Aiming the region

The editor's region selector is a zoom viewer, not a thumbnail: at
thumbnail scale the boundary this node exists to find is not visible at
all. Load a sample and it opens on it, zoomed onto the current region,
drawing the scan direction, the edge being looked for, and one line per
caliper where that band will measure.

Wheel zooms to the cursor, `Fit`/`100%` jump, right-drag pans. Dragging
on empty space draws a new region and takes the scan direction from the
drag; corner handles resize from the opposite corner, dragging inside
moves, the arrow keys nudge by a pixel (ten with Shift), and the amber
grip rotates about the centre to a tenth of a degree. `Apply` writes the
fields, `Cancel` and Escape do not. The footer warns when the box hangs
off the frame, which matters more than it looks: a caliper band that is
not wholly inside the image is skipped, so a box half over the edge
silently loses calipers rather than reading a partial average.

The editor carries its own copy of the region geometry, since it has to
draw exactly what the runtime will scan. `test/editorRegionGeometry.test.js`
lifts that copy out of the .html and runs it against `lib/lineFinder.js`
so the two cannot drift, and `test/lineFinderEditor.test.js` drives the
viewer itself over a small fake DOM.

### Seeing what it did

`previewEnabled` draws the result on the flow canvas: the search region as
configured, every caliper hit (green kept, red dropped by the outlier
trim), and the fitted line, with angle, caliper count, score and residual.
Misses preview too - a score of 0.4 does not tell you whether the box is
aimed at the wrong edge, clipped by the frame, or straddling two steps,
and the picture tells you all three. It re-encodes the frame per message,
so it is for tuning, not production.

### Four of them make a rectangle

`label-crop`'s `boundaryMode: "calipers"` takes four `edgeRegions` and
intersects the fitted lines into the label's corners. On the Inspection
sample set the whole-frame blob search cropped 76 of 148 good frames with
the output aspect swinging 14%; calipers cropped 148 of 148 with the
recovered height stable to 3.5px and the angle to 0.04 degrees.

Tuning notes:

- Start with *Contrast* at 2 and lower it until the edge is found. If it
  finds the **wrong** edge instead, tighten the region rather than raising
  the threshold.
- *Select* = `first` is deterministic when two steps of similar strength
  sit close together; `best` can alternate between them frame to frame.
- *Edges to skip* steps past a known structure - a frame vignette, say -
  without narrowing the box.
- A soft, multi-step boundary (a gradual vignette rather than a clean
  edge) is the hard case: the position is repeatable to a pixel or two,
  but *which* step of the transition wins may not be. Widen the region
  and use `first`.

### An example flow

`examples/label-crop-with-line-finder.json` shows the whole workflow —
import it from the Node-RED menu under **Import → Examples →
@graciousstar/node-red-contrib-vision-tools**. It has two branches: a single
`line-finder` with the preview switched on, for tuning one edge at a time,
and a `label-crop` in calipers mode carrying all four tuned regions,
writing the deskewed crop to `/data/label-crop.jpg`. Each section's comment
node holds the tuning rules and what the numbers mean.

The regions it ships were measured over the 148 good Inspection frames:
found on all 148, recovered label width stable to 1.8px, height to 5.2px,
deskew angle to 0.14 degrees — and 6 of the 14 bad frames refused outright,
those being the blanks, which have no label boundary to find.

Two things in it are worth copying to another rig:

- `edgeSelect: "last"` on the left and right edges. Both are a soft
  multi-step transition, so `best` flips between two similar steps from
  frame to frame; taking a *positional* step instead pulled the width
  spread from 38px down to 1.8px.
- `minCaliperFraction: 0.2` on the bottom edge. Only about a third of its
  calipers ever see it — 5 of 16 at worst — so at the 0.5 default
  `label-crop` reports it missing on 76 of the 148 frames. Lowering the
  fraction is the fix there, not raising contrast.

## How `barcode-locate` works

Finds and decodes barcodes (1D and 2D) via
[`zxing-wasm`](https://github.com/Sec-ant/zxing-wasm), a WebAssembly build
of the `zxing-cpp` engine — genuine multi-symbol detection, rotation
tolerance and native DataMatrix support.

### Why regions

Scanning a whole multi-megapixel photo costs on the order of a second,
almost all of it the detector's own search over the full frame. On a fixed
rig — the same assumption the rest of this package makes — barcodes land
in roughly the same place shot to shot, so telling the node where to look
turns that into a handful of single-digit-millisecond crops: measured
~2–15ms per region against ~1.4s for the same image scanned whole, on a
4096×5500 photo.

Mode **"Regions, then full image if nothing found"** (the default) keeps
the whole-image scan as a safety net — a repositioned label, a mis-measured
region — without paying for it on every normal run. `"Regions only"` and
`"Full image only"` are also available.

### Input

`msg.payload` — a Buffer/Uint8Array/ArrayBuffer, a file path string, or an
object with `data`/`buffer`/`path`. Optional per-message overrides:
`msg.regions`, `msg.mode`.

### Output

One message per barcode found, in the order regions were scanned (then the
full-image fallback, if it ran): `msg.text`, `msg.format`, `msg.roi`,
`msg.regionLabel`, `msg.source` (`"region"` or `"fullImage"`),
`msg.decodeMs`, `msg.timings`, and `msg.payload` set to a preview crop of
that barcode's region. If nothing is found at all, one message with
`msg.text = null`.

### Notes

- **EAN-8 is off by default.** It is short enough that ZXing
  implementations have a real chance of matching noise in a barcode-free
  crop as a confident *wrong* result, which is worse than "not found".
  Enable it only where an EAN-8 code is actually expected.
- **`tryHarder` and `tryRotate`** are both on by default and both matter
  for recall — see the in-editor help.
- The first decode after a redeploy pays zxing-wasm's one-time WASM warmup.
  `lib/locate.js` absorbs that so it never lands on a user-visible message.

## Notes

- `goldenPath`/`scaleFilePath` are paths **inside the container** — use
  `/data` for anything that should survive a rebuild.
- The working canvas the frame is decoded onto is sized by the calibrated
  mm/px if there is one, and otherwise by the same-rig assumption (one
  native pixel spans the same distance in both images). That sizing no
  longer has to be *right*, because the magnification search absorbs the
  error — which is what lets an artwork golden work at all. The two are
  not substitutes, though: the search recovers whatever scale it needs to
  compare the images, while calibration is what tells you a pixel's worth
  in millimetres. Only the latter makes the position numbers physical, so
  calibrate if the position tolerance is specified in mm.
- What survives on a good part, once the geometry is right, is genuine
  artwork-versus-print difference rather than misalignment: dot gain and
  focus shift stroke weight slightly. Most of it is threshold-straddling
  rather than real, which is what `inkMargin` is for (above); widen
  `printTolerance`/`backgroundTolerance` for whatever is left, rather than
  loosening the alignment.
- **The global transform places the label; it cannot place all of it.**
  After a correctly recovered 5-DOF fit on this project's good pair, the
  leftover displacement still has a median of 0.73px, a 90th percentile
  of 1.55px, and individual regions sitting 4-5px out that match their
  golden counterpart near-perfectly once shifted. Raising the global
  model does not reach that: fitting a homography (8 DOF) to the measured
  field removed 18% of it and a full quadratic (12 DOF) only 27%, because
  no global warp can pull one corner 5px while leaving the two thirds of
  the label that is already sub-pixel alone. A label on a formed tray is
  not a plane.

  So **Refine alignment per tile** (`localAlign`, on by default) lets each
  tile take up its own offset, capped at `localAlignMax` (3px) so a tile
  can never slide far enough to hide a fault, and skipping tiles too flat
  to localise.

  Its value does not show up as a lower defect ratio, which is what makes
  it easy to dismiss: at loose tolerances the dilation was already
  forgiving the fringing this removes. It shows up as **headroom**. On the
  demo pair, `printTolerance`/`backgroundTolerance` of 2/1 fails the clean
  part without refinement (a false region at density 0.250) and passes it
  with (zero regions), while the marked capture still fails either way.
  That is why the tolerance defaults are 2/1 rather than the 5/3 they had
  to be before - roughly a two to threefold improvement in the size of
  defect that can be gated. **If you turn `localAlign` off, widen them
  again**, or the registration error it was absorbing will fail good
  parts. Look at the `targetFgAligned` stage against `goldenFg` to see the
  difference directly: body text goes from doubled to solid.
- **Train the transform once instead of re-deriving it every frame.** The
  alignment splits by what physically varies: magnification and press
  stretch come from the camera's standoff and the press's pull on the
  media and do not change between parts, while translation and rotation
  are where this part happens to be sitting. Tick **Train the transform**
  with a **Trained transform** path set (or send `msg.trainTransform`),
  and the node measures `scaleX`/`scaleY` from that frame, writes them
  down, and pins them on every later frame — solving only position and
  angle. To train from any two images rather than the configured golden,
  send `msg.golden` alongside `msg.payload`.

  It roughly halves the time (2.0–2.7x on this project's captures), but
  the reason to do it is accuracy, not speed: a search free to re-solve
  magnification per frame can pick wrong, and it is likeliest to do so on
  a badly printed label — precisely the case the inspection exists for,
  because poor print gives the search poor evidence. One such capture
  went from 945 regions to 25 once its transform was pinned.

  Three things to know. A trained record is tied to its golden and
  working size, and both are checked on load; a mismatch is refused with
  a reason rather than silently applied. "Its golden" means the image,
  not the route the image took: the record stores a hash of the golden's
  bytes alongside the cheap cache key, so training through `msg.golden`
  and then producing frames from the configured **Golden image path**
  reuses the record instead of refusing it every frame. (Before 1.1.1 it
  refused, warned, and searched — the flow the paragraph above tells you
  to use.) Records trained before 1.1.1 have no content hash; retrain
  once. Scales outside a sane physical range (0.05–100) or an unreadable
  file are refused the same way — the node searches unpinned rather than
  applying nonsense (a corrupted record can no longer hang the flow). But the **stretch belongs to the
  print run, not to the golden**, so a new run on the same artwork needs
  retraining and no file check can see that coming — on this project's own
  samples two captures from a different run want 5.9% where the rest want
  4.5%, and forcing the wrong one on them produced ~1000 false regions.
  What does catch it is the alignment residual jumping clear of what
  training measured, and the node warns when it does.

  Pinning also costs a little defect sensitivity: the polish objective is
  computed on a decimated canvas, so it cannot resolve a single full-res
  pixel of translation, and a pinned run can settle a pixel from where the
  searched run lands. On the demo capture the marked defect still fails
  the part, but as one region at density 0.156 rather than five at 0.172.
- **The coarse search can pick a wrong scale, and used to be unable to
  take it back.** Stages 1-3 rank candidates by a density proxy - ink per
  grid cell - which cannot separate a correctly scaled match from one a
  few percent off that happens to drop its ink in the same cells. Whatever
  it picked, every later stage searched a narrow band around that pick.
  The symptom is a whole frame failing at roughly 0.5% residual scale
  error: about 10px of drift across the label, which on 1-2px strokes is
  total disagreement, so hundreds of regions light up on a part whose real
  faults are two small blemishes. `alignCandidates` (default 5) keeps that
  many scale hypotheses alive through the fine stage and then picks
  between them on **real pixel disagreement** rather than the proxy. On
  this project's samples one capture went from 315 regions to 10 with no
  change to any pair that was already aligning. Set it to 1 for the old
  greedy behaviour.
- `transform.score` is the alignment residual and is worth logging: on
  these samples anything at or below ~0.05 tracks a handful of regions,
  while ~0.10 tracks a thousand. A frame that fails everywhere with a high
  score is misaligned, not defective - check that before believing the
  blemish numbers, and check that the golden is the right *product* (two
  different labels will happily align to a mediocre score and then
  disagree everywhere).
- **`workingSize` decides what defects are physically detectable, and it
  is the setting to reach for first when something real is being missed.**
  It is not merely a speed/quality dial: downscaling averages a thin mark
  into the substrate around it. A ~4px pen line on a 4096×5500 capture
  measures grey 20 (essentially black) at `workingSize` 3072, but grey
  **120 against a threshold of 143** at 1024 — 22 levels of contrast,
  three quarters of the way to invisible. No downstream setting recovers
  that; the evidence is gone before the threshold runs. Symptom to
  recognise: the defect shows up in the raw `backgroundDefect` debug stage
  as a scatter of specks rather than a stroke.
- Once the mark survives decoding it still has to form a *region*, and a
  ~1.6px-wide stroke covers only ~14% of a 16×16 block — just under the
  0.15 `blockThreshold`. Halving `blockSize` to 8 is what lets a hairline
  raise a region at all.
- Worked recipe for catching a hairline against PDF artwork, validated on
  this project's samples: `workingSize` 3072, `inkMargin` 64, `blockSize`
  8, `failThreshold` 0.1. That gives a clean good part **0 background
  regions** and a good part with one added pen line **5 regions at density
  0.172**, while all fifteen known-defective captures stay saturated
  (density 1.000, 600+ regions, defect ratios above 0.05) — so the wide
  margin costs nothing on real faults. It costs time: roughly 2–3.4s per
  frame against 1.6s at `workingSize` 1024.
- `golden-compare`'s golden reference is only re-decoded when its source
  (for a file: the path **plus the file's mtime and size**, so an
  in-place overwrite of the artwork re-decodes; for a buffer: its hash,
  or `msg.goldenKey`), `workingSize`/`threshold`/`thresholdMode`/
  `sauvolaRadius`/`sauvolaK`/`inkMargin`/`backgroundTolerance`/
  `debugStages`, the calibrated scale (including the calibration photo's
  native resolution), or raw geometry changes —
  `printTolerance`/`alignSearch`/etc. are applied fresh per frame and
  don't need a re-decode.
- Turn off `outputPrintHeatmap`/`outputBackgroundHeatmap` for maximum
  throughput if only the pass/fail decision and region lists are needed.
- `sharp` ships prebuilt binaries for Alpine/musl, so no libvips
  source-compile is needed in this project's Docker build stage.

## Tests

`npm test` (Node 18+, no test framework needed — `node --test`), 290
tests. Fixtures are generated with `sharp` rather than read from
`data/sample_images`, so the suite runs anywhere; the real QC photos are
gitignored. Coverage spans the lib pipeline (`compare`, `align`, `warp`,
`localAlign`, `checkerboard`, `threshold`), the worker pool (byte-identity
against serial, mid-flight termination, oversized pools, and two
overlapping dispatches), and the Node-RED glue itself —
`golden-compare.js` and `checkerboard-calibrate.js` are exercised through
a fake-RED harness (`test/glue.test.js`,
`test/checkerboardCalibrate.test.js`) so image resolution, cache
invalidation, `msg.rawInfo` handling and calibration files are tested
without a running Node-RED.

Three of the suites assert something other than a value:

- `test/fingerprint.test.js` counts digests and file reads, because the
  property is that the work does not happen at all — "it is fast now" is
  not a thing a test can hold onto.
- `test/parallel.test.js` asserts the pooled stages are byte-identical to
  their serial twins. A divergence would look like a flaky camera rather
  than a bug.
- `test/editorDefaults.test.js` parses the `defaults` block out of each
  `.html` file and compares every entry against its runtime fallback.
  Node-RED does not backfill a new default into existing node instances,
  so a disagreement only shows up in flows nobody is editing.
- `test/editorRegionGeometry.test.js` lifts the region geometry out of
  `line-finder.html` and runs it against `lib/lineFinder.js`. The editor
  needs its own copy to draw what the runtime will scan, and two copies
  of a rotation convention drift silently — the box drawn stops being the
  box searched.
- `test/lineFinderSampling.test.js` compares the two profile builders
  with `strictEqual` rather than a tolerance. The fast one exists only
  for speed, so the only acceptable difference is none.

`bench/frame-bench.js` is a stopwatch rather than a test and is not picked
up by `node --test`. Pass `--pin mx,my` when comparing two versions:
without it each version pins to the magnification it recovered itself, and
the two are then not solving the same problem.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

`sharp`, `zxing-wasm` and the optional native OpenCV engine are separate
packages under their own licences.
