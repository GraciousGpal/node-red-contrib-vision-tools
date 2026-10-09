# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Per-golden profiles on `golden-compare` (`profileDir`, `msg.profile`).**
  The trained transform and the nuisance map each lived in one file per
  node, tied to one golden, so a node running a second artwork refused
  both and searched unpinned, and training the second overwrote the
  first. With a profile directory set, every golden gets one file holding
  its trained transform (with register slack), its nuisance map and its
  barcode regions, named after the golden's source file
  (`/data/Inspection/pdf/Demo_Good_60.pdf` → `demo_good_60.json`,
  `-p<page>` past page 1; `msg.profile` names it explicitly; a golden with
  no name falls back to its content hash). For a golden sent as bytes,
  `msg.filename` counts only when it names an artwork document (`.pdf`,
  `.ai`, `.eps`, `.svg`): when the golden rides on the frame's message,
  `file in` sets it to the camera frame's `.jpg`/`.png`, which would have
  given every frame its own profile. The name chooses the file and
  the content hash is the check: every section is validated strictly
  against the golden's content, so a revised artwork under the same name
  has its sections refused with a warning naming the profile until it is
  retrained. Matching `transformFilePath` / `nuisancePath` files are
  imported once (a failed write of the import still pins that frame,
  warns once per file version and is retried on later frames); another
  golden's file is passed over with at most one log line, and legacy
  files are never written. Writes to one profile
  are serialised within a process and renamed into place.
  `msg.result.profile` (`{ id, namedBy, path, contentKey, transform,
  nuisance, barcodes }`) says which profile applied and what it held.
  Without `profileDir` nothing changes.

- **Barcode regions derived from the artwork.** `golden-compare`'s
  `barcodeRegions` reads the golden's barcodes once per golden version
  into its profile (golden native px, with format and text), after the
  triggering frame has been sent; `msg.deriveBarcodes` forces a re-read.
  One derivation per profile and golden version runs at a time across
  every `golden-compare` node in the process, so a redeploy
  mid-derivation joins it instead of starting a second zxing run.
  `barcode-locate`'s new **Regions from** = *the golden's profile*
  (`regionSource: "profile"`, with `profilePath`, `profileDir`,
  `scaleFilePath`, `regionPad`, `regionPadMinPx`) maps those boxes into
  its payload through the trained transform, and through the inverse
  rectification when the payload is un-rectified, so no region is
  measured by hand and a moved camera needs only a retrained transform.
  Probe on the demo rig, 149 photos: the mapped boxes land on both
  Code128s in 149/149, and decoding only them on the native 3000x3700
  frame reads the artwork's text in 149/149 with 0 wrong reads, 152 ms
  median against 385 ms for the whole frame. On the halved 1500x1850
  frame the compare sees, only 23/149 read both codes and one read a
  confidently wrong string, so the node warns when its payload is no
  larger than that. The pad is `max(regionPad × longer edge,
  regionPadMinPx)` (0.2, 64 px): a proportional pad alone would give a 50
  px DataMatrix 10 px while the compare passes parts 64 px off nominal.
  Results carry `msg.regionSource`, and from profile regions
  `msg.expectedText` (the artwork's text there) and `msg.textMatches`.
  Of the profile regions containing the symbol's centre, the one whose
  text equals the decoded text wins, then the nearest of the same format,
  then the nearest of any: two adjacent tall codes padded at 0.2 overlap,
  and taking the first region flagged good reads as mismatches.
  Every inconsistency (barcodes and transform from different goldens,
  barcodes of another golden than the one `golden-compare` just inspected
  against, a transform trained before this version, a calibration of
  another aspect, a profile path that cannot even be stat'ed) is warned
  once per profile version and leaves the message with no profile
  regions, never an error. A text mismatch is warned once per (expected,
  read) pair.

- **`barcode-locate` works offline.** zxing-wasm 3.1.3 fetched its `.wasm`
  from jsdelivr on first use; with the network blocked the first decode
  aborted ("both async and sync fetching of the wasm failed"), so on a rig
  without internet the first decode after every restart failed.
  `lib/locate.js` now hands zxing the binary shipped inside the package at
  load time. A test stubs `fetch` and `http(s)` to throw before the first
  decode.

- **`barcode-locate` takes raw pixels**: `{ data, width, height, channels }`
  or bytes plus `msg.rawInfo`, as `golden-compare` does
  (`lib/nodeInput.js` gained `rawGeometry` / `assertRawFits`).

- **The tone and speck checks take their register slack from training.**
  How far off register a frame still sits after the local alignment
  belongs to the rig, not the artwork. A training frame
  (`trainTransform`) measures it per tile and writes it into the
  transform record (`registerSlackPx` for the worst tile, `register.slack`
  per tile, rounded up to 2, 3, 4, 5, 6, 8, 10, 12 or 16 px). Consecutive
  training frames merge, keeping the worst each tile saw, the frames
  after the run's first well-registered one measured against its scale;
  a frame that registered poorly or found no label trains nothing. With
  **from training** ticked (`toneMarginAuto`, the default) each tile runs
  with its own slack. `toneMargin` (6) is the fallback for an untrained
  rig, and `msg.toneMargin` overrides the trained slack.
  `msg.result.toneBlemish.marginTrained` / `marginMinPx` / `marginMaxPx`
  say what a frame ran with, and a training frame carries
  `msg.result.register`. Transform files trained before this have no
  slack: retrain. Synthetic rig set 84.1% recall (flat 6 px: 76.2%), real
  artwork 87.7% (81.5%), no false fail added. On the rig, trained over 30
  good frames at `localAlignMax` 6 and `speckMaxArea` 20 (flow settings,
  not defaults), 148 of 148 good frames pass and 14 of 14 bad fail.

- **`edgeMargin` on `golden-compare`: px of the golden's border, every side,
  that no blemish check inspects.** Default 0, so nothing changes until
  it is set. On a rig the substrate just past the label's die-cut edge
  crept into the frame as one block column at x=0, full height, growing
  frame by frame from density 0.25 to 0.875 while the alignment stayed put,
  and failed good parts on the background density gate. That strip is the
  world outside the artwork, not a mark on it; the position check already
  bounds how far the label may sit from nominal. Also `msg.edgeMargin`.
  The cleared border shows in the defect masks, stages and heat maps.

- **A stage viewer for `golden-compare`.** With the new *Preview* box on,
  the node draws its last frame under itself on the flow canvas - the heat
  map of the channel that failed, or the aligned frame when nothing did,
  with the verdict - and clicking it opens a viewer that steps through the
  whole inspection in the order it ran: golden, golden ink, golden ink
  grown by the background tolerance, the frame and its ink, the aligned
  frame and its ink, the ink grown by the print tolerance, both defect
  masks, both heat maps, and the trained nuisance baseline drawn over the
  golden when a map is loaded. Each stage comes with a sentence on what it
  is and the numbers behind the verdict sit beside it; arrow keys step,
  `Esc` closes, a click toggles 1:1. *Overlay on the golden* composites
  the stage over the golden's ink or grey - red where only the golden has
  it, cyan where only the stage has it, so a print defect is red, a
  background defect cyan and a misregistration a coloured fringe - or as
  a difference or a slider blend. The viewer opens paused on the frame
  it was clicked on, and the runtime holds that inspection until the
  viewer goes live or closes, so later frames cannot replace it while it
  is being looked at (`POST`/`DELETE /golden-compare/last/:id/hold`);
  *Go live* (or `p`) follows each frame the node inspects instead. The runtime keeps one
  inspection per node in memory, plus the held one, and serves them over
  `GET /golden-compare/last/:id` and
  `GET /golden-compare/last/:id/stage/:key`, one image per request as the
  viewer reaches it. With no viewer open the preview renders only its
  thumbnail; the stages and per-check heat maps are rendered while a
  viewer is open (`POST`/`DELETE /golden-compare/last/:id/watch`,
  renewed every few seconds), and the frame it opens on is rendered in
  full then, while the inspector still holds the golden. The message
  still carries only what the output boxes asked for. `previewEnabled`
  and `previewWidth` are settings and per-message overrides.
- **`msg.stages.nuisanceBaseline`**: with *Output pipeline stages* on and
  a nuisance map loaded, the trained per-block baseline rendered over the
  golden the way a heat map is rendered over the frame, so a map can be
  looked at rather than trusted.

- **A `synthetic-defects` node: the defect generator, in the editor.**
  The frame generator was a CLI under `bench/`, which the npm package does
  not ship, so seeing what a `misprint/streak` actually looks like - and
  what `golden-compare` says about it - meant generating a set to disk and
  opening files. The generator library moved to `lib/synth/` (so the
  package ships it) and grew `lib/synth/cases.js`, an in-memory case API
  the CLI and the node now share, frame by frame from one lazy async
  generator: a 170-frame set is ~300MB and nothing builds it up front.
  The node takes a golden on `msg.payload` - bytes, a path, a raw pixel
  descriptor, or nothing, in which case it draws the synthetic label - and
  emits the set one message at a time, each carrying the frame, the golden
  as PNG, a `msg.goldenKey` so `golden-compare` prepares that golden once
  for the whole run, and `msg.synth` with the case id, family, variant,
  severity, every sampled camera parameter, the measured ground truth and
  `expected`. Output 2 announces the golden once, first. Families,
  severities, capture preset, seed, frames per variant and the interval
  between frames are all configurable and all overridable per message; a
  new message stops a run in progress. Wire output 1 into
  `golden-compare`, a debug node on `msg.result` beside one on
  `msg.synth.expected`, and an image preview on `msg.payload` -
  `examples/synthetic-defects-into-golden-compare.json` is that flow. It
  is a look, not a measurement: `bench/synth/run.js` is still where scored
  recall and sweeps come from, over the same frames.

- **A synthetic-defect benchmark for `golden-compare`: `bench/synth/`.**
  `generate.js` draws a label from scratch - glyph-shaped type down to
  1-3px strokes, a barcode, a ruled table, a logo - or takes an artwork
  file, injects defects at known places and sizes (scratches light and
  dark; ink marks, smudges and spatter; voids, fades, dropped glyphs and
  dead-column streaks; ghost double prints, bleed, extra strokes and
  fills; dust, pinholes, faint stains, folds and combinations, each on a
  tiny/small/medium/large ladder), and photographs the result: placed on
  a grey tray at a magnification, stretch, rotation and offset, with grey
  ink and off-white paper, an illumination gradient, vignette, blur,
  noise and JPEG. Ground truth is measured by diffing the raster - which
  channel a defect lands in is what it did to the pixels, not what its
  name promised - and a fifth of every set is clean frames. `run.js`
  runs a set through the library pipeline and scores verdicts *and
  regions*: recall per family, variant and size, false fails on clean
  frames, timing split by verdict, and a sweep over any one setting. A
  frame that fails for the wrong reason is a `wrong-place`, never a
  detection. `bench/synth/README.md` has the contract and the rules.

- **`label-crop` crops the rectangle a `line-finder` found.** With a
  line-finder reporting `msg.lineFinder.rect`, cropping to it still meant
  pasting the four regions into a label-crop in calipers mode and having
  it run the same search again. A third boundary mode, `upstream` (**From
  line-finder** in the editor), detects nothing: it takes the rectangle
  off the message - `msg.lineFinder.rect`, or `msg.rect` when a flow sets
  one - and goes straight to the rotate and crop the other modes end in,
  so `msg.labelCrop` comes out as calipers mode would report the same
  rectangle, to the pixel, with `reason: "upstream-rect"`, the
  line-finder's score as `confidence` and no polarity. `cropMargin`,
  `minRotateAngleDeg` and the output settings apply; the blob gates do
  not, as they do not in calipers mode. A rectangle that cannot be cropped
  is a miss with a reason that says which - `no-upstream-rect` when the
  message carries none, `upstream-rect:missing-edge:top` when the
  line-finder itself missed, `bad-upstream-rect` when it is malformed -
  and the payload passes through. The editor hides the blob gates and the
  edge regions in this mode and says what to wire in front.
  `examples/line-finder-rect-to-label-crop.json` runs the whole flow on a
  synthetic frame, and a new test holds every example's line-finder and
  label-crop nodes to their editors' defaults and runs that flow end to
  end.
- **The `line-finder` editor opens on the last frame the node saw.**
  Tuning a region meant choosing a photo from disk every time the dialog
  opened, and the photo was rarely the frame the camera was producing. The
  node now keeps the last payload that went through it - by reference, in
  memory, one frame per line-finder node, so it survives a redeploy but
  not a restart and a deleted node's goes with it - and the editor fetches
  it from a new admin endpoint, `GET /line-finder/last-frame/:id`, as the
  dialog opens, draws the regions on it and captions it with its age and
  size. **Reload last frame** fetches it again. **Run on this image** on
  that frame posts only the node id (`POST /line-finder/run` with
  `nodeId` and no `image`), so the runtime searches the very pixels it
  saw with no browser decode in between, and the answer says which it was
  under `source`. A raw payload is encoded to PNG the first time the
  editor asks and kept until the next frame; an encoded one is served as
  it came. With no frame yet the dialog is exactly what it was: choose a
  file.
- **One `line-finder` searches several regions, and four of them make a
  rectangle.** Detecting a label meant four line-finder nodes and a
  label-crop to intersect them, which is a lot of nodes to say "find this
  rectangle". The node now holds a list of regions, each with its own box,
  angle, scan direction, polarity and edge select (the numeric tuning stays
  node-wide), and reports one result per region in
  `msg.lineFinder.lines`. Name four of them `left`, `right`, `top` and
  `bottom` and `msg.lineFinder.rect` carries the rectangle they bound -
  corners, centre, size and angle in the shape label-crop reports; every
  pair of found lines that is not parallel within the angle tolerance is
  also intersected into `intersections`, for an L-shaped fixture. With
  several regions the top-level `found` is true only when every region
  found its line and `reason` names the first that did not
  (`top:no-edge`). With one region nothing changes: the output keeps its
  shape field for field, with `lines[0]` a copy of it, and a flow saved
  before the list existed keeps working from the flat region fields.
  `msg.regions` replaces the list per message the way `msg.region` re-aims
  a single one. The editor gains the list, with Add, Remove and an **Add
  rectangle** button that lays the four sides out around the image centre
  scanning inwards; every region is drawn and labelled, the selected one
  with handles, and clicking another selects it. **Run on this image**
  now runs every region and sums them up per region - `left ✓ 0.1° ·
  right ✓ · top ✗ contrast 1.2<2.0 · bottom ✓` - drawing the rectangle's
  corners when four sides are found, and **Copy as label-crop
  edgeRegions** puts the four tuned regions on the clipboard as the JSON
  label-crop's calipers mode pastes in. The flow-canvas preview draws
  every region, line and the rectangle.
- **The `line-finder` editor runs the search on the loaded image.** The
  dialog could load a sample and draw the region on it, but the only way
  to see whether the settings found the line was to deploy and push a
  message; a greyish label edge on a slightly whiter background could not
  be tuned that way. **Run on this image** cuts the region's bounding box
  out of the loaded sample and posts it to a new admin endpoint,
  `POST /line-finder/run`, which runs the same `findLine` the node runs
  and answers in frame coordinates. The editor draws each caliper, its
  edge point (filled when the fit kept it, hollow when the outlier trim
  dropped it) and the fitted line. On a miss the status line walks the
  gates in the finder's order and names the one that failed - for
  contrast, quoting the strongest step any caliper actually saw, which is
  literally the threshold that would have found it. `findLine`'s result
  gains a `caliperLines` entry per band and a `diagnostics` block to
  support that; every pre-existing field is unchanged.
- **`synthetic-defects` previews itself.** The golden and then every frame
  go under the node on the canvas as they are sent, each defect's measured
  ground-truth box drawn on the frame through the capture's own
  magnification, rotation and placement (`frameBox` in
  `lib/synth/capture.js`), coloured by the channel it landed in, with a
  caption saying the case and what `golden-compare` is expected to answer.
  On by default - the node exists to be looked at; `Preview width`,
  `msg.previewEnabled` and `msg.previewWidth` as on the other nodes.
- **`synthetic-defects` takes a golden path.** A `Golden` field on the
  node (`msg.goldenPath` per message) names the artwork to paint defects
  into when `msg.payload` is empty, so a real label is the golden with a
  plain inject rather than a function node; `msg.synth.source` on the
  golden message says `"file"`. The synthetic label remains the fallback.
- **`printMissingFraction` on `golden-compare`: the print check judged
  against the golden's own ink, block by block.** A block that lost at
  least this fraction of the ink the golden has there fails, however small
  a share of the block's area that ink was. Body type is 10-15% ink, so a
  dropped word never reached `failThreshold` by area and never reached
  `failRatio` - the first of the five miss mechanisms in
  `bench/synth-findings.md`. Default 0.5; 0 is the old behaviour. Blocks
  flagged this way join the regions and the heat map, and
  `result.printBlemish.worstMissing` reports the worst block. On the
  pinned synthetic set it takes recall from 36.5% to 50.8% (61.9% with
  `failThreshold` 0.1) for 2 clean false fails in 24, both thin strokes
  at the gate's floor; `misprint/dropout` goes 25% → 100%,
  `misprint/streak` 0% → 75%, `overprint/bleed` 33% → 100%.
- **A tone check on `golden-compare`: grey against the paper and ink of
  its own neighbourhood.** The two blemish checks read the frame after
  thresholding, so a smudge at 70% opacity, a ghosted second impression
  and faded print never reached them - the second miss mechanism in
  `bench/synth-findings.md`, 0% on all three variants whatever the
  thresholds. `toneThreshold` (default 0.3; 0 = off) fails a pixel that
  sits that fraction of the paper-to-ink span from where the artwork's
  own grey says it should - the neighbourhood's paper and ink levels,
  taken per 128 px cell so lighting cancels, with the golden's grey
  mapped between them, so a grey panel in the artwork is expected grey -
  and accepts the pixel if the artwork predicts its grey anywhere within
  the register slack (trained per tile; `toneMargin` (6) untrained),
  since registration is never exact: on a real rig a rule 5 px off
  register read as a tone region on its far side and a 176 px speck
  along its edge. The border both checks skip is 16 px, and the paper and
  ink levels are sampled as far clear of the other class as the slack, 3
  px as the fallback for artwork too thin to leave pure ink. Same
  block stage, same regions; `result.toneBlemish` with the measured
  `paperLevel` / `inkLevel`, `msg.toneHeatmap` (`outputToneHeatmap`, off
  by default - the overlay shows it), a `toneDeviation` stage, and
  `tone` among the status line's failed parts. A golden whose paper and
  ink are under 64 grey levels apart, or a frame that shows too little
  of either, leaves the check off with a `reason` and one warning per
  golden rather than a silent pass. On the pinned synthetic set it takes
  recall from 50.8% to 60.3% at the package defaults and from 61.9% to
  74.6% at the example flow's `failThreshold` 0.1, with no new clean
  false fails and no wrong-place verdicts; `mark/smudge` 25% → 100%,
  `misprint/faded` 0% → 100%, `overprint/ghost` 50% → 100%. Measured
  before the register slack; current numbers are under the slack entry
  above. ~30 ms a frame at `workingSize` 2100.
- **`msg.heatmap`: every check on one picture.** Each check's regions on
  the aligned frame, boxed in its own colour with the defect pixels
  filled inside - blue extra ink, red missing ink, amber tone, green
  specks grown so a three-pixel one shows. The four per-check heat maps
  stayed, one check each per block, for tuning; this one is for looking
  at a part. It is the thumbnail under the node and a verdict stage in
  the viewer. `outputHeatmap`, default on.
- **A speck check on `golden-compare`, for dust and pinholes.** A medium
  dust case is 600 specks of one to three px across the label: 4000
  changed pixels, none dense enough for a block to reach
  `blockThreshold`, and after the camera's blur not enough at ink level
  for `failRatio` - the third miss mechanism in `bench/synth-findings.md`.
  `speckThreshold` (0.3; 0 = off) takes the tone deviation as pixel-level
  connected components of at least `speckMinArea` (3) px and fails the
  part at `speckMaxCount` (8) of them, or at one speck of `speckMaxArea`
  (48) px. `result.speckBlemish` `{ count, area, largest, regions }`,
  `msg.speckHeatmap` (`outputSpeckHeatmap`, off by default), a
  `speckHeatmap` stage, `specks` among the status line's failed parts. A component the tone
  check has already failed is tone's evidence, not a speck. On the
  pinned synthetic set recall goes from 60.3% to 82.5% at the package
  defaults and from 74.6% to 85.7% at the example flow's
  `failThreshold` 0.1, with the same two clean false fails and no
  wrong-place verdicts; `random/dust` 25% → 100%, `random/void-spots`
  25% → 100%, `scratch/dark` 75% → 100%. ~10 ms a frame at
  `workingSize` 2100. On the line's real artwork, at the production
  node's settings: 86.2% recall, 0 clean false fails, no wrong-place (at a 3 px slack; see the slack entry for current figures). Lowering the dilation
  tolerances instead was measured and rejected: `printTolerance` 0
  reaches 82.5% by failing 23 of 24 clean frames.
- **A fixed rig in the synthetic set.** `synthetic-defects` and
  `bench/synth/generate.js` now shoot the whole set at one magnification
  and one stretch by default (`Fixed rig` / `--rig`), as a camera on a
  stand gives, and `bench/synth/run.js` pins to what the search finds on
  one clean frame (`--train`), as `trainTransform` does on a line. The
  earlier benchmark re-rolled magnification per frame, so the alignment
  search's misses were booked as the blemish checks' false fails: pinned,
  clean false fails go from 7 of 24 to 0 on the same frames. The example
  flow trains `golden-compare` on the first frame of each run and pins
  the rest, and runs `failThreshold` 0.1, which the pinned sweep found
  free on the set (the package default stays 0.3).

- **The camera's perspective, measured once and applied per frame.**
  `checkerboard-calibrate` now fits a plane homography to the same
  square centroids it measures the pitch from: an ideal lattice is placed
  over the photo with a similarity, so the board's own placement stays
  put, and what remains between the measured squares and the lattice is
  the keystone. It is reported as `msg.result.perspective` — before/after
  reprojection in pixels, so the operator can see whether there is any
  perspective worth correcting — and saved with the scale as
  `homography`. On a square-on camera it is the identity. Existing scale
  files keep working; `readScaleFile` validates the homography only when
  one is present.

  The new **`perspective-rectify`** node reads that record and resamples
  each frame through it, in front of `label-crop`. Bilinear, edge
  replicated rather than filled, pure JS split across the worker pool by
  rows like the golden warp (~20ms on a 1500×1850 RGB frame, ~140ms on
  24MP; neither OpenCV engine offered a faster `warpPerspective`),
  rescaled to the frame's resolution
  when it differs from the calibration photo's. A frame it cannot
  rectify (a different aspect ratio, an undecodable payload) passes
  through unchanged with `msg.rectify.applied === false` and a reason, so
  the inspection behind it still grades the part; setup problems (no
  scale file, no homography in it) are errors, since no frame could ever
  pass. On a synthetic
  board keystoned by 12% the measurement reads 3.9px rms before and
  0.16px after; rectifying with it brings the board back to 0.23px. On
  this project's real rig it reads 1.6px before, 1.3px after: square-on,
  the rest lens distortion. The lattice takes x and y pitch separately,
  so a board with rectangular cells (the real one measures 0.855) is left
  as the aspect it is rather than "corrected" into a stretch of every
  frame.

  This is deliberately not a document-scanner style per-frame quad
  detection: that re-solves the camera geometry on every part, from four
  contour corners, and does so least reliably on exactly the damaged
  label the inspection exists to catch. It is also not a change to
  `golden-compare`'s alignment model, whose residual is the label bowing
  on the tray (a homography removes 18% of it), not the camera.

### Changed

- **`golden-compare` runs a good frame in about half the time.** On the
  rig's 1475x2125 golden at 12 workers the median good frame went from
  193 to 94 ms and its p95 from 226 to 119 ms (whole handler, two passes
  over all 162 sample frames, old and new interleaved on an idle host;
  the live flow logs 95 ms median), with `msg.result` and `msg.heatmap`
  unchanged to the bit. A frame's full-size masks are reused from
  the frame before instead of allocated anew: the pool workers collect
  by the volume of shared memory they have not seen, and new masks every
  frame had one of them collecting inside nearly every frame (the spares
  kept for reuse are capped at 128 MB across golden sizes), and each
  worker starts its collection interval at its own point of it: every
  worker is shown the same new buffers (the rectified frame, mostly), so
  all twelve collected inside the same frame, one frame in eight, which
  took ~160 ms; now about one collects in a frame, for ~80 MB more
  held. The
  thresholding counts (Otsu's histogram, the golden's ink and its
  coverage, the native path's disagreement) are taken by the pool as it
  binarizes; the print and background checks run as one pass over the
  pool that also counts each mask per block for the heat-map grids,
  where they were five passes, two of them strided, and three serial
  grids; the native warp's uncovered pixels are blanked by runs; the
  local alignment works out its per-column terms once. With the preview
  on, the thumbnail is drawn small in the inspector from the aligned
  frame and its region boxes, so the node no longer decodes, resizes and
  encodes the full-size picture on its own thread, and that picture is
  no longer drawn at all when `outputHeatmap` is off and no viewer is
  open (the thumbnail now shows the boxes, not each region's pixels).
  The heat-map format and quality no longer re-prepare the golden when
  its debug stages are not baked in.

- **The tone check costs about half as much.** On the same rig and set
  its stage went from 17.6 to 10.3 ms median on a good frame at 12
  workers (p95 45 to 26 ms) and from 43 to 37 ms on one, results again
  identical to the bit. The pool's workers claim the check's cells and
  rows a small chunk at a time instead of a fixed twelfth each, which a
  worker the host had paused held the frame up for; a speck threshold
  equal to the tone one, the default, shares its tables instead of being
  tested again per pixel; the speck seeds are gathered from the rows the
  comparison counted one in instead of a scan of the whole mask; the
  golden's grey-to-level fractions are worked out once per golden; and
  the defect and speck masks come from the frame's reused scratch.

- **The local alignment costs less, results identical to the bit.** Its
  resampling works out each column's horizontal interpolation once per
  band of rows sharing a pair of field rows, rather than once per pixel.
  The tile search reads each tile's golden samples from one gathered
  array, and the frame's outer row and column of tiles stop a losing
  offset early as the inner tiles do, where they summed every offset in
  full. The pool's workers claim the field's tiles and the resampling's
  squares a small chunk at a time, as they do the tone check's, instead
  of a fixed share of rows each: a blank tile costs nothing and a busy
  one every offset, and the slowest worker's share of the field took 40%
  longer than the average one's.

- **The JS alignment - the frames OpenCV cannot align - is faster, with
  identical results.** The density sweeps run on the worker pool, every
  rung or hypothesis of a stage in one batch; stage 2 sweeps angle only
  for the hypotheses stage 3 refines (5 of 21 at the defaults - the angle
  sweep never re-ranked them); the polish objective splits each batch by
  rows across every worker instead of one candidate per worker, and scores
  its start with its first neighbourhood; the area-average warp reads its
  table inline; the final warp splits across the pool when it is not
  magnifying; and the frame mask the search reads is cut on the pool
  without the ambiguity band nothing read. On the container rig, 12
  workers: the eight pinned JS-route frames went from 486 to 328ms median
  wall (search 174 → 141ms); with no trained transform,
  search went from 2.3s to 0.57s median. `msg.result` is byte-identical on
  all 162 bench frames, pinned and unpinned.

- **The `golden-compare` edit dialog is grouped into six collapsible
  sections** — Golden and profile, Ink, Alignment, Position, Blemish
  checks, Output and preview — with the two legacy file paths under
  *Legacy files* and the search sweeps, candidates, worker threads and
  OpenCV prototypes under *Advanced*, both folded by default. 63 fields in
  one flat list had become hard to scan once profiles arrived. No setting
  is added, renamed or re-defaulted; the open/closed state is remembered
  per browser, and a section holding an invalid field opens itself when
  the dialog is reopened. The angle tolerance now sits under Position,
  apart from the angle sweep it used to share a row with.

- **The trained transform record records the frame it was measured on.**
  `frameWidth`/`frameHeight` (the frame at working size),
  `frameNativeWidth`/`frameNativeHeight` (the frame as `golden-compare`
  received it) and `placement { ox, oy, angleDeg }` (where the golden sat
  in the run's last written training frame), in a profile and in a legacy
  `transformFilePath` file alike. The scales alone map golden px to frame
  px only up to an offset; these are what let `barcode-locate` carry a box
  from the artwork onto the camera frame. Older records still pin as
  before; `barcode-locate` asks for them to be retrained.

- **`barcode-locate`: every result carries `msg.symbol`, and one code is
  reported once — in list mode too.** `msg.symbol` is the code's own box
  from zxing's corner points, in full-image px, next to `msg.roi` (the
  region searched). A code read through overlapping regions (same text,
  same format, symbol boxes that touch at all) is kept once, under the
  first region's label; "touch" rather than an overlap ratio because
  zxing's box for a linear code covers only the rows that decoded. This
  applies to hand-drawn regions as well, so a flow whose regions overlap
  now gets one result per symbol and can see `msg.barcodeCount` drop. The
  none-found message carries `symbol`, `expectedText` and `textMatches` as
  `null`.

- **`compareFrame`'s result gains `targetNative: { width, height }`**, the
  frame's size before the working-size resize.

- **The record validators are split out of the file readers.**
  `validateTransformRecord` (lib/transformFile.js) and
  `validateNuisanceRecord` (lib/nuisanceMap.js) check an already-parsed
  record, so a legacy file and a profile section go through the same
  rules; `readTransformFile` / `readNuisanceMap` are the file read in
  front of them. Both take `strictContentKey`, which compares the golden's
  content key on every read rather than only when the cheap keys
  disagree: under a named golden a new render keeps the name, and a record
  measured on the old bytes was accepted unchecked. Off by default, so a
  read without it behaves as before; profiles turn it on. A record that is
  not a JSON object (`null`, an array) is refused with a reason instead
  of throwing.

- **`golden-compare`'s content-key memo holds 16 goldens and includes the
  golden's byte length.** It was one slot, so a rig alternating two
  goldens re-hashed on every switch. The fingerprint of a path golden now
  reports its byte length too, so a named path golden's cache key gains
  `len:<size>`: one re-prepare after upgrade, and a new render under the
  same name is no longer served from cache when its size changed.

- **With profiles, nuisance training keeps one accumulator per profile
  and golden version** (4 at most) instead of one per node, so a training
  run that interleaves two goldens no longer folds both into one map, and
  a revised artwork under the same name starts a new one. Without
  profiles it keeps the single accumulator it always had.

- The training errors now read "training needs a profile directory or a
  Trained transform path to write to" (and the same for the nuisance map).

- **Tests for the barcode code fail rather than skip without zxing-wasm's
  writer.** `test/locate.test.js` and `test/goldenCompareProfile.test.js`
  write their barcodes with `zxing-wasm/writer`; zxing-wasm is a hard
  dependency, so a writer that cannot load fails those tests with the load
  error instead of skipping them.

- **A frame costs what it did before the tone and speck checks.** The
  inspector worker moves a frame's raw images to the main thread instead
  of copying them, and the golden's stages sit in shared memory once.
  Heat maps decide each block once, masks write only their set pixels,
  and the tone check's two passes run over the worker pool. The local
  alignment stops scoring an offset once it cannot win, and the preview
  renders its stages only while a viewer is open. Every verdict, region
  and image is byte-identical. On the rig (12 pool workers, working size
  2125) a frame is 199 ms mean with the preview on and no viewer and 182
  ms with it off, against 327 ms for the always-rendering preview and
  455-570 ms before this work.

- **`golden-compare` searches scale on a 4% ladder, not 8%.**
  `scaleSearchSteps` defaults to 37 over 0.6-2.5 instead of 19. The
  joint refine did not always bridge an 8% rung: on the synthetic
  benchmark's clean frames the recovered scale was 0.31% off on average
  and the angle 0.04 degrees, enough over a 2100px label to leave a
  residual on every stroke and fail a clean part on both blemish
  channels. At 37 rungs the errors are 0.08% and 0.02 degrees, clean
  false fails went from 15 to 10 of 34, and the frame is no slower - a
  search that starts nearer finishes sooner. Recall on the set fell from
  48% to 39%, and that is honest: 11 of the 15 detections lost were on
  frames carrying 350-630 residue regions, one of which happened to
  cover the defect. A trained transform pins the scale and does not use
  the ladder; training does, and pins better for it.
- **`golden-compare` fails as fast as it passes.** With the OpenCV fast
  path and seed on and a trained transform, a heavily defective print
  took 0.5-8s against 0.15s for a pass, all of it in alignment. The rig's
  own log, once it said where the time went, put nearly all of it in one
  place: OpenCV's full alignment fails on such a frame (nothing back, or
  a transform 77-92% off in scale or 26° in angle), and the ORB+ECC seed
  then ran on the same frame with the same engine - the same call at full
  resolution with more iterations - for 0.3s to produce nothing again, or
  4-7s to produce a seed the polish made nothing of. The seed is no
  longer tried on a frame the fast path has just failed on; the JS sweeps
  find the start in ~200ms. Measured on the rig's 14 known-bad frames:
  the seven that fell back went from 0.57-8.2s a frame to 0.26-0.72s,
  with the same verdicts; the seven that did not are unchanged at ~140ms.

  Two smaller things in the same area. The fast path's 15% disagreement
  gate now applies only to the unpinned search: under a pin the transform
  has already been held to the trained scale and angle, and disagreement
  cannot tell a misaligned frame from a defective one, so a validated
  native alignment is kept and the disagreement reported as the defect
  it is (1.4s to 0.4s on a frame with most of its label blanked). And the
  JS polish is bounded: a step size may improve for at most
  `POLISH_MAX_ROUNDS` (8) rounds before the next takes over, several
  times what a clean frame needs, with every step size still run.

  `msg.timings` now carries the align bucket's split (`seedMs`,
  `searchMs`, `localAlignMs` and the rest) and the node's log line prints
  it with the route taken and the fallback reason, which is how the
  above was found.
- **`golden-compare` declares each setting once.** The forty settings were
  clamped by hand twice - once off the node config, once off the message -
  and their bounds kept in a third place; `loadImage` and
  `fingerprintImage` each classified the source their own way with the
  same three error strings. A `SETTINGS` table now carries every default,
  clamp and override rule, read by two loops, and one `locateSource` feeds
  both loaders. Behaviour, defaults, bounds and error messages are
  unchanged; `test/editorDefaults.test.js` reads the table against the
  editor's defaults, and the node is a quarter shorter.
- **Every node's status ends with the time the frame took.** `golden-compare`
  and `barcode-locate` showed a time; `checkerboard-calibrate`, `label-crop`
  and `line-finder` showed none, and `perspective-rectify` showed only the
  warp stage, so reading a flow's cost off the editor meant a debug node on
  every other message. Each verdict now ends in ` · 84ms` or ` · 1.23s`,
  wall-clock from the message arriving to the status, previews and encoding
  included - so what the editor shows is what the flow waits for. The
  per-stage timings on the message are unchanged. `barcode-locate`'s
  `none found (12ms)` and `2 found (regions, 12ms)` become `none found ·
  12ms` and `2 found (regions) · 12ms`, and its time now covers the decode
  rather than the scans alone.
- **Heat maps and debug stages are JPEG by default, and encoded
  concurrently.** Turning on the two heat maps cost ~317ms a frame and
  the seven debug stages ~734ms, on a 460ms inspection - not the compose
  (11ms) or the block grid (5ms), but PNG at zlib's default level 6:
  153ms per image on real frame content at working size, awaited one
  image at a time while the codec threads idled. A heat map is a picture
  for a person, so it is now JPEG q85 (22ms, 350KB against 2.4MB), the
  independent encodes run together, and the binary mask stages stay PNG
  (two-level content deflates in a few ms; JPEG ringing would put grey
  where the pipeline has none). Measured through the real handler in the
  container: heat maps 317 → ~80ms, stages 734 → ~95ms, image bytes per
  frame 10.3MB → 2.2MB. `heatmapFormat: "png"` keeps PNG, lossless at
  zlib level 1 (25ms per image, 3.7MB - the fastest deflate worth
  having; level 0 stores 9.2MB in 11ms); `"raw"` skips the codec
  entirely and hands the overlay over as the same `{ data, width,
  height, channels }` object label-crop emits, for a flow that resizes
  before it displays. `heatmapQuality` sets the JPEG quality; all take
  `msg.` overrides and are part of the golden cache key, since the
  golden's own stages are baked in.

### Fixed

- **A node saved before a setting existed lost that setting's default in
  the editor.** Node-RED fills in nothing for a property an older node
  has no value for, so a box added since rendered unticked and a number
  blank, and saving the node wrote those back as a choice nobody made:
  on the first rig to retrain, *from training* came out off and the
  trained slack was never applied. `golden-compare`'s editor now gives
  such a setting its default, as a fresh node would have.

- **The worker pool no longer holds on to finished frames.** A shared
  buffer is freed only when every thread that viewed it has let go, and
  nothing made a pool worker's collector run; the allocating thread's
  own collector does not run for shared bytes before some 800 MB of
  them either. With the pool, 70 MB a frame was retained, 1.8 GB after
  25 frames at 3 MP. Both sides now count the shared bytes they handle
  and collect by volume (`lib/shared.js`, `lib/poolWorker.js`); shared
  buffers hold at ~285 MB over 60 frames at 3 MP, and frame time is
  within noise at 3 MP and 5-10% over at 4096 px, the cost of giving
  the memory back. No flag to start Node with; a host that exposes `gc`
  under a name it cannot be taken by warns once (`VISION_TOOLS_NO_GC`).
- **The nuisance map no longer gates the print channel.** The map is
  trained from the background channel - what extra ink looks like on a
  good part, block by block - but the novelty gate was applied to both
  channels, so once a map was loaded any print block at the novelty
  threshold failed against a baseline that had never been measured for
  print. Training a map silently tightened the print check. The print
  channel is now judged by its own density and ratio gates only;
  `printBlemish.worstExcess` is 0 and `noveltyPass` true.

- **A frame with no label in it passed.** Two blank frames in the rig's
  bad set - paper and a sliver of tray, nothing printed - went through
  every check, and one passed: the search sat at nominal because every
  placement scored alike, so position passed; the alignment residual was
  the golden's own ink fraction, under the mismatch threshold; and with
  `inkMargin` 64 the ambiguity band covered the whole canvas and voided
  every blemish claim, so both ratios were zero. Nothing asked whether
  the golden's ink was in the frame at all. Now `match.coverage` is that
  fraction, measured on the aligned mask, and under `minCoverage`
  (default 0.5, 0 disables) the part fails as `labelMissing` with the
  reason stated and a `label missing?` status. A badly printed part
  covers 90%+; the blank frames cover about 0.
- **A rotated part is no longer charged an offset it does not have.**
  Position was measured at the golden's top-left corner, which a
  rotation about the label's centre moves by half the label's height
  times sin(theta): 12-14px at 0.7 degrees on a 2100px label, against a
  16px tolerance. Three of the synthetic benchmark's 34 clean frames
  failed on position for exactly that. dx/dy are now measured at the
  label's centre; at zero rotation the two are identical.
- **Two-level artwork used at native working size had no ink.** Otsu's
  between-class variance is the same at every level between the modes
  of a histogram with an empty gap - pure black-on-white artwork, or a
  golden binarised before it was saved - and the threshold took the
  first of them, 0: nothing darker than black, an empty golden, and an
  inspection that reported zero print defect, a background region the
  size of the tray, and a position hundreds of pixels out. A resample to
  a smaller `workingSize` put greys in the gap and hid it, which is why
  the rig's PDF renders never showed it. The level is now the midpoint
  of that plateau; on a photograph the plateau is one level wide and
  nothing changes. Found by the first run of the synthetic benchmark.
  `checkerboard-calibrate` had already worked around the same case with
  an inclusive comparison of its own.

- **`label-crop` cut into the label on the production rig.** The boundary
  refinement defined "label tone" as the frame's brightest 2% (98th
  percentile − 8 = 246 here). Under the rig's lighting the label's left
  edge reads 214 and only reaches 250 across the label, so the whole dim
  third was "not label" and the left side walked ~100 columns in, past
  the barcode, on three frames in four. The same physical label on a
  fixed rig came out anywhere from 1165 to 1272px wide and 1688 to 1824
  tall — placement variation *added* by the node meant to remove it.

  The refinement now looks for a **step**: the innermost place where the
  mean tone rises ≥ 12 levels across three bins and everything outside it
  is darker than the label past it. A halo's inner edge qualifies, a
  barcode band's inner edge does not (the label's own margin sits in its
  outside strip), and a lighting ramp (~0.6 levels/bin) is not a step.
  Tone profiles are taken over the central 60% of the rect so the sides
  not yet trimmed cannot dilute them. Over the 162-frame run: width spread
  96px → 17px, height wobble gone, every frame keeps its barcode, no frame
  changed between hit and miss, and every existing fixture (halo, seam,
  print-inside-label, clipped) still passes. A boundary fainter than 12
  levels — this rig's label liner, 4 levels off — is left in: the crop
  errs outward, never into the label.
- **`label-crop` in front of `golden-compare` measured on the production
  rig — and left out of the flow.** `bench/nuisance-e2e.js --labelcrop 1`
  runs the 162 frames both ways: 0 → 79 of 148 good frames rejected, no
  change on the 14 bad. The golden artwork is wider than the cropped label,
  so the position gate loses the frame margin it measures against and the
  clamped alignment search lands ~10% worse (6× the background ratio).
  When the label is the frame there is nothing for label-crop to remove;
  README, ARCHITECTURE and the bench doc now say so with the numbers.
- **`label-crop` misses report what the gate measured.** A
  `border-contact` miss carried `borderContact: 0` and `dominance: NaN`;
  it now carries `borderContact: 0.75`, and fields a gate never reached
  are `null` rather than 0. On this rig that reads straight off as
  "raise `maxBorderContact` to 0.75", which takes the run from 137 to 151
  of 151 full frames detected.

## [1.2.0] - 2026-09-10

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
  native OpenCV engine instead of from the staged sweeps. On a
  4096x5500 frame, pinned: align 545ms -> 338ms, search 325ms -> 125ms.
  `result.transform.seeded` reports whether a seed was actually used.

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

A review surfaced nineteen distinct issues; every confirmed one is fixed
below with a regression test. The suite grew from 44 to 100+
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
