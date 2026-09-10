# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A trained nuisance map, and the two false accepts it fixes.** The
  background blemish check asks whether a block carries more ink than the
  golden says it should, and that question has a floor it cannot see past:
  wherever the golden has a hard ink edge, sub-pixel misregistration paints
  a thin line of "extra ink" that is not a defect. Those artifacts are not
  random - they land in the *same place on every frame*, because the thing
  causing them is a printed feature that is always there. On the reference
  run an 8px strip at (112, 168) reached density 0.25 in 78 of 148 good
  frames and one at (72, 2088) in 143 of them, which is the floor
  `failThreshold` has to clear. A real defect measured 0.39 and was
  therefore invisible - not because it was weak, but because the floor was
  high. Every aggregate metric agreed: the good frames scored *worse* than
  the two that were slipping through (maxCells 24 vs 23, defectRatio
  0.00042 vs 0.00019), so no threshold on any of them could separate the
  classes.

  `lib/nuisanceMap.js` trains a per-block baseline from known-good frames
  and scores each block by how far it exceeds its own history rather than
  by magnitude: `excess = max(0, density - baseline)`. A recurring artifact
  scores ~0 however dark it is; a blemish where the part is normally clean
  scores its full density. Held out - every good frame scored against a map
  trained without it - the worst good frame reaches 0.2500 (74 training
  frames) or 0.2655 (37), while the two defects reach 0.3281 and 0.3906.

  Driven end to end through the real `golden-compare` handler over the same
  162 images: **0 of 148 good rejected, 0 of 14 bad accepted**, down from 2
  accepted. Set a *Nuisance map* path and tick *Train the nuisance map* to
  build one; `noveltyThreshold` (default 0.30, 0 disables) is the gate.

  Layered on the existing density and ratio gates, never replacing them,
  and inert until a map is trained - an untrained rig behaves exactly as it
  did. Maps carry the same identity guards a trained transform does and are
  refused, with a warning, against a different golden, working size, block
  size or grid shape.

  **Its limit, stated plainly:** it cannot see a defect that lands exactly
  on a chronically dirty spot, because there the baseline it is measured
  against is the artifact’s own. And the usable threshold window is narrow
  (~0.27-0.32), with its lower edge set by how many frames trained the map.
  Train on as many good frames as the line will give you - 100+ is
  comfortable, below ~40 a false reject becomes likelier than a miss. If
  false rejects appear, add training frames rather than raising the
  threshold, which trades directly against the defect this exists to catch.

### Changed

- `msg.result.backgroundBlemish` gained `worstExcess` and `noveltyPass`,
  reporting how far the dirtiest block exceeded its trained baseline and
  whether that alone failed the frame. Both are 0/true without a map.

### Fixed

- **`allowScripts` pinned versions that no longer install.** The gate matches
  on `name@version`, so both pins had quietly stopped matching: the OpenCV
  engine was pinned at 1.6.4 against a lockfile resolving 1.7.0, and `sharp`
  at 0.35.3 against 0.35.4. A stale pin means the install script either does
  not run - which for a package that links a prebuilt binary means it never
  sets itself up - or the gate reports an unrecognised package, and neither
  surfaces until a clean install. `test/allowScripts.test.js` now fails the
  suite when a pin drifts from the lockfile.

- **`cvjs` resize read a small percentage as an upscale.** `pct` and `scale`
  shared one branch that guessed between them by magnitude - values over 5
  read as a percentage, the rest as a multiplier - so asking for 5% returned
  a 5x enlargement. They are separate modes now and each rejects a
  non-positive value. Nothing in this package asked for a downscale that
  small, so it never bit; it was still a trap in the function every op
  routes through.

- **Dead code in the engine selector.** `select()` threaded a
  `gatePlatform` flag that both call sites passed as true, so the ungated
  branch was unreachable while reading as though some caller deliberately
  bypassed the platform check. Removed. The unreachable `catch` on
  `resolvePromise` is kept, now with a comment saying why: `resolve()`
  encodes failures in its resolved value rather than rejecting, but if that
  ever changes a cached rejection would block every retry.

## [1.1.0] - 2026-09-10

### Added

- **A second OpenCV engine: `@techstark/opencv-js`, the WASM build
  (prototype).** `label-crop` and `golden-compare`'s two opt-in
  acceleration paths needed the native `@rosepetal/node-red-contrib-image-tools`
  addon, which has no win32 binary. Because `label-crop` treats a missing
  engine as a setup error rather than a fallback, that made the node
  unrunnable on Windows - and made every integration test of it
  unrunnable too, which is why the suite only ever exercised it against a
  fake engine there.

  `lib/cvjs.js` implements the same op surface the callers were written
  against - `colorConvert`, `resize`, `filter` (otsu, edge), `crop`,
  `rotate` - on opencv.js, and `lib/cvjsAlign.js` adds `imageAlign` (ORB
  + RANSAC affine, ECC refinement, one warp into the reference frame).
  Argument positions, the raw descriptor shape and the return values
  match the bridge, so it drops into the `engine` seam both callers
  already had.

  Raw in, raw out: opencv.js ships without image codecs, and the rig
  feeds raw frames anyway. The two points the bridge contract genuinely
  needs a codec - an encoded Buffer at `colorConvert`, a non-raw
  `outputFormat` on the final crop - delegate to `sharp`, already a
  direct dependency.

- **`lib/engine.js` chooses between them.** Native where a prebuilt
  binary exists, WASM everywhere else; `VISION_TOOLS_ENGINE=native` or
  `=opencv-js` pins one, and a pinned engine that cannot load is an error
  rather than a silent substitution - a benchmark should not be able to
  quietly measure the wrong engine. Detecting the native addon is
  asynchronous (its `require()` always succeeds and every op rejects
  later instead), so the module answers synchronously on a platform gate
  and asynchronously on a probe. The probe is not `bridge.ready()`:
  cpp-bridge 1.6.4, which our own `^1.6.4` range allows and which the
  Node-RED test image actually has, does not expose it, so asking would
  throw and demote a perfectly good native engine. It calls the cheapest
  real op instead.

- **Benchmarks and probes that need both engines.**
  `bench/engine-compare.js` times them over the same frames;
  `bench/engine-parity.js` checks they decide the same thing;
  `bench/resize-probe.js` and `bench/blur-probe.js` identify what the
  native engine's `resize` and `filter("otsu")` actually do, which is how
  the two matched below were found.

- **`test/cvjs.test.js` and `test/engine.test.js`.** The first exercises
  the ops against the geometry `label-crop` predicts independently, then
  runs the real deskew-and-crop pipeline and `golden-compare`'s
  `nativeFastAlign` path against a real OpenCV - on any platform, which
  was the point.

### Changed

- **The blemish heat-map grid no longer builds a summed-area table.**
  `buildHeatmapGrid` allocated and filled a full-resolution `Uint32`
  integral table just to read non-overlapping blocks out of it - every
  pixel is counted exactly once, so the table buys nothing. Measured in the
  Node-RED test container against the real golden-compare handler over 162
  images (see `bench/golden-performance.md`): the grid/region stage drops
  from **22.5ms to 8.7ms median** and whole-frame comparison latency from
  **110.6ms to 96.2ms (13%)**, avoiding ~25MB of temporary table allocation
  per frame at a 1475x2125 golden. All 162 complete result objects were
  byte-identical before and after, and `test/heatmapGrid.test.js` pins the
  densities against the old implementation as an exact oracle over clipped
  edge blocks, empty and full masks, block sizes 4-256 and the deployed
  geometry. The common path only - the unpinned-search tail (p99/max) is
  unaffected and was not improved.

### Fixed

- **The alignment warp invented ink at the frame border.** OpenCV fills
  what the warp does not cover with 0, the darkest possible ink, and
  `nativeSeed.blankOutsideSource` rewrites the pixels whose source
  coordinate fell outside back to 255. It cannot reach the covered pixels
  one step inside that boundary, whose value bilinear interpolation has
  already mixed with the black fill - leaving a one-pixel dark rim the
  background check reads as ink the part does not have. On a 512x640
  synthetic shifted 6px that rim alone is a 0.24% defect ratio, over the
  0.2% `failRatio`, failing a frame the JS aligner passes.
  `lib/cvjsAlign.js` fills 255 instead - blank substrate, the convention
  `lib/warp.js` already uses for exactly this reason. This is a
  divergence from the native engine, which has no border-value parameter
  to pass.

### Notes

- **The two engines produce identical `label-crop` results.** Verified on
  Alpine x64 with both installed, over a sweep of angles and label shapes:
  every field matches exactly. Two undocumented native behaviours had to be
  matched to get there, both found by running the engines side by side:

  - `resize` is `INTER_LINEAR` (100% of pixels reproduced; `INTER_AREA`,
    the textbook choice for a detection copy and the first implementation
    here, differs by 34 mean absolute and cropped a 1200x750 label at
    angle 0 169px short);
  - `filter(img, "otsu", kernel, ...)` GaussianBlurs `img` (kernel x
    kernel, sigma 0) and writes the result back **over the caller's
    buffer** before thresholding. `label-crop` then runs its edge filter
    and its whole boundary refinement on that blurred copy, and depends on
    it - the blur is what stops an axis-aligned label refining onto its own
    printed rules. `lib/cvjs.js` reproduces the side effect deliberately;
    the real fix belongs in `label-crop`, which should ask for the blurred
    copy rather than inherit one.

- **Timing, same host:** `label-crop` 34ms native vs 64ms WASM at 3MP,
  162ms vs 375ms at 24MP; `imageAlign` 12ms vs 30ms at 768px, 18ms vs 53ms
  at 1024px. Roughly 2-3x, plus ~200ms once per process for the WASM
  runtime. The WASM engine is single-threaded and runs on the event loop;
  the native addon threads.

- **Two bad-folder images are still accepted, and speeding up counting did
  not change that.** Over the container’s 162-image set every variant
  accepts all 148 good images and rejects only 12 of 14 bad ones; the two
  false accepts pass the downstream `grade === "good"` check on both the
  old and the new code. No threshold was relaxed for performance - this is
  a pre-existing defect/ground-truth question, and the current settings
  should not be called production-validated until it is investigated. See
  `bench/golden-performance.md`.

- **The native `imageAlign` returns identity above ~1536px.** On both
  1.6.4 and 1.7.0 it recovers an 11px shift at 1280 and reports no shift
  at all at 1536, 2048 and 2656, with `success: true`.
  `golden-compare`'s fast-align bench runs at `workingSize: 2656`, inside
  that range - the score guard catches the bad transform and falls back to
  the JS aligner, which is presumably why it was never noticed. The WASM
  implementation recovers the shift at every size tested. Both fast-align
  paths remain opt-in prototypes, off by default.

## [1.0.1] - 2026-09-10

### Fixed

- **The changelog described a different package.** This file was carried over
  from the two packages these nodes were split out of, so a package published
  at 1.0.0 shipped a history listing releases up to 1.1.3 - including a
  `[1.0.1]` that would have collided with this entry. Those entries are still
  here, under *Earlier history*, because they record how the code got to where
  it is; they are now labelled as belonging to the predecessor packages rather
  than to this one.
- **`npm ci` could not install this package, with nothing to say why.** The
  optional OpenCV engine declares a `darwin-x64` platform package that was
  never published - the registry returns 404 for it while its four siblings
  resolve - so `npm install` skips it, as an optional dependency should be
  skipped, and `npm ci` then rejects the lockfile `npm install` wrote because
  that phantom is "Missing from lock file". No lockfile satisfies both while
  the engine is in the tree. The README now says so, and gives the two ways
  round it. Nothing in this package can fix the upstream declaration.

## [1.0.0] - 2026-09-09

First release under this name. `golden-compare`, `checkerboard-calibrate` and
`label-crop` come from `node-red-contrib-golden-compare`, `barcode-locate`
from `node-red-contrib-barcode-locate`, and `line-finder` was new in the last
weeks of that work. Everything below in this entry shipped in it.

### Added

- **`line-finder` - find a straight edge inside a region you draw.** A row
  of calipers scans across an operator-drawn region, each reports where the
  brightness steps (with parabolic sub-pixel refinement), and a line is
  fitted through those points by total least squares with outliers peeled
  one at a time.
  Pure JS over a grayscale raster in `lib/lineFinder.js` - no OpenCV engine,
  and only the region's own pixels are touched, so cost follows the drawn
  box rather than the frame.

  It exists because a whole-frame search finds the *strongest* edge, which
  is not always the wanted one. On the Inspection rig the label's own
  boundary is a 4-10 grey-level step while the printed rules a few
  millimetres inside it are 25-90, so the blob search locks onto the print.
  A drawn region settles it by construction. Each caliper averages its whole
  slice, which is what makes a 4-level step findable: invisible in one row,
  unambiguous across two hundred.

  Reports `{ found, reason, line, angleDeg, score, calipers, residualPx,
  points }`; a miss is a normal result, not an error. The editor has a
  drawing canvas where the drag direction sets the scan direction, and an
  optional flow-canvas preview draws the region, every caliper hit (green
  kept, red dropped) and the fitted line over the frame - misses included,
  since that is when seeing the box matters most.

- **`label-crop` gains `boundaryMode: "calipers"`.** Four `edgeRegions`
  (left/right/top/bottom) are fitted and intersected into the label's
  corners instead of thresholding the whole frame. Runs at full resolution
  rather than on the `maxEdge` detection copy - a caliper measures a
  position, and a 640px copy costs a factor of six in every reading. Any
  edge that is not found fails the frame, per label-crop's existing rule
  that bad evidence is a miss and never a wrong crop; `metadata.edges`
  carries each edge's own outcome so a region that needs re-aiming can be
  identified. `boundaryMode` defaults to `"blob"`, so existing flows are
  unchanged.

  Measured over the 148-good Inspection set: the blob search cropped 76 of
  148 frames with output aspect swinging 0.650-0.743 (14%); calipers cropped
  **148 of 148** with recovered height stable to 3.5px (0.1%) and angle to
  0.04 degrees. It also refuses the blank parts outright - there is no
  boundary to find on an unprinted label - which the blemish channels
  cannot see at all.

- **The caliper search is 2.7x faster, with byte-identical output.** An
  unrotated region has the image's own axes, so the interpolation weights along
  the scan depend only on the step index and the cross-axis pair only on the
  row. `profilesAxisAligned` resolves both once per region instead of once per
  sample and drops the per-sample function call, taking this rig's four edges
  from 34.5ms to 12.8ms. Every region in the example flow and all four edges of
  an upright label qualify; a rotated region keeps the general path.

  The interpolation is *not* skipped, which would have been the easy 11x: the
  scan samples at `s + 0.5` while `sampleBilinear` puts pixel centres on whole
  numbers, so every sample sits between two columns and dropping the blend
  would move every measurement half a pixel.
  `test/lineFinderSampling.test.js` compares the two builders with
  `strictEqual`, value by value, over fractional origins and sizes, band counts
  that do not divide the region, single-row bands, and regions hanging off each
  edge of the frame. The 148-frame sweep is unchanged: 148/148, width spread
  1.84px, height 5.17px, angle 0.14 degrees.

  ARCHITECTURE.md now records why this is JS rather than OpenCV, with the
  measurements: the bridge has no reduce and no derivative, and its `resize`
  samples rather than area-averages - it missed a single bright row entirely
  when asked to reduce 2800 rows to 16 - so it cannot build the banded mean a
  caliper is made of. It also records the one finding that points the other
  way: for an encoded payload, sharp decodes 1.5x faster than the engine for
  bit-identical pixels.

- **`line-finder` gets a zoomable region selector.** The editor's search
  region was drawn on a 360px thumbnail, which is the one scale at which the
  faint boundary this node exists to find is invisible - so the region could
  only ever be aimed approximately, then corrected by typing numbers. Loading
  a sample now opens a modal viewer on it, zoomed onto the current region,
  with wheel-to-cursor zoom, Fit/100%, and right-drag pan. Dragging on empty
  space draws a new region and still takes the scan direction from the drag;
  corner handles resize from the opposite corner, dragging inside moves, the
  arrow keys nudge by a pixel (ten with Shift), and an amber grip rotates the
  region about its centre to a tenth of a degree. Apply commits, Cancel and
  Escape do not.

  The overlay draws what the search will actually do rather than just a box:
  the scan direction, the edge being looked for, and one line per caliper
  where that band will measure - so `calipers` and the region's length stop
  being abstract numbers. The footer calls out a region hanging off the frame,
  which is worth knowing because a band that is not wholly inside the image is
  skipped, not partially averaged. The thumbnail also draws a rotated region
  as the parallelogram it is; it used to draw an upright box whatever
  `regionAngleDeg` said.

  Two new suites cover it. `test/editorRegionGeometry.test.js` lifts the
  editor's copy of the region geometry out of the .html and runs it against
  `lib/lineFinder.js`, because two copies of a rotation convention drift and
  the failure is silent - the box drawn stops being the box searched.
  `test/lineFinderEditor.test.js` drives the viewer itself over the small fake
  DOM in `test/helpers/fakeEditorDom.js`: drag, resize, rotate, nudge, Cancel
  discarding, Escape not leaking window listeners.

- **An example flow: `examples/label-crop-with-line-finder.json`.** Importable
  from the Node-RED menu (Import -> Examples). Shows the two-step workflow the
  calipers mode expects - tune one edge at a time in a `line-finder` node with
  the preview on, then paste the four regions into `label-crop` - and carries a
  set of regions measured on the Inspection rig: found on all 148 good frames,
  recovered label width stable to 1.8px, height to 5.2px, deskew angle to 0.14
  degrees, with 6 of the 14 bad frames refused because a blank has no boundary.
  Its comment nodes hold the tuning rules, including the two that mattered
  most here: `edgeSelect: "last"` on the soft left/right transition (which took
  the width spread from 38px to 1.8px, since `best` flips between two similar
  steps), and `minCaliperFraction: 0.2` on the bottom edge, which only about a
  third of its calipers ever see. The third comment records what cropping does
  *not* fix, so the flow is not mistaken for an inspection improvement.

- **`nativeFastAlign` - an aggressive OpenCV prototype, off by default.**
  OpenCV now has an opt-in path that owns decode, unrestricted affine
  registration, and the global warp. This bypasses both JS summed-area
  tables, all density sweeps, the pixel polish, and the JS global warp.
  Local tile refinement and the existing blemish policy still run. A native
  failure falls back to the JS implementation, and `result.transform.native`
  reports which path ran. Native fits are also rejected when they exceed
  `maxAngleDeg`, drift more than 3% from either trained magnification, or
  score above 0.15; `result.transform.nativeFallback` carries the reason.

  This path is deliberately not verdict-identical: it permits shear, uses
  OpenCV's nearest-neighbour warp, does not preserve pinned magnifications,
  and scores full-resolution post-local mask disagreement. On the available
  clean/reject pair it changed the clean frame from fail to pass while the
  marked reject still failed with four background regions. Median warm
  container measurements, 4096x5500 PNG, 12 workers, diagnostics off:
  663ms -> 243ms clean and 1065ms -> 443ms reject. Reproduce with
  `bench/opencv-fast-bench.js`.

- **`nativeAlignSeed` - a prototype, off by default.** The pinned search
  can start from an ORB+ECC alignment measured by the optional
  optional native OpenCV engine instead of from the
  staged sweeps. On a 4096x5500 frame, pinned: align 545ms -> 338ms,
  search 325ms -> 125ms. `result.transform.seeded` reports whether a seed
  was actually used.

  The engine is not a dependency and nothing changes without it -
  installing the optional native engine enables it. A seed
  replaces the sweeps' *guess* only: the trained magnifications are still
  the trained ones, polish still refines against real pixels, and it still
  produces the score. Seeds are range-checked and discarded on anything
  implausible, because the engine reports success for results that are
  plainly wrong - its features-only pipeline returned scaleX 33.7 at 97
  degrees on this project's own sample with success=true.

  **Not ready to be the default.** Across five fixtures every verdict
  matched, but the evidence behind one did not: the reject sample yields
  two background regions seeded against one unseeded. Scores move in both
  directions (0.040663 -> 0.040401 on a clean part, 0.040558 -> 0.040846
  on a rotated one). ORB is feature matching, and the badly printed parts
  this inspection exists to catch are exactly the ones with the poorest
  features - that needs validating against a real reject set before this
  can be trusted by default.

---

## Earlier history

Everything below belongs to the two packages this one was split out of -
`node-red-contrib-golden-compare` (versions 1.0.0-1.1.3) and
`node-red-contrib-barcode-locate`. The version numbers are theirs, not this
package's, and are kept because they record why the code is shaped the way it
is. This package's own history starts at 1.0.0 above.

## golden-compare 1.1.3 - 2026-08-29

### Changed

- **Both per-frame summed-area tables are built on the worker pool.** The
  mask table the transform search reads and the grey table every
  candidate warp reads were the two largest pieces of per-frame work
  still running single-threaded on the main path, while the pool that had
  just been widened sat idle. The serial form fuses each row's prefix sum
  with the column accumulation - cache-friendly, but it reads the row
  above as it writes, so no two rows can run at once. As two passes each
  dimension is independent.

  The arithmetic is unchanged and the tables are byte-identical to the
  serial ones at any core count: Uint32 addition is exact modulo 2^32,
  and the Float64 table only ever holds small exact integers, which is
  why it was Float64 to begin with. `test/parallel.test.js` asserts both,
  and the serial implementations remain the reference.

  Measured on a 4096x5500 frame, pinned, 12 workers: align 677ms → 539ms,
  grey table 113ms → 39ms, frame 889ms → 748ms. Transform, score and both
  blemish verdicts identical - `ox 232.97456593793459`, `score 0.040663`,
  on a clean part and on the one with a background defect.

## golden-compare 1.1.2 - 2026-08-29

### Changed

- **The worker pool's automatic size is capped at sixteen, not eight.**
  The old cap was measured against the defect scan, whose speedup curve is
  flat past eight workers. The alignment polish is a different workload -
  ~15 sequential rounds of a ten-candidate batch, where each round pays a
  fixed dispatch cost and finishes no sooner than its slowest worker - and
  it keeps improving to about twelve. Measured on a 16-core host against a
  4096x5500 frame, pinned: polish 342ms -> 220ms, align 798ms -> 680ms,
  with bit-identical transforms, scores and blemish verdicts at every pool
  size. Live end to end, the frame went 1.38s -> 1.14s. Hosts with nine
  cores or fewer are unaffected, and an explicit `workers` setting is
  still taken literally.

## golden-compare 1.1.1 - 2026-08-29

### Fixed

- **A trained transform is tied to the golden's content, not to how the
  golden was delivered.** Training through `msg.golden` and then
  producing frames from the configured golden path - the documented
  "train from any two images" flow - wrote a record keyed `buf:<sha1>`
  and then checked it against a frame keyed
  `path:<file>:<mtime>:<size>`. Identical bytes, different key form, so
  the record was refused on *every* frame and the node fell back to the
  full search behind a `node.warn()` that is easy to miss: the tick,
  trigger, untick sequence looked like it had trained, and the search
  kept running. A record now also carries `goldenContentKey`, a hash of
  the golden's bytes, which is consulted only when the cheap keys
  disagree - a real golden change is still refused, and the hot path
  still never reads or hashes the golden. Records written before this
  release have no content hash and are still refused on a key-form
  mismatch; retrain once. Measured on the reproduction: 1029ms of search
  per frame, unpinned, becomes 348ms pinned.

### Added

- `result.transform.pinRefused` carries the reason whenever a trained
  record was found and declined. The warning stays, but a refused pin is
  otherwise invisible from the message alone - same shape, same pass or
  fail, silently slower.

## golden-compare 1.1.0 - 2026-08-29

The whole image pipeline moves off Node-RED's event loop into a worker.

A frame is ~600ms of CPU and Node-RED has one thread, so an unpinned
frame blocked the runtime for **1499ms** - measured - stalling the editor
websocket, HTTP endpoints, MQTT keepalives and every other flow in the
instance. Worst contiguous main-thread block per frame is now **~14ms**,
of which ~13ms is copying a 23MP payload into shared memory.

**This does not make anything faster.** A 600ms frame is still 600ms; it
stops being 600ms of frozen runtime. Measured node-level `totalMs` is
unchanged (1397ms vs 1496ms median, ranges overlapping).

Minor rather than patch: `golden.gray` and friends already changed type
in 1.0.2, and this release changes threading behaviour that a flow can
observe.

### Changed

- `prepareGolden`, `compareFrame` and `measureCheckerboard` all run in a
  single persistent inspector worker, with the existing worker pool
  nested inside it. `checkerboard-calibrate` is included because it runs
  at full sensor resolution with no downscale - ~59ms of synchronous work
  on a 5520x4140 capture.
- The inspector outlives a redeploy, like the worker pool, and `prepare`
  carries the cache key alone: the golden's bytes cross only when the
  inspector says it lacks that key. A redeploy costs one round trip
  rather than a ~2.6s cold start.
- A `Uint8Array`/`ArrayBuffer` payload is now copied **once**, straight
  into shared memory, rather than to a Buffer and then to shared memory.
  A `Buffer` payload gains a ~12ms copy it did not pay before; the
  comment in `test/fingerprint.test.js` about it not being copied has
  been corrected. That copy narrows, but does not close, an old hazard:
  sharp decodes asynchronously, so a flow reusing its capture buffer
  could corrupt a decode in progress. The decoder no longer sees the
  caller's memory at all.

### Fixed

- Nothing user-visible. Four defects were caught in review before
  release, all of them invisible to the existing suite, and each now has
  a test: PNG Buffers degrading to `Uint8Array` across the boundary
  (silent - a viewer renders nothing); the re-wrap throwing on the
  default configuration, where heatmaps and stages are null; the
  eviction retry livelocking because it re-entered a cache hit; and a
  failed prepare wedging its key in the inspector for the life of the
  process.

### Known issues

- The inspector's golden store holds four entries. A flow that keeps
  more than four distinct goldens genuinely in flight will re-prepare on
  eviction (~280ms) rather than fail, but it will do so repeatedly.
- Frames still interleave rather than queue. That is deliberate: one
  inspector serialising them would give a node's 2.3s unpinned frame
  head-of-line blocking over every other node.
- A second ~13ms main-thread span per frame, alongside the payload copy,
  is measured but not yet attributed. It is not GC.

## golden-compare 1.0.2 - 2026-08-29

Concurrency and per-frame waste. Two of the fixes below are for bugs that
produced a *confidently wrong answer* rather than an error, and both were
reachable on an ordinary flow.

### Fixed

- **A dispatch could settle on another dispatch's reply.** The worker pool
  registered `once("message")` per dispatch, so two dispatches queued on
  one worker both fired on the first reply and the second caller read a
  half-written output buffer. Node-RED never awaits a node's input
  handler, so two frames overlap inside `compareFrame` as a matter of
  course. End to end this surfaced as two concurrent frames both reporting
  `transform.score = 0` — not an error value: a perfect match, which beats
  every candidate and passes the part. Replies now carry the id of the
  dispatch they answer.
- **The pool was torn down whenever a different worker count was
  requested**, which both `msg.workers` and a second differently-configured
  node reach. That cost a ~60ms respawn per frame and terminated workers
  another in-flight frame was still waiting on, failing that frame for no
  fault of its own. One pool now grows to the largest size asked for; a
  smaller request dispatches to a prefix.
- A worker that errors no longer shuts down the pool for every other
  in-flight frame, and a failed `postMessage` rejects its dispatch instead
  of leaving it unsettled forever.
- `msg.goldenKey` did not do what it was documented to do. The hash of the
  golden ran before the name was consulted, so naming a golden saved
  nothing.

### Changed

- **The golden is fingerprinted before it is loaded, not after.** Only the
  fingerprint runs per message; the bytes are read only on a cache miss.
  Three costs go away, all of them paid to re-learn a constant:
  - `msg.payload` was SHA-1'd on every message for a cache key that was
    discarded — 27ms of a 23MP framebuffer. Nothing is cached against the
    frame, so it is no longer fingerprinted at all.
  - a `goldenPath` golden was read from disk in full on every frame and
    discarded on a cache hit. A hit now costs one `open`+`fstat`.
  - a `Buffer` payload was copied before being handed to sharp — another
    ~8ms at 23MP. `Uint8Array` and `ArrayBuffer` are still copied, since
    those can be views onto a buffer the caller keeps writing to.
- **`msg.goldenKey` now means the flow owns invalidation.** The buffer's
  length still enters the cache key, so a differently-sized render under a
  stale name is caught, but a same-sized one is served from cache.
- **The alignment polish is a pattern search, scored on the worker pool.**
  The first-improvement walk it replaced re-derived each probe from
  whatever it had just accepted, which is what made its evaluations
  sequential and unbatchable. `findTransform` is now async and accepts an
  `objectiveBatch`; the scalar `objective` stays supported.
  Measured against a fixed pin, 16 cores, `workingSize` 2048:

  | | before | after |
  | --- | ---: | ---: |
  | 8 workers, pinned — search | 220ms | 222ms |
  | 8 workers, pinned — worst event-loop block | 257ms | **93ms** |
  | 8 workers, unpinned — search | 1959ms | **1718ms** |
  | alignment residual, pinned | 0.003978 | **0.003813** |
  | alignment residual, unpinned | 0.008836 | **0.008698** |

  Registration is better on every fixture measured and the contiguous
  event-loop block on the pinned path drops 2.8x. **Pinned search time is
  at parity, not faster** — the pattern search does roughly 2.5x the
  evaluations and the pool absorbs them.
- **Below eight workers the polish is slower**: pinned search 223 -> 282ms
  at four workers, 231 -> 419ms at two, 225 -> 541ms with no pool. This is
  the price of one algorithm rather than two — a cheaper path for small
  hosts would make the alignment a part receives depend on the core count
  of the machine inspecting it.
- The prepared golden's buffers are allocated in shared memory once
  instead of being copied there per frame (~4ms a frame at 4.9MP). Note
  for callers: `golden.gray` is now a plain `Uint8Array` rather than a
  `Buffer`.

### Added

- `bench/frame-bench.js`, reporting `searchMs` apart from `alignMs`,
  alignment residual, and the worst contiguous event-loop block. `--pin`
  fixes the magnification so two versions can be compared on the same
  problem; without it each version pins to its own recovered scale and a
  score difference says nothing.
- `test/fingerprint.test.js` — asserts the *absence* of per-frame reads
  and digests, by counting them.
- `test/poolConcurrency.test.js` — two overlapping dispatches, and a
  differently-sized request against a pool in use. Both were checked
  against the old pool first: they pass on it until the timing is made
  decisive.
- `test/goldenShared.test.js` — walks the prepared golden rather than
  naming fields, so a new pixel buffer is covered without anyone
  remembering.
- `test/editorDefaults.test.js` — parses the `defaults` block out of both
  `.html` files and compares 38 of 39 and 5 of 6 properties against their
  runtime fallbacks, including the boolean idioms and `pickMode`. Checked
  against three deliberate breaks.

### Known issues

- The density sweeps (`findTransform` stages 1-3) are still synchronous.
  The transform search is no longer *one* contiguous block on the event
  loop, but on an unpinned frame the sweeps remain the larger half of it.
- A small dispatch queues behind a large one on the same workers
  (head-of-line blocking). Pre-existing, and unchanged here.
- `checkerboard-calibrate`'s `cols`/`rows` count **dark squares per row**,
  not physical squares: a standard 4x6 physical board must be configured
  as `cols: 2, rows: 6`. Unchanged, and documented in the node's help.

## golden-compare 1.0.1 - 2026-08-28

An adversarial review (five independent review lanes, verified by three
verifying agents) surfaced nineteen distinct issues; every confirmed one
is fixed below with a regression test. The suite grew from 44 to 100+
tests.

### Fixed

- **Grey summed-area tables wrapped past 2³² on large frames.** A `Uint32`
  table over the frame's greys (0–255) wraps once the image exceeds
  ~16.8M bright pixels — reachable at the default working sizes on this
  project's 23MP captures — silently corrupting the area-average warp and
  the polish objective in the wrapped region (phantom or missed defects).
  Grey tables now use a `Float64` accumulator; binary-mask tables stay
  `Uint32`. The worker kernel reads the same type, so serial and parallel
  stay byte-identical.
- **Fractional-magnification warp footprint.** The area-average footprint
  was exact only for integer magnifications; fractional values (e.g.
  m = 1.5) degenerated to 1-px point sampling. Warp boxes now read
  fractional corners through bilinear interpolation of the summed-area
  table.
- **`scaleLadder(min == max)` returned `[1]`.** Pinning the magnification
  to a non-1.0 scale silently searched at 1.0 every frame. A degenerate
  ladder now returns `[min]` (and rejects a non-positive `min` cleanly).
- **A corrupted trained-transform file could hang the flow.** `scaleX:
  1e308` passed the finite-positive check and drove the pinned search into
  an infinite synchronous loop (event-loop freeze, unbounded memory).
  Scales are now validated to the sane physical range 0.05–100 and refused
  with a reason; `offsetsAround` treats non-finite ranges as center-only.
- **Checkerboard calibration reported `detected: true` with no pitch.**
  `median([])` returned NaN for grids too thin to measure, silently
  disabling the mm position gate. Such photos are now reported as not
  detected with a reason.
- **`goldenRawGeometry` fell through to stale `msg.images[]`.** A golden
  supplied as a path or container-carrying buffer on a message that still
  carried pdf-to-image leftovers was decoded as raw pixels at the frame's
  dimensions — and the garbage golden was cached and reused. `msg.images[]`
  geometry is now only consulted for a bare-buffer golden, mirroring the
  frame-side guard.
- **Path-string goldens were cached content-blind.** An in-place overwrite
  of the artwork served the stale prepared golden (and stale trained
  transform) silently. Path cache keys now carry the file's mtime and
  size, so an overwrite re-decodes and the stale transform refuses itself
  with a retrain warning.
- **`readScaleFile` accepted 0/negative/Infinity and swallowed corrupt
  files.** Values are now validated finite-positive (upper bound 1000),
  and unreadable/implausible files return an error that the node surfaces
  as a warning instead of silently dropping calibration.
- **mm-per-pixel assumed the golden's native resolution equalled the
  calibration photo's.** The conversion is now derived from the
  calibration photo's recorded native size (with a backward-compatible
  fallback), and the node warns once when the golden's native resolution
  differs from the calibration photo's.
- **Both nodes double-reported failures** (`node.error(...)` followed by
  `done(err)`; Node-RED routes `done(err)` through `node.error`). Errors
  are now reported once.
- **A frame could hang forever if a pool worker died or was terminated
  mid-dispatch** (`runRanges` settled only on `message`/`error`). An
  `exit` listener now rejects the dispatch, so the frame fails fast.
- **Defect counters silently under-counted with pools larger than 64**
  (the slot buffer was fixed at 64; typed-array out-of-bounds writes are
  ignored). Slots are now sized from the actual pool.
- **`toShared` dropped `byteOffset`/`byteLength`** on sliced views. Offset
  views are re-copied into a zero-offset `SharedArrayBuffer`.
- **Raw descriptors were never validated against buffer length.** A
  descriptor whose `width × height × channels` exceeded the actual bytes
  reached sharp's raw path (libvips now errors, but with a generic
  message; it historically read out of bounds). The node now fails with
  the real numbers, and declared sizes are capped at 64M pixels.
- **Path inputs could read unboundedly** (`/dev/zero`, FIFOs, symlinks,
  multi-GB files) with a TOCTOU window. Reads now go through
  `open` → `fstat` → regular-file check → 512 MB cap → read via the same
  fd.
- **No input size cap before copy+hash.** Buffer inputs over 512 MB are
  refused before copying or SHA-1 hashing.
- **`new Buffer(SharedArrayBuffer)` (DEP0005)** fired on every parallel
  frame via `toShared`. The deprecated constructor form is gone.
- **Golden stage PNGs were rendered unconditionally** and retained on the
  cached golden for the node's lifetime. They are rendered only when
  `debugStages` is on (the flag is now part of the golden cache key).
- **`resolveImage` object form rejected `ArrayBuffer` data** (and
  `checkerboard-calibrate`'s twin had the same gap). Accepted now.
- **`checkerboard-calibrate` used strict `RED.validators.number()`** while
  `golden-compare` deliberately allows blank; switched to
  `number(true)` for consistency with the no-backfill policy.
- **A vacuous test** — "the mismatch check can be turned off" used a
  fixture that scored below `mismatchScore` even with the check enabled.
  It now uses a genuinely different-artwork pair with a real precondition.
- **Stale comments** — a cache-key comment omitted key components and one
  referenced a non-existent `fgWeak` field (it is `fgAmbiguous`).

### Changed

- `workingSize` cache semantics: an in-place golden-file overwrite now
  re-decodes (see Fixed), and `debugStages` + the calibration photo's
  native size participate in the cache key.
- `checkerboard-calibrate` and `golden-compare` now share the same
  validator policy (`RED.validators.number(true)`).

### Tests

- New suites: `test/warp.test.js` (grey-table wrap, fractional footprints),
  `test/checkerboard.test.js` (first-ever coverage of `lib/checkerboard.js`),
  `test/scaleFile.test.js`, `test/pool.test.js` (exit handling, oversized
  pools, `toShared`), `test/glue.test.js` + `test/checkerboardCalibrate.test.js`
  (Node-RED glue through a fake-RED harness: `resolveImage` branches,
  cache invalidation, `msg.rawInfo`, error reporting, input caps).
- Byte-identity assertions extended to `warpParallel` (with and without
  the summed-area table) and `refineLocallyParallel`.

### Known issues

- `checkerboard-calibrate`'s `cols`/`rows` count **dark squares per row**,
  not physical squares: a standard 4×6 physical board must be configured
  as `cols: 2, rows: 6`. The editor defaults (`4 × 6`) describe an 8×6
  board and will not detect a standard 4×6 one. Counting semantics are
  documented in the node's help text and intentionally unchanged.

## golden-compare 1.0.0 - 2026-05-06

Initial release: `golden-compare` (position + print/background blemish
checks against a cached golden, worker-pool accelerated) and
`checkerboard-calibrate` (mm/px calibration from a printed checkerboard).
