# @graciousstar/node-red-contrib-vision-tools

Machine-vision nodes for Node-RED, built around one assumption: the camera
is fixed. Framing, scale and lighting hold from shot to shot, so the
expensive parts of inspection — where the part is, how many millimetres a
pixel covers, where the label edge falls — can be measured once at
commissioning and only checked afterwards.

This file is the operator's guide: what the settings do and how to use
them. [ARCHITECTURE.md](ARCHITECTURE.md) is how the pipeline is put
together and why each piece is shaped the way it is; version history is
in [CHANGELOG.md](CHANGELOG.md).

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
  `pdf-to-image`. The per-pixel stages run on a worker pool. With a
  profile directory set, each golden keeps its own trained state in one
  file named after its source file, so a rig switching products keeps
  every product's training.
- **`checkerboard-calibrate`** — photograph a printed checkerboard of
  known pitch, measure the pixel pitch, and save or compare the resulting
  mm/px scale. Run once at commissioning and again after camera or
  mechanical maintenance, not per frame. The same photo also measures how
  far off-axis the camera looks at the tray, as a plane homography saved
  next to the scale.
- **`perspective-rectify`** — flattens each frame through that
  homography, so a camera that is a degree or two off-axis hands
  `label-crop` and `golden-compare` the keystone-free view a square-on
  camera would. Measured once, applied per frame; nothing is detected on
  the production image.
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
  The regions can come from the artwork itself: the barcodes
  `golden-compare` found on the golden, mapped onto the camera frame
  through its trained transform. Works offline.
- **`synthetic-defects`** — a test bench, not a production node: takes a
  golden and emits camera-like frames of it with known defects painted in,
  one message at a time, each carrying the golden it was made from and the
  exact ground truth, so a flow can watch what `golden-compare` says about
  every defect family and size.

Every node ends its status line with the time the frame took, `84ms` or
`1.23s`: wall-clock from the message arriving to the verdict, previews and
encoding included, so the editor shows what the flow waits for. The
per-stage breakdown, where a node has one, is on the message (`msg.timings`,
`msg.labelCrop.timings`, `msg.lineFinder.timings`, `msg.rectify.timings`).

A ~23MP camera frame decodes, aligns, diffs and heat-maps in well under a
second: around 0.45s against a same-scale golden, and roughly double that
when magnification and stretch both have to be searched over a wide range
(see Notes).

## Install

From the Node-RED palette manager, search for
`@graciousstar/node-red-contrib-vision-tools`, or from your Node-RED user
directory (`~/.node-red`):

```bash
npm i @graciousstar/node-red-contrib-vision-tools
```

Node 18 or newer. `sharp` and `zxing-wasm` are required and ship prebuilt
binaries for the usual platforms.

### `npm ci` does not work with this package

Use `npm install`. This is an upstream packaging bug: the optional OpenCV
engine declares `@rosepetal/node-red-contrib-image-tools-darwin-x64` in
its `optionalDependencies`, and that package was never published — the
registry 404s it while its four sibling platform packages resolve fine.
`npm install` skips it, which is what optional means; `npm ci` then
refuses the lockfile `npm install` produced, because the phantom is
`Missing from lock file`. No lockfile satisfies both while the engine is
in the tree:

```
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json ... are in sync.
npm error Missing: @rosepetal/node-red-contrib-image-tools-darwin-x64@ from lock file
```

If your build has to use `npm ci`, use `@techstark/opencv-js` as the OpenCV
engine instead (see below) and leave the native one out of the tree
entirely. Failing that, install the native engine's platform package for
your own platform directly
(`@rosepetal/node-red-contrib-image-tools-linux-x64`, `-linux-arm64`,
`-linuxmusl-x64`, `-darwin-x64` or `-darwin-arm64`) without the engine
package itself; or skip OpenCV altogether, which costs you `label-crop`
and two opt-in `golden-compare` acceleration paths and nothing else.

### The OpenCV engine

`label-crop` and two optional `golden-compare` acceleration paths need
OpenCV. Two engines can provide it, both **optional** dependencies — the
package installs and every other node works without either, and
`label-crop` reports a clear setup error rather than failing a part:

| | `@rosepetal/node-red-contrib-image-tools` | `@techstark/opencv-js` |
|---|---|---|
| kind | native C++ addon | opencv.js, WASM |
| platforms | Linux x64/arm64, Alpine x64, macOS x64/arm64 | anywhere Node runs, **including win32** |
| threading | native threads | single-threaded, on the event loop |
| start-up | dlopen | ~200ms to instantiate, once per process |
| codecs | decodes and encodes jpg/png/webp | none; raw in, raw out (this package delegates the two encode/decode points it needs to `sharp`) |

Which one answers is `lib/engine.js`'s decision. The default is the native
addon where it has a prebuilt binary and the WASM build everywhere else.
Set `VISION_TOOLS_ENGINE=native` or `VISION_TOOLS_ENGINE=opencv-js` to pin
one — a pinned engine that cannot load is an error, never a silent
substitution.

On a host with both installed, the two produce **identical** `label-crop`
results — `node bench/engine-parity.js` sweeps angles and label shapes and
every field matches exactly. The one deliberate difference is the
alignment warp's border fill, described in `lib/cvjsAlign.js`; it removes
a false background defect the native fill produces at the frame edge.

Measured on Alpine x64 (Node 24), same host, same frames:

| | native | opencv-js |
|---|---|---|
| `label-crop`, 3MP frame | 34ms | 64ms |
| `label-crop`, 24MP frame | 162ms | 375ms |
| `imageAlign`, 768px | 12ms | 30ms |
| `imageAlign`, 1024px | 18ms | 53ms |

So roughly **2–3× slower** on those ops, plus ~200ms once per process to
instantiate the WASM runtime. Run `node bench/engine-compare.js` to measure
your own hardware.

End to end the gap can be wider. Replaying the real `golden-compare`
handler in the Node-RED test container (`bench/golden-performance.md`,
September 2026, before the current pipeline's speed-ups), the WASM-backed
snapshot measured **456ms median** against native's **101ms**
at 12 workers with a named golden. Both graded that sample identically,
but their transforms and native/fallback paths differ, so read it as a
comparison of these two implementations rather than a universal WASM
penalty: the identical-results claim above is about `label-crop`, and
`golden-compare`'s alignment is where the two engines can reach the same
verdict by different routes.

### Native kernels

Five of `golden-compare`'s per-pixel pool kernels — the local alignment's
tile search and resampling, the binarization with the tone comparison
riding on it, the tone comparison alone, and the one-pass print and
background diff — have native twins in `native/kernels.cc`: a small
N-API addon with no dependencies (no OpenCV, no node-addon-api). They do
the JS kernels' arithmetic in the JS kernels' order, so `msg.result` and
`msg.heatmap` are the same to the bit whichever runs; they only make the
frame faster. On the rig (1475x2125 golden, 12 workers, all 162 sample
frames twice), a good frame:

| | median | p95 | p99 |
| --- | ---: | ---: | ---: |
| before | 65.9 ms | 81.4 ms | 91.0 ms |
| JS kernels | 62.9 ms | 78.9 ms | 85.4 ms |
| native kernels | **46.5 ms** | **61.1 ms** | **66.3 ms** |

("JS kernels" has the other change that came with them: the raw
overlay's canvas is built off the inspector thread, which the native
kernels had made the critical path.)

The binaries ship **inside the package**, in `prebuilds/<platform>-<arch>/`,
so there is nothing to compile and no install script: the palette
manager and `npm install --ignore-scripts` get the same files.

| platform | binary |
| --- | --- |
| Linux x64, glibc 2.17 or newer | `prebuilds/linux-x64/vision-kernels.glibc.node` |
| Linux x64, musl (Alpine, the official Node-RED image) | `prebuilds/linux-x64/vision-kernels.musl.node` |
| Linux arm64 (glibc, musl), Windows x64, macOS arm64/x64 | built by `.github/workflows/prebuild.yml`, not yet in a release |

Any CPU of the architecture runs them (baseline x86-64 / armv8-a; the
tile search picks an AVX2 build of its inner loop at run time on Linux
x64 where the CPU has it).

**Fallback.** Anything that stops the addon loading — no binary for the
platform, a Node without N-API 8, a binary from another version of the
kernels — leaves the JS kernels running, with one line in the Node-RED
log at startup saying which kernels it runs and why
(`golden-compare: JS pool kernels - no prebuilt binary for …`; a binary
that is there and fails to load is a warning). Set
`VISION_TOOLS_KERNELS=js` to run the JS kernels anyway, which is how to
check the two against each other on one host. The JS kernels stay the
reference: the tests hold every native kernel to them byte for byte.

**Building from source**, for a platform without a prebuild — from the
package directory (`node_modules/@graciousstar/node-red-contrib-vision-tools`):

```bash
cd native && npx node-gyp rebuild        # needs Python and a C++ toolchain
# or, on Linux and macOS, with the compiler alone:
mkdir -p native/build/Release
sh native/build.sh native/build/Release/vision_kernels.node "$(dirname "$(dirname "$(which node)")")/include/node"
```

`native/build/Release/vision_kernels.node` is loaded in preference to the
prebuilds. Whatever builds it must keep floating-point contraction off
(`-ffp-contract=off`, no `-ffast-math`; MSVC `/fp:precise`), which both
build files do: an FMA rounds once where the JS rounds twice, and the
bytes would then depend on the CPU.

## How `golden-compare` works

1. **Golden reference** (`goldenPath`, or `msg.golden`) is decoded,
   grayscaled, downscaled to `workingSize` and binarized **once** and
   cached, along with the density lattices the alignment search compares
   against. Its foreground mask is dilated by `backgroundTolerance` px to
   create the background-check's tolerance band.

   Binarizing uses `thresholdMode`: `otsu` (the default — one level per
   image, chosen to separate the two intensity modes, which absorbs
   uniform exposure change), `fixed` (one hand-set level — fastest and
   perfectly repeatable, but it drifts out of calibration as the lighting
   does), or `sauvola` (a per-pixel level from the local mean and standard
   deviation — also absorbs lighting *gradients* across the part). Otsu
   and Sauvola make golden and frame independently self-normalizing,
   which is why Otsu is the default: the golden is normally PDF artwork —
   synthetic pure black on pure white — and the frame is a photograph, and
   no single grey level is correct for both.

   Whichever mode is chosen the decision is still a hard cut, so
   `inkMargin` (grey levels, default 8) marks a pixel **ambiguous** when
   it lies within that many levels of the level it was judged against, on
   *either* side, and both blemish checks drop a pixel from the evidence
   when either image is ambiguous there. This catches two reproducible
   false regions against artwork — a screened tint that binarizes to
   background in the PDF and ink in the photograph, and Otsu's level
   walking with resolution above `workingSize` 1024 — see
   ARCHITECTURE.md, "Thresholding and ambiguity", for the numbers.
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
   isotropic scale can only split that error; on body text the leftover
   is the whole stroke, so ~12% of pixels disagree and both blemish
   checks fail a good part. Searching `mx` and `my` separately takes the
   same pairs to ~0.06%. The search is coarse-to-fine — density-lattice
   sweeps over scale, angle and translation, then a **polish** on actual
   pixel disagreement — and the matched region is resampled into golden's
   grid by `lib/warp.js`, area-averaging when the frame out-resolves the
   golden so fine text is downsampled rather than aliased.

   `alignSearch` adds translation slack beyond the pure size difference.
   Set `scaleSearchMin`/`Max` both to 1 to pin the magnification,
   `maxAspect` to 0 to assume both axes share a scale, and `maxAngleDeg`
   to 0 to disable the rotation search — worth doing for any of them if
   the rig is fixtured tightly enough that searching is only a chance to
   be wrong.
4. **Position check**: the recovered placement is compared against
   tolerance bands around *nominal* — centered in the available margin and
   square to the frame, which reduces to a tolerance around exactly
   `(0,0)` when target and golden are already the same size. The offset
   is measured at the label's centre, so a part rotated about its centre
   reports the rotation and no offset; at the corner, half the label's
   height times the sine of the angle would be charged as one. Offsets in
   mm if `scaleFilePath` points at a calibration baseline (see below),
   else in px. Rotation is gated separately, in degrees, against
   `positionToleranceAngleDeg`: a part that is offset and a part that is
   skewed are different faults with different causes.
5. **Blemish checks**, both against the *matched/cropped* target:
   - *print* — golden has ink the target is missing, even after dilating
     the target's ink by `printTolerance` px
   - *background* — target has ink the golden never has, even after
     dilating the golden's ink by `backgroundTolerance` px
   - *tone* — on grey rather than on the ink mask: each pixel's grey
     against what the artwork's own grey at that pixel should photograph
     as - the paper and ink levels of its neighbourhood (the 80th
     percentile of paper and the 20th of ink per 128 px cell, so lighting
     cancels) with the golden's grey mapped linearly between them, so a
     grey panel in the artwork is expected grey - as a fraction of the
     paper-to-ink span. A pixel `toneThreshold` (0.3) of the span from
     where it should be is a tone defect: a smudge at 70% opacity reads
     0.56, a ghosted second impression 0.46, a stain a few levels off
     paper 0.1-0.2 - none of which the two binary checks can see, because
     none crosses the ink threshold. Registration is never exact, so a
     pixel is accepted if the artwork predicts its grey anywhere within a
     register slack of it. That lets blur and a few px of register at an
     edge through, at the price of specks and hairlines that close to
     ink. With **from training** ticked (`toneMarginAuto`, the default)
     each tile runs with the slack training measured for it (see **Train
     the transform**); `toneMargin` (6) is the fallback for an untrained
     rig, or the one slack when unticked.
     `msg.result.toneBlemish.marginMinPx` / `marginMaxPx` say what a
     frame ran with. `toneThreshold` 0 switches the check off; a golden whose paper
     and ink cannot be told apart, or a frame showing too little of
     either, leaves the check off with a `reason` on the result and one
     warning per golden.
   - *specks* — the same tone deviation at `speckThreshold` (0.3), as
     connected components of at least `speckMinArea` (3) px, counted.
     Dust and pinholes are one to three px each and never make a block
     dense, and after the camera's blur not enough of them are at ink
     level for `failRatio`; what they have is number. A component the
     tone check has already failed is tone's evidence, not a speck. The
     part fails at `speckMaxCount` (8) specks, or at one speck of
     `speckMaxArea` (48) px - a single spatter no block gate sees. 0
     switches the check off, and 0 on either gate removes that gate.

   Print and background are disjoint per pixel, so they never double-count
   the same defect. Each diff is block-summed into a density grid (`blockSize` px),
   thresholded (`blockThreshold`), and flood-filled into defect bounding
   boxes; each fails independently if any region exceeds `failThreshold`
   or its overall defect ratio exceeds `failRatio`. The outer `edgeMargin`
   px of the golden (default 0) are left out of every check: the label's
   own edge lands there, and so does whatever sits just past the printed
   artwork - the die-cut's substrate, a lifted edge's shadow - which is
   not a mark on the artwork. The position check still bounds how far the
   label may sit from nominal. The print check has a third gate,
   `printMissingFraction`: a block that lost at least that fraction of the
   ink the golden has *in that block* fails, however small a share of the
   block's area that ink was. Body type is 10-15% ink, so a dropped word
   never reaches `failThreshold` by area and never reaches `failRatio`;
   against its own ink it reads 1.0. Blocks with under 6% golden ink are
   left out of it, so a stroke clipping a block's corner cannot read as
   "lost everything". 0 switches it off.
6. Overall `pass = position.pass && printBlemish.pass && backgroundBlemish.pass && toneBlemish.pass && speckBlemish.pass`.

Decode/resize uses [`sharp`](https://sharp.pixelplumbing.com) (native,
libvips) — the images here run 20+ MP, and a pure-JS decoder was too slow.
Everything after decode (threshold, dilation, alignment search, diff,
block-sum) is plain typed-array math with no further native dependencies.

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

`msg.images[]` is *per-page metadata only* — page, width, height,
channels, path — and carries no pixels. It is the wrong thing to reach
for here. When `msg.golden` is a path or a buffer that carries its own
container, `msg.images[]` geometry is ignored entirely, so a stale `RAW`
message left over from an earlier step cannot stamp the frame's
dimensions onto a file golden.

Things to know:

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
  instead — a path, a revision, an mtime — and the hash is skipped.

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
match: { score, grade, coverage, labelMissing, mismatchSuspected, reason }
```

`score` is the alignment residual, `grade` is `good` (< 0.06) / `marginal`
/ `poor` (≥ `mismatchScore`). Measured here: a correctly paired label
registers at **0.02–0.05**, a badly printed one at about **0.10**, and
another product's artwork at about **0.18**. A frame that fails
everywhere with a high score is misaligned, not defective — check that,
and that the golden is the right *product*, before believing the blemish
numbers.

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

`coverage` is the fraction of the golden's ink that is ink in the aligned
frame, and `labelMissing` is that fraction under `minCoverage` (default
0.5; 0 disables). It exists because every other check asks what is wrong
with the label and assumes there is one. A blank tray answered all of them
"nothing": the search sat at nominal because every placement scored
alike, a wide `inkMargin` voided every blemish claim as ambiguous, and
the frame passed. A badly printed part still covers 90%+, a blank frame
about 0, and the wrong artwork lands between - which also catches the
mismatch case when the ambiguity band hides the saturation the flag above
needs. A `labelMissing` frame fails, `reason` says so, and the status
reads `label missing?`.

### Speed

A 4096×5500 PNG frame against a 1844×2656 golden, pinned, heat maps on,
12 workers, is ~1.05s in this project's container. What moves that,
largest first:

| lever | effect |
| --- | --- |
| `debugStages` | **+690ms** when on. Pure diagnostics |
| heat maps | **+~300ms** when on. Display output; the verdict does not use them |
| trained transform | **halves** the alignment, and accuracy is the reason to pin, not speed |
| native kernels | a good frame 65.9 → **46.5ms** median on the rig (1475x2125 golden, 12 workers), identical results. On by default where a prebuilt binary loads; see **Native kernels** above |
| `workers` | the per-pixel stages and both summed-area tables run on the pool. 0 picks one per core up to **16**; on a 16-core host, 8 → 12 workers took align 798ms → 680ms |
| `nativeFastAlign` | aggressive OpenCV prototype: 663ms → **243ms** on the clean PNG and 1065ms → **443ms** on the high-compression reject. See below |
| `nativeAlignSeed` | conservative prototype, off by default: align 545ms → 338ms. See **Native alignment seed** below |
| raw input instead of PNG | **−~75ms** on this frame (decode 143ms → 70ms for mono). The saving is the *decode*, so it scales with the PNG's compressed size rather than its pixel count — a 13.7MB PNG of the same dimensions decodes in ~560ms |
| the host's power profile | **~2.2×** on everything. Measured on a laptop that had dropped to battery mode mid-session: align 2020ms → 913ms on mains, no code or setting changed |

Docker is **not** on that list. Running this project's own
`bench/frame-bench.js` inside the container reproduces the host's numbers
within ~10% (pinned search 236ms vs 222ms, unpinned align 2075ms vs
2219ms). What looked like a container tax was the power profile above.

`workingSize` is the one that changes *what is detectable* rather than
just how long it takes — see Notes before lowering it.

`bench/frame-bench.js` times one frame; it says nothing about whether a
defect was *found*. For that there is `bench/synth/` — a generator that
writes camera-like frames of a label with scratches, marks, misprints and
overprints injected at known positions and sizes, and `bench/synth/run.js`,
which runs the whole set through the library pipeline and scores the
verdicts *and the reported regions* against that ground truth. It reports
recall per defect family, variant and size, the false-fail rate on clean
frames, and will sweep any single setting (`--sweep blockThreshold=…`) to
show what a change costs in one and buys in the other. A frame that fails
for the wrong reason is scored as a `wrong-place`, not a detection — see
`bench/synth/README.md`.

### How `synthetic-defects` works

The same generator, in the editor. `synthetic-defects` takes a golden —
`msg.payload` as image bytes, a path or a raw pixel descriptor; else the
`Golden` path configured on the node (`msg.goldenPath` overrides it), so
your own label's artwork is the golden with an empty inject; else nothing
at all, in which case it draws the synthetic label itself — and emits the
frame set one message at a time on output 1, with the golden announced
once on output 2 first. Whichever golden it is, the defects are painted
into that artwork, so a set made from a real label exercises
`golden-compare` on that label's strokes and paper. Every frame message carries `msg.payload` (the
frame), `msg.golden` (the golden as PNG), `msg.goldenKey` (so
`golden-compare` prepares that golden once for the whole run instead of
re-hashing it per frame), `msg.filename`, and `msg.synth` — the case id,
its position in the run, the family/variant/severity, every sampled
camera parameter, the measured ground truth, and `expected`.

The node previews itself, on by default: the golden and then each frame
appear under the node on the canvas as they are sent, with every defect's
measured ground-truth box drawn on the frame. The box is mapped from
golden space through the capture's own magnification, rotation and
placement (`frameBox` in `lib/synth/capture.js`), so it sits on the
painted defect as the parallelogram it became rather than beside it as an
upright guess. The outline colour is the channel the defect landed in
(blue print, red background, purple both, dashed grey for a sub-floor
defect the node must still pass) and the caption says the case, its place
in the run, and what `golden-compare` is expected to answer. `Preview
width` sizes the thumbnail; `msg.previewEnabled` / `msg.previewWidth`
override per message.

`Fixed rig`, on by default, shoots the whole set at one magnification and
one press stretch drawn once from the capture preset's range - what a
camera on a stand and one media give a line, and what `golden-compare`'s
trained transform pins. Angle and placement still vary per frame. Train
`golden-compare` from the golden message or any clean frame and the set is
judged the way the line is. Untick it and every frame draws its own
magnification: that exercises the alignment search rather than the blemish
checks, and books the search's misses as false fails - the state the first
benchmark write-up measured.

Wire output 1 straight into `golden-compare`, which reads `msg.golden` and
`msg.goldenKey` off the message, so each frame is compared against the
very golden it was made from. Put a debug node on `msg.result` and another
on `msg.synth.expected`, and with both nodes' previews on, the gap between
what a defect is and what the node called it is visible frame by frame.
An interval setting (500ms by default) paces the run so a person can watch
it. `examples/synthetic-defects-into-golden-compare.json` is that flow; a
function node in it trains `golden-compare`'s transform on the first frame
of each run so every later frame is pinned, the way a line runs.

It is a look, not a measurement: for scored numbers — recall per family
and severity, false-fail rate, timing percentiles, setting sweeps —
generate a set to disk with `bench/synth/generate.js` and run
`bench/synth/run.js` over it, offline, where frames go through strictly
one at a time. Both read the same `lib/synth/`, so the frames are the
same frames.

Per-message overrides:
`msg.threshold`, `msg.thresholdMode`, `msg.sauvolaRadius`, `msg.sauvolaK`,
`msg.inkMargin`, `msg.printTolerance`, `msg.backgroundTolerance`,
`msg.edgeMargin`,
`msg.alignSearch`, `msg.scaleSearchMin`/`Max`/`Steps`, `msg.maxAspect`,
`msg.aspectSteps`, `msg.maxAngleDeg`, `msg.angleSteps`,
`msg.alignCandidates`, `msg.localAlign`, `msg.localAlignTile`,
`msg.localAlignMax`, `msg.workers`, `msg.mismatchScore`, `msg.minCoverage`,
`msg.trainTransform`, `msg.trainNuisance`, `msg.nativeAlignSeed`,
`msg.nativeFastAlign`,
`msg.positionToleranceXMm`/`YMm`/`XPx`/`YPx`/`AngleDeg`, `msg.blockSize`,
`msg.blockThreshold`, `msg.failThreshold`, `msg.failRatio`,
`msg.printMissingFraction`, `msg.toneThreshold`, `msg.toneMargin` (sent
on a message it overrides the trained slack), `msg.toneMarginAuto`,
`msg.outputToneHeatmap`, `msg.speckThreshold`, `msg.speckMinArea`,
`msg.speckMaxCount`, `msg.speckMaxArea`, `msg.outputSpeckHeatmap`,
`msg.outputHeatmap`, `msg.outputPrintHeatmap`, `msg.outputBackgroundHeatmap`,
`msg.heatmapFormat`, `msg.heatmapQuality`, `msg.debugStages`.

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

The native result is accepted only when it stays inside `maxAngleDeg` and,
under a trained transform, within 3% of each trained magnification; a
result that fails either falls back to the JS alignment and
`result.transform.nativeFallback` explains why, so OpenCV cannot explain
small artwork differences as large scale/stretch changes. Without a
trained transform there is no magnification to hold it to, and a
full-resolution disagreement score above 0.15 falls back instead. Under a
pin that score is deliberately *not* a gate: disagreement cannot tell a
misaligned frame from a defective one, and gating on it sent every heavily
defective print through the full JS search (seconds on the rig, against
~70ms) to reach the same verdict. A validated native alignment is kept and
the disagreement is reported as the defect it is.

When the fast path does fall back, the `nativeAlignSeed` seed is **not**
tried on that frame: it is the same engine call again at full resolution
with more iterations, so on a frame OpenCV has just failed it can only
fail slower. On the rig that second call was where every slow fail spent
its time - 0.3s to produce nothing, 4-7s to produce a seed the polish
made nothing of. The JS sweeps find the start instead, in ~200ms.

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
A missing or failed engine falls back to JS.

### Native alignment seed (prototype, off by default)

Tick **Native alignment seed** or send `msg.nativeAlignSeed = true` to
start the pinned search from an ORB+ECC alignment
measured by the OpenCV engine (either one — see **The OpenCV engine**),
instead of from the staged sweeps. On a 4096×5500 frame that took align
from 545ms to 338ms, and the search itself from 325ms to 125ms.

The engine is **not a dependency**. Without it the flag is inert and the
node behaves exactly as it does today, bit for bit —
`test/nativeSeed.test.js` asserts that.

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

### Profiles: one file per golden

Without **Profiles**, the trained transform (`transformFilePath`) and the
nuisance map (`nuisancePath`) each live in one file per node. Both are
tied to one golden by its content hash and refused when the golden
changes, which is right, but it means a node that runs a second artwork
searches unpinned with no nuisance map every time the product changes,
and training the second artwork overwrites the first.

Set **Profiles** (`profileDir`, e.g. `/data/golden/profiles`) and every
golden gets its own `<id>.json` there, holding everything trained or
derived for it: `transform` (with its register slack), `nuisance`, and
`barcodes` (below). The node picks the file from the golden on every
message, so a rig switching products keeps each one's training.

**How the file is named.** The first rule that applies wins:

1. `msg.profile` — a *name*, never a path.
2. The golden's source file. That is **Golden image path** when it is the
   golden in use (no `msg.golden`); otherwise, in order, a path in
   `msg.golden` (a string or `{ path }`), `msg.images[0].path`,
   `msg.filename` **only when it ends in `.pdf`, `.ai`, `.eps` or `.svg`**
   (any case; set by `file in` and passed through by `pdf-to-image`),
   `msg.goldenKey` (its basename if it looks like a path, else the key
   itself), and last **Golden image path**. The file's stem is used,
   without the extension; when the golden came on the message and
   `msg.images[0].page` (or `msg.page`) is above 1, `-p<page>` is appended,
   because page 1 and page 17 of one artwork PDF are different labels.
   `/data/Inspection/pdf/Demo_Good_60.pdf` becomes `demo_good_60.json`.
   A camera frame's `msg.filename` never names a profile: when the golden
   rides on the frame's message, a `file in` reading the frame sets
   `msg.filename` to the frame's `.jpg`/`.png`, and every frame would get
   its own profile, with training landing where no later frame looks.
3. Only when there is no name at all: the first 16 hex digits of the
   golden's content hash, plus `-WxHxC` for raw pixels
   (`a1b2c3d4e5f60718-2950x4250x4`).

Every id is lower-cased, anything outside `a-z 0-9 . _ -` becomes `_`,
leading dots are stripped, it is capped at 64 characters, and Windows
reserved names (`con`, `aux`, `com1`…) get a `_` prefix.

**The name chooses the file; the hash is the check.** Every section in it
carries the golden's content key and is compared strictly, on every read.
So a revised artwork saved under the same file name lands on the same
profile and has its sections refused, with a warning that names the
profile, until it is retrained:

```text
profile demo_good_60: trained transform was measured against different golden content (…) - retrain it; searching for the transform instead
```

The barcode section is re-derived automatically, and retraining overwrites
the section in place. Two different PDFs with one name in different
folders collide the same way; give each its own `msg.profile`.

**The trap in the fallback.** A golden that arrives as bare bytes with no
name (no path, no artwork `msg.filename`) is filed under its hash, and the hash is
of the bytes. The same artwork delivered as a PNG one day and as a RAW
render the next is two different byte streams, so it lands in two
profiles and the second starts untrained. Let `msg.filename` through to
the node, or set `msg.profile`.

**Migrating from `transformFilePath` / `nuisancePath`.** With **Profiles**
set the profile is the source of truth, and training writes the profile
only. When a profile has no `transform` (or `nuisance`) yet and the
matching legacy path points at a file that validates for this same golden
(content key compared strictly), that file is imported into the profile
once, with one log line:

```text
profile demo_good_60: imported the transform from /data/golden/transform.json -> /data/golden/profiles/demo_good_60.json
```

A legacy file trained on another golden is passed over **quietly**: at
most one log line per golden and file version, never a warning, never a
`pinRefused`, and it is not re-read per frame. The editor's default
`/data/golden/nuisance.json` is usually exactly that case. The legacy files
are never modified. If writing an imported record into the profile fails,
the frame still uses the record (it is this golden's), the node warns once
per file version ("… retrying on later frames"), and later frames try the
import again rather than running unpinned in silence.

**One Node-RED per directory.** Writes to one profile are serialised inside
one Node-RED process — transform training, nuisance training and barcode
derivation can all land on the same file within a frame — so several nodes
in one Node-RED can share a directory. Separate Node-RED processes sharing
a directory are not serialised against each other; give each its own.

**What it costs.** In profile mode every message needs the golden's content
key, since that is what each section is checked against. It is memoised
per golden version (keyed by the cheap golden key, raw geometry and byte
length, 16 goldens per node), so a **Golden image path** golden is read
and hashed once per file version per deploy, and a rig alternating two
products does not re-hash on every switch. A `msg.golden` buffer is hashed
per message, as it already was. Each message also costs one `fs.stat` of
the profile; it is re-read only when its mtime or size moved.

**What applied:** `msg.result.profile`, present only with **Profiles** set:

```js
profile: { id, namedBy: "profile" | "source" | "content", path, contentKey, transform, nuisance, barcodes }
```

`transform` / `nuisance` say whether this frame pinned from, applied, or
trained-and-wrote that section. `barcodes` is the region count of a
`barcodes` section derived from this golden's content, otherwise `null`
(not derived yet, or derived from other artwork); on the frame that
triggers a derivation it is still `null`, because the derivation runs
after that frame is sent. `path` is what `barcode-locate` reads its
regions from.

**The trained transform records the frame it was measured on.** In the
profile and in a legacy file alike, a transform trained by this version
gains:

```text
frameWidth, frameHeight              the frame at working size
frameNativeWidth, frameNativeHeight  the frame as golden-compare received it
placement: { ox, oy, angleDeg }      where the golden sat in the run's last written training frame (working px)
```

The scales alone map golden px to frame px only up to an offset; these are
what let `barcode-locate` carry a box from the artwork onto the native
camera frame. A transform trained before this version lacks them, and
`barcode-locate` asks for a retrain.

**Barcode regions** (`barcodeRegions`, default off, no `msg.` override;
does nothing without **Profiles**). With it ticked the node reads the
golden's barcodes — whole image, the default formats, `tryHarder` and
`tryRotate` on — and stores each symbol's box in golden native px,
unpadded, with its format, text and a `label` of `"<format> <text>"` (at
most 60 characters):

```js
barcodes: { source: "golden", derivedAt, goldenContentKey, nativeWidth, nativeHeight,
            regions: [{ label, format, text, x, y, width, height }] }
```

It runs when the section is missing or was derived from another content
key, or on `msg.deriveBarcodes: true` (which works with **Profiles** set
even with the box unticked, and warns once without them). It starts after
the triggering frame has been sent and is never awaited by it — a 12 MP
render through zxing is hundreds of ms that frame should not carry — and
there is one derivation per profile and golden version at a time, shared
by every `golden-compare` node in the process, so neither the frames that
arrive meanwhile nor a redeploy mid-derivation start a second zxing run.
The status reads `locating barcodes on golden…` while it runs and goes
back to the last verdict when it finishes, unless a frame has set a
status since; the log line gives the count and the ms. A golden with no barcode stores `regions: []`, so it is
not re-read every frame, and warns once; a failure warns once, is not
retried for that golden version unless `msg.deriveBarcodes` asks, and
never fails the frame. `golden-compare` loads zxing-wasm only when this
is on.

### Output

- `msg.payload` — `true`/`false` overall pass
- `msg.result` —
  `{ pass, position: { dxPx, dyPx, dxMm, dyMm, angleDeg, anglePass, scale, scaleX, scaleY, stretchPercent, pass }, transform: { pinned, native, nativeFallback?, seeded, pinRefused?, scaleX, scaleY, scale, stretchPercent, angleDeg, ox, oy, score }, match: { score, grade, coverage, labelMissing, mismatchSuspected, reason }, thresholds: { golden, target }, localAlign: { tiles, localised, meanPx, medianPx, maxPx }, register?: { frames, tiles, localised, spurious, beyond, searchPx, medianPx, p98Px, maxPx, slackPx, slack: { tile, gridW, gridH, slackPx[] } }, printBlemish: { pass, defectRatio, regions: [{x,y,w,h,density,avgDensity,missing,cells}], worstMissing }, backgroundBlemish: { pass, defectRatio, regions, worstExcess, noveltyPass }, toneBlemish: { enabled, pass, defectRatio, regions, paperLevel, inkLevel, marginPx, marginTrained, marginMinPx, marginMaxPx }, speckBlemish: { enabled, pass, count, area, largest, regions: [{x,y,w,h,area}] } }`
  (region coordinates in the working-resolution image, same size as the
  heat maps — not the original camera resolution). `transform` is the raw
  recovered placement in frame-canvas pixels: `pinned` reports whether a
  trained transform was used, `seeded` whether it started from a native
  ORB+ECC seed rather than the staged sweeps, and `pinRefused` is present
  with the reason when there was a trained record the node declined to
  use — it also warns, but a warning is easy to miss and the fallback to
  a full search is otherwise invisible from the message. `thresholds`
  reports the grey level each side actually used, so exposure drift is
  visible rather than merely absorbed; `match` is the registration grade
  described under **Grading** above; `localAlign` is the per-tile
  refinement statistics (`tiles` = tiles examined, `localised` = tiles
  that found a trusted offset, `meanPx`/`medianPx`/`maxPx` = the recovered
  displacement magnitude in working px) and is `null` when refinement is
  off. `worstExcess`/`noveltyPass` are the trained nuisance map's verdict
  (how far the dirtiest block exceeded its trained baseline, and whether
  that alone failed the frame); they are 0/`true` until a map is trained
  from a *Nuisance map* path with *Train the nuisance map* — see
  ARCHITECTURE.md, "The blemish floor, and the nuisance map that lowers
  it". The map is a background-channel check: the print channel is never
  gated by it.

  `msg.result.profile` — only with **Profiles** set:
  `{ id, namedBy, path, contentKey, transform, nuisance, barcodes }`, the
  profile this frame used and what it held for this golden; see
  **Profiles** above.

  `stretchPercent` — how far the two axis magnifications differ — is
  reported but deliberately **not** gated. Some stretch is just what the
  press does, and its normal value depends on media and machine, so any
  default threshold would be a guess that fails good parts. It is worth
  trending, though: a stretch that moves is a press drifting.
- `msg.heatmap` — every check's regions on the aligned frame in one
  picture, each boxed in its own colour with the defect pixels filled
  inside: blue extra ink (background), red missing ink (print), amber
  tone, green specks. What failed, where, and which check said so; only
  if `outputHeatmap` is on. The four below are one check each, per
  block - for tuning that check.
- `msg.printHeatmap` / `msg.backgroundHeatmap` / `msg.toneHeatmap` /
  `msg.speckHeatmap` — overlays, only if the matching
  `outputPrintHeatmap` / `outputBackgroundHeatmap` / `outputToneHeatmap`
  / `outputSpeckHeatmap` is on.
  `heatmapFormat` picks the encoding, measured at working size on real
  content: `jpg` ~22ms/350KB (default, quality `heatmapQuality`, 85),
  `png` ~25ms/3.7MB (lossless, zlib level 1), `raw` 0ms/9.4MB — no codec,
  a `{ data, width, height, channels, colorSpace, dtype }` object like
  `label-crop`'s output, for a flow that resizes or overlays before
  anything is displayed. The same setting governs the grey `msg.stages`
  images; mask stages are PNG or raw, never JPEG.
- `msg.timings` — `{ decodeMs, alignMs, diffMs, heatmapMs, stagesMs, totalMs }`
  plus the align bucket's own split, `nativeAlignMs`, `seedMs`, `tableMs`,
  `searchMs`, `warpMs`, `localAlignMs`, `thresholdMs` and, after a native
  fallback, the `nativeFallbackMs` the discarded attempt cost. The node's
  log line prints the same split and which way the frame was aligned
  (`native`, `js`, `js+seed`) with the fallback reason when there was one.
- `msg.stages` — only if `debugStages` is on: `Buffer`s for each
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
  Nms`, or `different label? · align <score> · Nms` when
  `mismatchSuspected`.
  The node's log line additionally carries the recovered angle and
  magnification, which is usually the first thing worth looking at when a
  whole batch starts failing at once.

### Seeing each stage

`previewEnabled` draws the node's last frame under it on the flow canvas:
the heat map of the channel that failed, or the aligned frame when
nothing did, with the verdict and the time. Click it and a viewer opens
on the whole inspection, in the order it ran - the golden and its ink
mask, the frame and its ink, the aligned frame, the two grown masks, each
defect mask, both heat maps, and the trained nuisance baseline drawn over
the golden when a map is loaded - with a sentence on what each stage
means and the numbers behind the verdict beside it. Arrow keys step,
`Esc` closes, and clicking the picture toggles 1:1 so a 3px streak can be
found. **Overlay on the golden** (or `o`) composites the stage over a
golden-side image - the ink masks over the golden's ink, everything else
over the grey golden, or pick one - as red/cyan by default: red where
only the golden has it, cyan where only the stage has it, white where
both do, so on the aligned ink mask a print defect is red, a background
defect is cyan and a misregistration is a coloured fringe along every
edge. Difference and blend (with a slider) are the other two modes. A
stage on the frame's own canvas, before alignment, is shown plain with a
note, since it has nothing to lie over. `previewWidth` (80-600 px) sizes
the thumbnail; both settings are per-message overridable.

The viewer opens **paused** on the frame you clicked: the runtime keeps
that inspection, alongside the latest, until you go live or close, so a
line running at speed cannot pull it out from under you
(`POST /golden-compare/last/:id/hold` with the frame's `receivedAt`,
refused with a 409 if that frame has already gone, in which case the
viewer opens on the newer one and holds that; `DELETE` releases it; the
two `GET` routes take `?t=` to name the held frame). **Go live** (or
`p`) follows each frame the node inspects instead, keeping the stage,
overlay and zoom you were on, and **Pause** holds again. The thumbnail
under the node keeps following meanwhile.

The node keeps one inspection per golden-compare node in memory for
this - the thumbnail, and every stage at working size while a
viewer is open - and serves it over
`GET /golden-compare/last/:id` (the verdict, timings and stage list) and
`GET /golden-compare/last/:id/stage/:key` (one image, in the format the
pipeline rendered it; `raw` is encoded on the way out). It survives a
redeploy, not a restart, and a deleted node's goes with it. The viewer
fetches each image as you step to it rather than all at once, so opening
it costs one image, not fifteen. With no viewer open the preview renders
only its thumbnail - the aligned frame shrunk in the inspector, with
each check's region boxes, so the full-size picture is drawn only when
the message asks for `outputHeatmap` or a viewer is open - so it can
stay on in production; the stages and the per-check heat maps are
rendered while a viewer is open on the node (it says so with
`POST /golden-compare/last/:id/watch` every few seconds and lets go on
close), and the frame it opens on is rendered in full then, from the
frame the node kept, while the inspector still holds the golden. The
message still carries only what the output boxes asked for.

## How `checkerboard-calibrate` works

1. Decode the checkerboard photo at native resolution (no downscale — best
   measurement precision), Otsu-threshold it (checkerboards are strongly
   bimodal, so no manual threshold tuning needed), and connected-component
   label the dark squares (`lib/components.js`).
2. Arrange the blob centroids into a `checkerboardRows × checkerboardCols`
   grid and measure the median pixel pitch between adjacent same-colour
   squares, in both axes (`lib/checkerboard.js`). Centroid/pitch-based
   only — no sub-pixel corner refinement and no lens-distortion model.
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
5. The same centroids give the camera's **perspective**. A lattice of
   where the squares *would* sit on a board seen square-on is fitted over
   the photo with a similarity (scale, rotation, translation — so the
   board's own placement is left alone), and the homography from the
   measured centroids to that lattice is what remains: the keystone. It is
   reported as `msg.result.perspective` and saved with the scale as
   `homography`, for `perspective-rectify` to apply per frame. On a
   square-on camera it is the identity.

   Read it in pixels: `rmsBeforePx`/`maxBeforePx` is how far the squares
   sit from where a flat board would put them — under a pixel and the
   camera is square-on for practical purposes; `rmsAfterPx`/`maxAfterPx`
   is what the homography could not explain (centroid noise, lens
   distortion) and should be well under a pixel; `maxCornerShiftPx` is how
   far the frame's own corners move when rectified. On a synthetic board
   with a 12% keystone the measurement reads 3.9px rms before, 0.16px
   after, and rectifying with it brings the board back to 0.23px. On this
   project's real rig it reads 1.6px before and 1.3px after — the camera
   is square-on, and what is left is lens distortion no homography
   reaches.

   The lattice takes the x and y pitch separately, so a board with
   rectangular cells (this project's measures `pitchY/pitchX = 0.855`) is
   **not** "corrected": one photo cannot tell a rectangular print from the
   camera's own aspect, and `golden-compare`'s independent `mx`/`my`
   already absorb aspect.

### Input

`msg.payload` — a photo of the printed checkerboard (Buffer or path).
`msg.save` (bool) — persist the freshly detected scale as the new
baseline. Optional per-message overrides: `msg.targetPitchMm`,
`msg.checkerboardCols`, `msg.checkerboardRows`, `msg.allowedErrorPercent`.

### Output

- `msg.payload` — `true`/`false` pass
- `msg.result` —
  `{ checkerboardDetected, currentScale, detectedScale, deviationPercent, bootstrap, pass, saved, pitchXPx, pitchYPx, nativeWidth, nativeHeight, perspective }`
  (scales in mm/px; `perspective` is
  `{ homography, rmsBeforePx, maxBeforePx, rmsAfterPx, maxAfterPx, maxCornerShiftPx, boardAngleDeg, points }`)
- `msg.timings` — `{ totalMs }`

## How `perspective-rectify` works

Wire it between the camera and `label-crop`. It reads the `homography`
`checkerboard-calibrate` saved and resamples every frame through it, so
the label reaches the rest of the flow as a square-on camera would have
seen it. Nothing is detected on the production frame: the geometry is a
property of the rig, measured once from a board with dozens of exact
correspondences, and every frame gets the same warp (ARCHITECTURE.md
explains why not a per-frame quad detection).

Whether it is worth wiring in is what `checkerboard-calibrate`'s
`perspective` numbers say (above). It is not a substitute for
`golden-compare`'s own alignment: the residual that node measures on a
correctly aligned pair is the label bowing on the tray, which is what
per-tile refinement is for. Rectification is for the case where the
*camera* is off-axis and the same trapezoid shows up on every frame.

The warp is bilinear, inverse-mapped, with the frame edge replicated
outward rather than filled — a black or white band along the edge would be
a fake feature to `label-crop`'s blob search and `golden-compare`'s
background check. Pure JS, so it runs the same on either OpenCV engine and
on a host with neither. Rows split across `workers` threads (0 = one per
core) on the same pool `golden-compare`'s warp runs on: ~20ms on a
1500×1850 RGB frame with 16 workers and ~140ms on 24MP RGB against ~1s
serial, off the Node-RED event loop either way. A homography that is the
identity passes the frame through untouched.

A frame at a different resolution from the calibration photo is fine as
long as it is the same field of view (the homography is rescaled). A
frame that cannot be rectified — a different aspect ratio (a different
crop of the sensor), or a payload that will not decode — **passes through
unchanged** with `msg.rectify.applied === false` and a `reason`
(`aspect-mismatch` / `input`), yellow status, one warning per distinct
reason; the inspection behind the node still runs on it. That is the
same rule `label-crop` applies to a miss: one odd frame is a per-frame
outcome, not a reason to stall the line.
`label-crop` regions drawn in calipers mode should be drawn on a
rectified frame, since that is what the node will see.

### Input

`msg.payload` — an encoded image Buffer, a file path, or a raw
`{ data, width, height, channels }` object (a bare raw Buffer with
`msg.rawInfo` is accepted too). `msg.outputFormat` and `msg.workers`
override the configured values.

### Output

- `msg.payload` — the rectified frame, same size and channel count as the
  input: a raw `{ data, width, height, channels, colorSpace, dtype }`
  object by default (what `label-crop` and `golden-compare` want), or an
  encoded jpg/png Buffer
- `msg.rectify` —
  `{ applied, reason, homography, width, height, channels, rescaledFrom, perspective, timings: { decodeMs, warpMs, encodeMs, totalMs } }`
  (`reason` is `ok`, `identity`, or on a pass-through `input` /
  `aspect-mismatch` with `error` carrying the message)

Setup problems are errors (`done(err)`), because no frame could ever pass
them: no scale file path, no calibration on disk, a calibration with no
homography (one saved before this node existed — re-run
`checkerboard-calibrate` with `msg.save: true`), or a corrupt file.

## How `label-crop` works

> **When it helps, measured.** On this project's rig the label fills 85%
> of the frame, and putting `label-crop` in front of `golden-compare`
> took good parts rejected from 0 of 148 to 79 of 148: the golden artwork
> is wider than the cropped label, so the position gate loses the margin
> it measures against and the alignment search is clamped. label-crop is
> for a frame with tray and table around a small label — see
> `bench/golden-performance.md` for the numbers, and leave it out when
> the frame is already the label.

`label-crop` deskews and tightly crops a physical label out of a camera
frame, so the rest of a flow sees the label straight and centred even when
the part sits at an angle or off-centre. It removes the *placement*
variation (where the label is in the frame); golden-compare then measures
the *print* (the artwork relative to itself). It is a separate node so the
cropped frame can be previewed, saved, or fed to other inspection steps.

**Engine.** All pixel work (decode, resize, Otsu, rotate, crop, final
encoding) runs in the OpenCV engine — either of the two described under
**The OpenCV engine**. If neither is installed the node reports a **setup
error** on every message rather than silently passing frames through,
because a missing engine would otherwise look like "no label found".

**Detection.** The frame is decoded once to a raw object, then downscaled
to `maxEdge` (640px long edge by default). OpenCV applies Otsu once; in
`auto` mode the small binary mask and its JS-inverted form cover both
polarities (dark-on-light and light-on-dark), and the better rectangle
wins. The JS side only ever sees this small mask: it finds connected
components, takes the dominant rectangle-like one, traces its exterior,
and fits the minimum-area rectangle around the convex boundary. Interior
print holes therefore cannot skew the label angle.

Because the label is part of the bright blob, that rectangle always
*contains* the label. A boundary pass then snaps each side inward to the
label's real edge, so a label that is clipped by the frame or blends into
a similarly-bright table crops to its true boundary instead of the whole
bright region. The boundary is a **tone step**: scanning inward, the
innermost place where the mean tone rises by at least 12 grey levels
across three columns/rows *and* everything outside it is darker than the
label just past it. A bright halo on the table qualifies (its inner edge
is a step, and the halo is darker than the label); the inner edge of a
printed barcode band does not (the label's own white margin sits in its
outside strip); a smooth lighting ramp across the label is not a step at
all. The native Sobel **edge** accumulator is the fallback for a seam on
an equally-toned surface, under the same outside-strip rule. Clipped
sides stay put. `refinedSides` lists which sides moved. A boundary
fainter than 12 levels (this rig's label liner, 4 levels off the label)
is left in — the crop errs outward, never into the label.

Confidence gates turn bad evidence into a **miss**, never a wrong crop,
and a miss reports the value its gate measured (`borderContact: 0.75`
against a 0.5 limit says exactly which setting to move; a field the gate
never reached is `null`, not 0): the blob must fall between
`minAreaFraction` and `maxAreaFraction` of the frame, fill at least
`minRectangularity` of its exterior rectangle, and not exceed
`maxBorderContact`. The 0.5 border default permits a label clipped at two
opposite image edges while rejecting a component covering all four. The
candidate must also be at least `minDominance` times the second-best blob
and, optionally, match `aspectRatio` within `aspectTolerance` and cover
`expectedSizeFraction` of the frame within `sizeTolerance`. The combined
confidence must reach `minConfidence`. `auto` polarity reports which side
won.

The **label size selector** in the node's edit dialog makes the size gate
visual: load any representative photo and open the **viewer** — a zoomable
modal (wheel / +/− / Fit / 100% zoom, Draw/Pan modes) that shows the image
large, so the drawn rectangle and its corner handles are clearly visible
while you fine-tune it. Apply copies the rectangle into `aspectRatio` and
`expectedSizeFraction` (resolution-independent: the fraction is relative
to that image). The size gate is applied **after** boundary refinement, so
the clipped or table-blended extents the refinement removes are not
counted — a badly detected rect (halo included, or the wrong product)
becomes a clean `size-mismatch` miss instead of a wrong crop.

**Deskew.** The label's axis-aligned bounding box (plus a small
`cropMargin` ring, so the rotate never samples past the ROI) is cropped
from the full frame and rotated by the detected angle — only the ROI is
ever rotated, never the whole frame. In the rotated canvas the label rect
is axis-aligned, so the final crop is the centred `w × h` rectangle:
exactly tight to the label. No perspective correction;
sub-`minRotateAngleDeg` angles skip the rotate entirely. The final crop is
encoded natively in the chosen `outputFormat` (raw object by default, or
jpg/png/webp).

### Cropping the rectangle a `line-finder` found

The third boundary mode, `upstream` (**From line-finder** in the editor),
detects nothing. A `line-finder` with four regions named `left`, `right`,
`top` and `bottom` already reports the rectangle they bound as
`msg.lineFinder.rect` — corners, centre, size and angle in full-frame
pixels, built by the same `rectFromLines` the calipers mode calls before
it crops — so a label-crop in this mode takes that rectangle off the
message and goes straight to the rotate and crop above. The recommended
flow is one line-finder, **Add rectangle** in its editor to lay the four
sides out scanning inward, **Run on this image** to tune them on the last
frame it saw, then a label-crop set to **From line-finder** behind it. The
tuning lives in one node, and the rectangle the line-finder draws on the
flow canvas is exactly what gets cropped.

What it reads: `msg.lineFinder.rect`, or `msg.rect` in the same shape when
a flow sets one — `{ ok, reason, center: { x, y }, width, height, angleDeg,
corners?, score?, residualPx? }`. `ok` must be `true`; centre, size and
angle finite; both sides at least 2px; the centre inside the frame. The
corners are optional and computed when missing. Nothing between a found
rectangle and the crop is gated in calipers mode, and the same holds here:
`aspectRatio`, `expectedSizeFraction`, `minConfidence` and the other blob
gates do not apply, while `cropMargin`, `minRotateAngleDeg` and the output
settings do. `msg.labelCrop` comes out as calipers mode would report the
same rectangle — the same crop geometry to the pixel — with
`reason: "upstream-rect"`, `polarity` null, and `confidence` the
line-finder's `score` (1 for a rectangle built by hand without one).

A rectangle that cannot be cropped is a **miss** — the payload passes
through unchanged — never an error, and `msg.labelCrop.reason` says which
kind: `no-upstream-rect` when the message carries no rectangle (the
line-finder has fewer than the four named regions, or nothing is wired in
front), `upstream-rect:<reason>` when the line-finder itself reported a
miss (`upstream-rect:missing-edge:top`, `upstream-rect:parallel-edges`),
and `bad-upstream-rect` when the rectangle is malformed. The line-finder's
own `msg.lineFinder.lines` is still on the message, so the region that
needs re-aiming is a debug node away.

`examples/line-finder-rect-to-label-crop.json` is the whole flow on a
synthetic frame — import it from **Import → Examples →
@graciousstar/node-red-contrib-vision-tools**: a function node draws a
480×312 label tilted 4° on a dark 800×600 tray, a line-finder with four
inward regions measures it, a label-crop in this mode crops it, and a
debug node shows `msg.labelCrop`. Replace the function node with a camera
or file-in node and re-aim the four regions in the line-finder's editor.

### Input

`msg.payload` — an encoded image Buffer (JPEG/PNG/…) or a raw
`{ data, width, height, channels }` object (the same shapes
`golden-compare` accepts). Any setting can be overridden per message by
name: `msg.boundaryMode`, `msg.edgeRegions`, `msg.maxEdge`,
`msg.polarity`, `msg.minAreaFraction`, `msg.maxAreaFraction`,
`msg.minRectangularity`, `msg.maxBorderContact`, `msg.minDominance`,
`msg.minConfidence`, `msg.aspectRatio`, `msg.aspectTolerance`,
`msg.expectedSizeFraction`, `msg.sizeTolerance`, `msg.cropMargin`,
`msg.minRotateAngleDeg`, `msg.outputFormat`, `msg.outputQuality`,
`msg.pngOptimize`, plus `msg.previewEnabled` and `msg.previewWidth`. In
`upstream` mode the rectangle itself is read from `msg.lineFinder.rect`,
or from `msg.rect` when present.

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

Enable **Preview** to render labelled **Before** and **After** JPEG
thumbnails beside the node on the flow canvas. `previewWidth` controls
each thumbnail's width. Previewing does not change `msg.payload`, is off
by default, and adds an extra resize/encode (plus another decode when the
original input is encoded). Click the preview to hide it.

`bench/label-crop-bench.js` renders a synthetic 6000×4000 (24MP) frame
(dark tray, rotated light label with bars) and reports raw, JPEG and PNG
p50/p95 timings. The 100–500ms/frame target is reported there, not
asserted in the test suite — wall-clock numbers move with the machine. The
engine decodes encoded Buffers synchronously while constructing
its worker, so raw camera frames are preferable when Node-RED event-loop
latency matters.

## How `line-finder` works

Find a straight edge inside each region you draw - one region for one
edge, or several for the sides of a rectangle.

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
`msg.lineFinder`. With one region it is `{ found, reason, line,
angleDeg, score, calipers, residualPx, points, region, imageWidth,
imageHeight, timings }`, plus `lines: [{ name, ...the same }]` so a flow
written for several regions reads one the same way. A miss is a normal
outcome - only an unusable payload is an error.

### Several regions

The node holds a list of regions, each with its own box, angle, scan
direction, polarity and edge select; the numeric tuning (calipers,
contrast, smoothing, outlier tolerance, ...) is shared by all of them.
With more than one region:

- `lines` — one entry per region in list order, each `{ name, found,
  reason, line, angleDeg, score, calipers, residualPx, points, region }`.
- `found` is true only when every region found its line; `reason` names
  the first that did not (`top:no-edge`).
- `rect` — when regions named `left`, `right`, `top` and `bottom`
  exist: `{ ok, corners, center, width, height, angleDeg, score,
  residualPx }`, corners in the order top-left, top-right, bottom-right,
  bottom-left - the same shape `label-crop` reports - or
  `{ ok: false, reason }` naming the side that missed.
- `intersections` — `[{ a, b, x, y }]` for every pair of found lines that
  is not parallel within the angle tolerance: the corner of an L-shaped
  fixture, say. Near-parallel pairs are skipped rather than reported as a
  crossing somewhere in the noise.

A flow saved before the list existed stores its one region in the flat
`regionX`/`regionY`/`regionWidth`/`regionHeight`/`regionAngleDeg` fields
and keeps working unchanged - an empty `regions` list falls back to them,
as a region named `line`.

Every tuning setting can be overridden per message by name
(`msg.calipers`, `msg.contrastThreshold`, …; `msg.scanDirection`,
`msg.polarity` and `msg.edgeSelect` apply to every region).
`msg.regions` replaces the whole list for that message, and `msg.region`
re-aims the node to a single region, so one node can be driven per
message rather than copied.

No OpenCV engine is needed, and only the region's own pixels are read, so
the cost follows the box you drew rather than the frame size.
ARCHITECTURE.md, "Why the caliper search is not OpenCV", has the
measurements behind that choice.

### Aiming the region

The list at the top of the dialog holds the regions; click one to select
it, and the fields, the thumbnail's handles and the viewer edit that one.
*Add* and *Remove* do what they say. **Add rectangle** lays out `left`,
`right`, `top` and `bottom` around the image centre - a box across each
edge of the central 60% of the frame, each scanning inwards - ready to be
dragged onto the real edges.

The editor's region selector is a zoom viewer, not a thumbnail: at
thumbnail scale the boundary this node exists to find is not visible at
all. Load a sample and it opens on it, zoomed onto the selected region,
drawing the scan direction, the edge being looked for, and one line per
caliper where that band will measure. The other regions are drawn
fainter, each labelled with its name; clicking one selects it.

Wheel zooms to the cursor, `Fit`/`100%` jump, right-drag pans. Dragging
on empty space draws a new region and takes the scan direction from the
drag; corner handles resize from the opposite corner, dragging inside
moves, the arrow keys nudge by a pixel (ten with Shift), and the amber
grip rotates about the centre to a tenth of a degree. `Apply` writes
every region back, `Cancel` and Escape do not. The footer warns when the box hangs
off the frame, which matters more than it looks: a caliper band that is
not wholly inside the image is skipped, so a box half over the edge
silently loses calipers rather than reading a partial average.

### Seeing what it did

`previewEnabled` draws the result on the flow canvas: every search region
as configured, every caliper hit (green kept, red dropped by the outlier
trim), each fitted line and the rectangle when four sides made one, with
angle, caliper count, score and residual - or one verdict per region.
Misses preview too - a score of 0.4 does not tell you whether the box is
aimed at the wrong edge, clipped by the frame, or straddling two steps,
and the picture tells you all three. It re-encodes the frame per message,
so it is for tuning, not production.

The editor's **Run on this image** button does the same without a deploy:
it runs the real search on the loaded sample with the dialog's current
settings, every region at once, and draws each caliper, its edge point
(filled when the fit kept it, hollow when the outlier trim dropped it),
each fitted line and the rectangle's corners over the thumbnail. With one
region a miss is explained in full - which gate stopped it and what to
move, from the strongest step any caliper actually saw: "strongest edge
contrast 1.3, threshold 2.0 - lower Contrast threshold below 1.3 to pick
it up" - so a faint white-on-white label edge is tuned in a few clicks
rather than a redeploy per guess. With several, the status line gives one
verdict per region: `left ✓ 0.1° · right ✓ 90.0° · top ✗ contrast 1.2<2.0
· bottom ✓ -0.0° · rect 1210×1760 px`. A sample chosen from a file is
decoded by the browser, so the runtime's figures can differ by a fraction
of a pixel; on the node's own last frame they are the node's own.

The dialog opens on the **last frame that went through the node**, so the
regions are drawn on the picture production actually sees and a file is
only needed before the first message. The node keeps that frame in
memory, by reference - one frame per line-finder node, which is the whole
memory cost - and it survives a redeploy but not a restart; a deleted
node's goes with it. **Reload last frame** fetches it again after more
frames have gone through, and Run on it searches the very pixels the node
saw (`GET /line-finder/last-frame/:id` serves the frame; `POST
/line-finder/run` with `nodeId` and no `image` searches it, and answers
with `source: "cached"`).

### Four of them make a rectangle

Name four regions `left`, `right`, `top` and `bottom` and the node
reports the rectangle itself in `msg.lineFinder.rect`. The simplest way
to crop to it is a `label-crop` in `boundaryMode: "upstream"` wired
directly after this node - it crops that rectangle as-is (see *Cropping
the rectangle a line-finder found*). To have label-crop re-measure the
edges itself instead, **Copy as label-crop edgeRegions** (enabled once all four exist)
puts the four tuned regions on the clipboard - box, angle, polarity, edge
select and the shared tuning, the scan direction left for label-crop to
imply from the side - as the JSON `label-crop`'s
`boundaryMode: "calipers"` pastes into its *Edge regions* field. That
mode runs the same four searches and intersects the fitted lines into the
label's corners. On the Inspection
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
of the `zxing-cpp` engine — multi-symbol detection, rotation tolerance and
DataMatrix support.

### Why regions

Scanning a whole multi-megapixel photo costs on the order of a second,
almost all of it the detector's own search over the full frame. On a fixed
rig barcodes land in roughly the same place shot to shot, so telling the
node where to look turns that into a handful of single-digit-millisecond
crops: measured ~2–15ms per region against ~1.4s for the same image
scanned whole, on a 4096×5500 photo.

Mode **"Regions, then full image if nothing found"** (the default) keeps
the whole-image scan as a safety net — a repositioned label, a mis-measured
region — without paying for it on every normal run. `"Regions only"` and
`"Full image only"` are also available.

### Regions from the golden's profile

Hand-measured regions have to be measured for every product and again
whenever the camera moves. With **Regions from** = *the golden's profile*
(`regionSource: "profile"`) nobody measures them. `golden-compare`, with
**Profiles** and **Barcode regions** set, keeps two things in each
golden's profile: the trained transform (where the artwork sits in the
frame it inspects) and the barcodes it found on the artwork. This node
reads both and maps each barcode's box from the artwork into the image
it is given. A new product needs no new regions; a moved camera needs
only the transform retrained.

**Which profile**, first match wins:

1. `msg.result.profile.path` — what `golden-compare` resolved, when it ran
   upstream.
2. `msg.profile` — a profile *name* (never a path), looked up in this
   node's **Profile dir** (`profileDir`). Without a **Profile dir** it is
   warned once and ignored.
3. **Profile file** (`profilePath`) — one fixed file, for a single-product
   rig.

`msg.regions` overrides all of it. With nothing resolvable the node warns
once and has no regions; in the default mode the full-image fallback
still runs.

**Two wirings:**

```text
A: golden-compare → change: msg.payload = the native camera frame → barcode-locate   (takes msg.result.profile.path)
B: change: msg.profile = "demo_good_60", on the native frame → barcode-locate         (Profile dir = golden-compare's)
```

**Decode the native camera frame, not the frame the compare saw.** Measured
on the demo rig, 149 photos, 2026-10-08: the derived boxes, mapped through
the trained transform, land on both Code128 symbols in **149/149**.
Decoding only those regions on the native 3000x3700 frame reads the
artwork's exact text in **149/149** with 0 wrong reads, **152 ms** median
against **385 ms** for the whole frame. On the halved rectified 1500x1850
frame `golden-compare` sees (~2.3 px/module) only **23/149** read both
codes, and one returned a confidently wrong string. That is why wiring A
puts the native frame back on `msg.payload`. The node warns, once per
profile version, when the payload is no wider than the frame the compare
received (`transform.frameNativeWidth`) or, with a calibration, narrower
than the calibration photo; it maps the regions anyway. The warning says
so itself: when `golden-compare` already inspects the native camera frame,
it is expected.

**`regionPad` (0.2) and `regionPadMinPx` (64).** Each box grows on every
side by `max(regionPad × its longer edge, regionPadMinPx)`, in golden
working px, so the pad scales with the artwork like the box does. The
proportional part covers the code's quiet zone. The floor covers the
part moving, which a proportional pad cannot: a 50 px DataMatrix would
get 10 px while the compare passes parts 64 px off nominal. Set
`regionPadMinPx` to at least the compare's larger position tolerance
(`positionToleranceYPx`) plus its register slack.

**Calibration (`scaleFilePath`): set it if and only if the payload has
not been through `perspective-rectify` but the compare's frame had.** The
node then takes the regions back through the inverse of the rectification
homography, rescaled to the payload. A rectified payload with a
calibration set is un-rectified twice; the node warns once when
`msg.rectify.applied` and the payload is the size `perspective-rectify`
wrote. A calibration that is missing, unreadable, without a homography,
or of another aspect ratio (more than 0.5% off) gives one warning and no
regions.

**Guards.** Each is warned once per profile path and kind, and the ones
that read the profile also per file version — a profile fixed and then
broken again (its mtime or size changed) is warned again; the
rectified-twice warning below is once per profile path — and none fails
the message; "no regions" still leaves the full-image fallback in the
default mode:

- the profile is missing or unreadable, or has no `barcodes` or no
  `transform` section — no regions. A path that cannot even be stat'ed
  (EACCES, EPERM, a bad path a flow built) is the same: one warning, no
  regions, never an error;
- the `barcodes` section and the `transform` were made from different
  golden content ("holds barcodes of one golden and a transform of
  another; retrain or re-derive") — no regions;
- `msg.result.profile.contentKey` is present and differs from the content
  key of the profile's `barcodes` section — no regions. The section's own
  key, not the file's `golden.contentKey`: every section write updates the
  golden record, so after nuisance training for a revised artwork the file
  names the new artwork while its barcodes are still the old one's;
- the transform has no `frameWidth`/`frameHeight`/`frameNativeWidth`/
  `frameNativeHeight`, i.e. it was trained before this version — no
  regions, "retrain the transform with this version";
- the transform has no `placement` — regions placed as if the part sat
  centred, with a warning; a wide margin with an off-centre part puts them
  off by up to that margin;
- the payload's aspect ratio differs from the compare's frame by more
  than 1% (a crop, or another camera) — warning, mapping proceeds;
- the native-resolution and rectified-twice warnings above.

**What it costs.** Mapped regions are cached per profile path and its
mtime and size, payload size, calibration and its mtime and size, and
pad. A message costs one `fs.stat` of the profile (plus one of the
calibration when set) and a header read of the payload for its size, 1–3
ms, none for raw pixels. In **Full image only** the profile is not read.

### Input

`msg.payload` — a Buffer/Uint8Array/ArrayBuffer, a file path string, or an
object with `data`/`buffer`/`path`; or bare pixels, as
`{ data, width, height, channels }` or bytes plus `msg.rawInfo`, by the
same rules as `golden-compare`. Optional per-message overrides:
`msg.regions`, `msg.mode`, `msg.profile` (a profile name).

### Output

One message per barcode found, in the order regions were scanned (then the
full-image fallback, if it ran): `msg.text`, `msg.format`, `msg.roi`,
`msg.symbol`, `msg.regionLabel`, `msg.regionSource`, `msg.source`
(`"region"` or `"fullImage"`), `msg.expectedText`, `msg.textMatches`,
`msg.barcodeIndex`, `msg.barcodeCount`, `msg.decodeMs`, `msg.timings`,
and `msg.payload` set to a preview crop of that barcode's region. If
nothing is found at all, one message with `msg.text = null`,
`msg.barcodeCount = 0`, and `symbol`, `expectedText` and `textMatches`
`null`.

- `msg.roi` is the region the code was searched in; `msg.symbol` is the
  code's own box, from zxing's corner points, in full-image px.
- `msg.regionSource` — where the regions came from: `"list"`,
  `"profile"` or `"msg"`.
- `msg.expectedText` — with profile regions, the artwork's text for the
  code at that place, else `null`. The candidates are the profile regions
  that contain the symbol's centre (a full-image find counts too); none →
  `null`. Among them the node takes one whose text equals the decoded
  text, else the one of the same format whose centre is nearest the
  symbol's, else the nearest of any format. Two adjacent tall codes padded
  at 0.2 overlap, so a symbol's centre can sit inside both regions; taking
  the first region flagged good reads as mismatches. `msg.textMatches` is
  `msg.text === msg.expectedText`, `null` when there is nothing to compare.
  A mismatch is also warned, once per profile and (expected, read) pair,
  so a different wrong read is reported again.
- **One code is reported once.** A code read through two overlapping
  regions — padded regions around codes that sit close together, or
  hand-drawn ones that overlap — comes back once, under the first region's
  label: same text, same format and symbol boxes that touch at all. zxing's
  box for a linear code covers only the rows that decoded, so the same
  code read through two regions can give boxes of different heights, which
  is why the test is "touch" and not an overlap ratio. This applies to the
  configured list too, so a flow with overlapping regions can see
  `msg.barcodeCount` drop.

### Notes

- **EAN-8 is off by default.** It is short enough that ZXing
  implementations have a real chance of matching noise in a barcode-free
  crop as a confident *wrong* result, which is worse than "not found".
  Enable it only where an EAN-8 code is actually expected.
- **`tryHarder` and `tryRotate`** are both on by default and both matter
  for recall — see the in-editor help.
- The first decode after a redeploy pays zxing-wasm's one-time WASM warmup.
  `lib/locate.js` absorbs that so it never lands on a user-visible message.
- **It works offline.** zxing-wasm 3.1.3, left to itself, downloads its
  `.wasm` from the jsdelivr CDN on the first decode of every process; on a
  rig without internet that decode aborts ("both async and sync fetching
  of the wasm failed"), so the first barcode-locate after every Node-RED
  restart failed. The node now loads the binary shipped inside the
  package and never touches the network.

## Notes

- `goldenPath`/`scaleFilePath` are paths **inside the container** — use
  `/data` for anything that should survive a rebuild.
- The working canvas the frame is decoded onto is sized by the calibrated
  mm/px if there is one, and otherwise by the same-rig assumption (one
  native pixel spans the same distance in both images). That sizing does
  not have to be *right*, because the magnification search absorbs the
  error. The two are not substitutes, though: the search recovers whatever
  scale it needs to compare the images, while calibration is what tells
  you a pixel's worth in millimetres. Only the latter makes the position
  numbers physical, so calibrate if the position tolerance is specified
  in mm.
- What survives on a good part, once the geometry is right, is genuine
  artwork-versus-print difference rather than misalignment: dot gain and
  focus shift stroke weight slightly. Most of it is threshold-straddling
  rather than real, which is what `inkMargin` is for (above); widen
  `printTolerance`/`backgroundTolerance` for whatever is left, rather than
  loosening the alignment.
- **The global transform places the label; it cannot place all of it.** A
  label on a formed tray is not a plane, so after a correct global fit
  individual regions still sit 4–5px out (ARCHITECTURE.md, "Local
  refinement", has the measurements). **Refine alignment per tile**
  (`localAlign`, on by default) lets each tile take up its own offset,
  capped at `localAlignMax` (3px) so a tile can never slide far enough to
  hide a fault, and skipping tiles too flat to localise.

  Its value shows up as **headroom**, not as a lower defect ratio: on the
  demo pair, `printTolerance`/`backgroundTolerance` of 2/1 fails the clean
  part without refinement (a false region at density 0.250) and passes it
  with (zero regions), while the marked capture still fails either way.
  That is why the tolerance defaults are 2/1 rather than the 5/3 they had
  to be before. **If you turn `localAlign` off, widen them again**, or the
  registration error it was absorbing will fail good parts. Look at the
  `targetFgAligned` stage against `goldenFg` to see the difference
  directly: body text goes from doubled to solid.
- **Train the transform once instead of re-deriving it every frame.**
  Magnification and press stretch come from the camera's standoff and the
  press's pull on the media and do not change between parts; translation
  and rotation are where this part happens to be sitting. Tick **Train the
  transform** with a **Trained transform** path set (or send
  `msg.trainTransform`), and the node measures `scaleX`/`scaleY` from that
  frame, writes them down, and pins them on every later frame — solving
  only position and angle. The same frame also measures how far off
  register it still sits after the local alignment, tile by tile, and
  the record carries the slack the tone and speck checks take from it:
  `registerSlackPx` for the worst tile and `register.slack` per tile,
  both rounded up to 2, 3, 4, 5, 6, 8, 10, 12 or 16 px. A training frame
  that registers poorly or finds no label trains nothing and leaves the
  record as it was.
  One frame is not the rig: consecutive training frames merge, the
  worst each tile saw - the frames after the run's first well-registered
  one measured against its scale, as later frames will be - so leave the
  box ticked for a handful
  of good parts that sit on the tray the way parts do, then untick it (a
  frame that is not training ends the run). With the checks' **from
  training** box ticked, later frames run with that slack;
  `msg.result.toneBlemish.marginTrained` says whether they did. To train from any two
  images rather than the configured golden, send `msg.golden` alongside
  `msg.payload`.

  It roughly halves the time (2.0–2.7x on this project's captures), but
  the reason to do it is accuracy: a search free to re-solve magnification
  per frame can pick wrong, and it is likeliest to do so on a badly
  printed label — precisely the case the inspection exists for. One such
  capture went from 945 regions to 25 once its transform was pinned.

  A trained record is tied to its golden and working size, and both are
  checked on load; a mismatch is refused with a reason rather than
  silently applied. "Its golden" means the image, not the route the image
  took: the record stores a hash of the golden's bytes alongside the
  cheap cache key, so training through `msg.golden` and then producing
  frames from the configured **Golden image path** reuses the record.
  Records trained before 1.1.1 have no content hash; retrain once. Scales
  outside a sane physical range (0.05–100) or an unreadable file are
  refused the same way — the node searches unpinned rather than applying
  nonsense. But the **stretch belongs to the print run, not to the
  golden**, so a new run on the same artwork needs retraining and no file
  check can see that coming — on this project's own samples two captures
  from a different run want 5.9% where the rest want 4.5%, and forcing
  the wrong one on them produced ~1000 false regions. What does catch it
  is the alignment residual jumping clear of what training measured, and
  the node warns when it does.

  Pinning also costs a little defect sensitivity: the polish objective is
  computed on a decimated canvas, so it cannot resolve a single full-res
  pixel of translation, and a pinned run can settle a pixel from where the
  searched run lands. On the demo capture the marked defect still fails
  the part, but as one region at density 0.156 rather than five at 0.172.
- **The coarse search can pick a wrong scale.** Its density proxy cannot
  separate a correctly scaled match from one a few percent off, and the
  symptom is a whole frame failing at roughly 0.5% residual scale error:
  about 10px of drift across the label, which on 1-2px strokes is total
  disagreement, so hundreds of regions light up on a part whose real
  faults are two small blemishes. `alignCandidates` (default 5) keeps that
  many scale hypotheses alive through the fine stage and picks between
  them on **real pixel disagreement** rather than the proxy. On this
  project's samples one capture went from 315 regions to 10 with no change
  to any pair that was already aligning. Set it to 1 for greedy behaviour.
- **`workingSize` decides what defects are physically detectable, and it
  is the setting to reach for first when something real is being missed.**
  It is not merely a speed/quality dial: downscaling averages a thin mark
  into the substrate around it. A ~4px pen line on a 4096×5500 capture
  measures grey 20 (black) at `workingSize` 3072, but grey **120 against
  a threshold of 143** at 1024 — three quarters of the way to invisible.
  No downstream setting recovers that; the evidence is gone before the
  threshold runs. Symptom to recognise: the defect shows up in the raw
  `backgroundDefect` debug stage as a scatter of specks rather than a
  stroke.
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
  or `msg.goldenKey`), a setting baked into the prepared golden
  (`workingSize`, `threshold`, `thresholdMode`, `sauvolaRadius`,
  `sauvolaK`, `inkMargin`, `backgroundTolerance`, `debugStages`,
  `heatmapFormat`, `heatmapQuality`), the calibrated scale (including the
  calibration photo's native resolution), or raw geometry changes —
  `printTolerance`/`alignSearch`/etc. are applied fresh per frame and
  don't need a re-decode.
- `sharp` ships prebuilt binaries for Alpine/musl, so no libvips
  source-compile is needed in this project's Docker build stage.

## Tests

`npm test` (Node 18+, no test framework needed — `node --test`), 702
tests. Fixtures are generated with `sharp` rather than read from
`data/sample_images`, so the suite runs anywhere; the real QC photos are
gitignored. Coverage spans the lib pipeline (`compare`, `align`, `warp`,
`localAlign`, `checkerboard`, `threshold`), the worker pool (byte-identity
against serial, mid-flight termination, oversized pools, and two
overlapping dispatches), and the Node-RED glue itself —
`golden-compare.js`, `checkerboard-calibrate.js` and
`perspective-rectify.js` are exercised through a fake-RED harness
(`test/glue.test.js`, `test/checkerboardCalibrate.test.js`,
`test/perspectiveRectify.test.js`) so image resolution, cache
invalidation, `msg.rawInfo` handling and calibration files are tested
without a running Node-RED. `test/homography.test.js` checks the
perspective fit against transforms with known answers, and the
checkerboard suite keystones a synthetic board, measures it, rectifies
it with the measurement, and measures it again.

Several suites assert something other than a value:

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
- `test/editorRegionGeometry.test.js` lifts the region geometry, the Run
  button maths and the region-list maths (rectangle layout, the label-crop
  JSON) out of `line-finder.html` and runs them against
  `lib/lineFinder.js`. The editor
  needs its own copy to draw what the runtime will scan, and two copies
  of a rotation convention drift silently — the box drawn stops being the
  box searched. `test/lineFinderEditor.test.js` drives the viewer itself
  over a small fake DOM.
- `test/nativeKernels.test.js` holds each native kernel to its JS twin
  byte for byte on synthetic dispatches, fixed and fuzzed
  (`VISION_TOOLS_FUZZ_ROUNDS`, default 40 a kernel), and
  `test/nativePipeline.test.js` runs whole frames with each set. Both
  were checked against deliberately broken builds (ties rounded away from
  zero, a margin off by one, a strict threshold, a late tie kept, FMA
  contraction on) and fail on each; they skip where no binary loads.
  `test/nativeKernelsLoader.test.js` covers what happens when it does not
  load.
- `test/lineFinderSampling.test.js` compares the two profile builders
  with `strictEqual` rather than a tolerance. The fast one exists only
  for speed, so the only acceptable difference is none.

`bench/frame-bench.js` is a stopwatch rather than a test and is not picked
up by `node --test`. Pass `--pin mx,my` when comparing two versions:
without it each version pins to the magnification it recovered itself, and
the two are then not solving the same problem.

## Development scripts

`scripts/` is not published (`package.json` `files` is a whitelist).

- `npm run dev:push [-- files...]` - copy changed package files into the
  local Node-RED container built from `../NodeRed-Test`, restart it, and
  report each node type's load status. `--no-restart`, `--dry-run`.
- `npm run deploy:vendor [-- --build]` - pack this checkout into
  `../NodeRed-Test/vendor`, repoint that project at it, refresh its
  lockfile and Dockerfile note; `--build` rebuilds and restarts the image.
- `npm run test:count` - run the suite and rewrite the count quoted under
  [Tests](#tests); non-zero when anything fails.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

`sharp`, `zxing-wasm` and the optional OpenCV engines are separate
packages under their own licences.
