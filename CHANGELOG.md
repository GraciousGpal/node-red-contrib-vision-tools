# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [1.1.3] - 2026-08-29

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

## [1.1.2] - 2026-08-29

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

## [1.1.1] - 2026-08-29

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

## [1.1.0] - 2026-08-29

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

## [1.0.2] - 2026-08-29

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

## [1.0.1] - 2026-08-28

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

## [1.0.0] - 2026-05-06

Initial release: `golden-compare` (position + print/background blemish
checks against a cached golden, worker-pool accelerated) and
`checkerboard-calibrate` (mm/px calibration from a printed checkerboard).
