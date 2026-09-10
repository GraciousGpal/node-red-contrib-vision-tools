# Golden-compare: NodeRed-Test container benchmark

## Result

The safe code-only optimization reduces median comparison latency **110.6 → 96.2 ms (13%)**, with **identical complete result objects on all 162 images**. It replaces full-image integral tables with direct counts over the non-overlapping defect blocks in `lib/compare.js`.

- Defect grid/region stage: **22.5 → 8.7 ms median** (61% reduction).
- Eliminates **25,103,808 bytes of temporary table allocation per frame** at this golden's resolution. This is allocation avoided, not a measured RSS reduction.
- No changes to alignment, resolution, thresholds, tolerance, region ordering or verdict policy.
- Native remains the fastest tested engine. The Wasm implementation is not an equivalent drop-in in numerical results.
- **No deployment, restart, training-file modification or live-flow change was performed.** Existing unrelated working-tree edits were retained.

## Environment and method

Container: `nodered-test-node-red-1`, image `node-red-custom:local`, Linux x64, Node v24.16.0, 16 available CPUs. No Docker CPU/memory limit was configured. The existing Node-RED process remained running, so these are shared-host measurements, not isolated laboratory timing.

`bench/golden-container-bench.js` invokes the actual `golden-compare.js` input handler through a small RED adapter. The actual inspector worker and worker pool perform the inspection. It reads the container's saved `/data/flows.json`, not the different host copy in NodeRed-Test.

Inputs reproduce the saved comparison tab:

- `Demo_Good_60.pdf`, first page, 400 dpi, RAW, rotation 270, then the native 0.5x resize.
- Resulting golden: **1475 × 2125 × 4**, SHA-256 `cfafbcb1a7d93658d83b8254084b9b84f71ef2c44c301e68c8b85dd3e9c35d3f`.
- Camera files from `/data/Inspection/sample_images/{good,bad}`, decoded to raw RGB and resized 0.5x through the native bridge.
- **148 good-folder images and 14 bad-folder images**.
- Sequential inputs, no overlapping comparisons; first comparison and an additional warmup excluded from timing. Full-set runs measured each image once; the initial 10-image sweeps measured each image three times.

Times cover the node handler, golden fingerprint/cache checks, frame handoff, inspection and result plumbing. They **exclude** file loading, PDF rendering, upstream decode/resize, real Node-RED wire cloning, downstream nodes and queueing. Reciprocal median latency is not a measured sustained production throughput.

## Full-set measurements

All rows use native OpenCV and unchanged inspection thresholds. Quantiles reflect the actual 148:14 class mix; rare fallback cases appear in p99/max rather than p95.

| Variant | Median | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Installed baseline: 12 workers, unnamed golden, workingSize 2125 | 110.6 ms | 153.7 ms | 1265.3 ms | 1583.2 ms |
| Direct block counting, same settings | **96.2 ms** | **134.3 ms** | 1500.3 ms | 1707.0 ms |
| Direct counting + 16 workers + named golden + valid saved training size | **94.6 ms** | 138.4 ms | **582.2 ms** | **696.3 ms** |

The code-only change improves the common path, **not** the unpinned-search tail; its p99/max were worse in this one-pass run. The combined configuration improves that tail but is not a controlled measurement of any single setting, and 16 workers did not materially improve normal-frame latency over 12.

### Training mismatch

The live node requests workingSize **2125**, while `/data/golden/transform.json` was trained at **2656**. The existing guard correctly refuses that record, so failed native solves pay an unpinned JS scale/stretch search.

The third row restores **2656 in the isolated test configuration**, allowing the unchanged saved record to pass its identity checks. The golden remains 1475×2125 because it is never upscaled. All 162 graded verdicts remained unchanged, but some fallback transforms/results changed, as expected when pinning scale.

For deployment, retrain against a known-good frame at the intended settings, or deliberately restore the original trained configuration. **Do not edit the record's workingSize field or bypass its identity checks.** Restoring 2656 also produces the existing informational warning that the golden is smaller than workingSize.

### Worker/cache sweep and Wasm

First five good + first five bad images, three measured iterations per image:

| Workers | Unnamed golden median | Named golden median |
| ---: | ---: | ---: |
| 1 | 235.9 ms | 212.8 ms |
| 2 | 161.0 ms | 147.3 ms |
| 4 | 117.3 ms | 118.4 ms |
| 8 | 110.3 ms | 105.0 ms |
| 12 | 118.6 ms | **100.7 ms** |
| 16 | 110.2 ms | 104.2 ms |

All 12 variants returned identical result objects on the 10 fixtures. Timing noise and fixed run order mean the cache differences are not solely attributable to hashing. Naming a stable golden avoids hashing its ~12.5 MB on every frame; the flow must change the key when the golden changes. The saved flow creates a key during PDF rendering but does not retain/forward it with the golden through the later gate.

At 12 workers with a named golden, the isolated Wasm-backed source snapshot measured **456.1 ms median / 1566.1 ms p95**, versus native **100.7 / 1102.5 ms**. Both classified this sample identically, but their transforms and native/fallback paths differ. This is a comparison of these two implementations, **not proof that Wasm itself has a universal 4.5× penalty**. Wasm was staged under `/tmp`; it was not installed into the live runtime.

## Accuracy finding — not fixed by speeding up counting (since FIXED, see below)

All variants accept all 148 good-folder images and reject **12/14** bad-folder images. These two bad-folder images are accepted by both the original and optimized node, including the downstream `grade === "good"` check:

- `image_20260907_095106-749Z.jpg`
- `image_20260907_095138-803Z.jpg`

These need a separate defect/ground-truth investigation before treating the current settings as production-validated. No thresholds were relaxed to improve performance. The full-set parity assertion compared the entire `msg.result` object, not just pass/fail, for the code-only change; the pinned configuration was checked for verdict parity separately.

## Verification and reproduction

- Container suite: `node --test --test-concurrency=2`: **325 passed, 0 failed, 2 skipped** (engine-absent cases skipped because the engine was present).
- `test/heatmapGrid.test.js`: densities exactly match the previous integral implementation for empty/full/pattern masks, clipped blocks, block sizes 4–256 and dimensions through 1475×2125. Passed before and after the replacement.
- Primary LSP diagnostics and syntax checks passed for the changed code and benchmark/test files.
- Local raw evidence: `.pi/golden-bench/{baseline,wasm,pin,full-baseline,full-code,full-tuned}.json`. These include local fixture paths/results; no image bytes are included.

Copy the harness into the container, then run from PowerShell/cmd (the test does not install packages):

```text
docker cp bench/golden-container-bench.js nodered-test-node-red-1:/tmp/golden-container-bench.js
docker exec -e NODE_PATH=/usr/src/node-red/node_modules -e VISION_BENCH_ROOT=/usr/src/node-red/node_modules/@graciousstar/node-red-contrib-vision-tools nodered-test-node-red-1 node /tmp/golden-container-bench.js --workers 12 --named 0 --iterations 1 --limit 0 --out /tmp/golden-full-baseline.json
```

For an isolated source snapshot, set `VISION_BENCH_ROOT` to its directory. Use `--named 1`, `--workers 16`, and `--working 2656` to reproduce the combined configuration; `--limit 5 --iterations 3` reproduces the sample sweep. In Git Bash, prefix Docker commands with `MSYS_NO_PATHCONV=1` to avoid rewriting container paths.

The safe next deployment is the small `lib/compare.js` change. Keep raw input, local alignment and diagnostics-off settings; retain 12 workers unless reject-heavy testing justifies 16. Correct training and carry a stable golden key for additional gains. Removing upstream repeated golden resizing could help whole-flow latency, but that cost was not measured here. These results establish improvements, not a claim of absolute maximum possible performance.


## Update: the two false accepts are fixed

Both images were being accepted because the background blemish floor is set
by fixed-location registration artifacts, not by random noise — an 8px strip
at (112, 168) reaches density 0.25 in 78 of the 148 good frames. No aggregate
metric separated the classes; the good frames scored worse than the two
defective ones on all of them.

`lib/nuisanceMap.js` trains a per-block baseline from known-good frames and
scores blocks by excess over their own history rather than by magnitude.
Re-running this same 162-image set end to end through the real handler:
**0 of 148 good rejected, 0 of 14 bad accepted.**

Held out (each good frame scored against a map trained without it): worst
good frame 0.2500 at 74 training frames, 0.2655 at 37; the two defects score
0.3281 and 0.3906. Default gate is 0.30.

Reproduce with `bench/nuisance-e2e.js --holdout 2` (trains through the node,
then re-inspects everything) or `bench/nuisance-validate.js` (library-level,
two-way split). Both need the container's flow and fixtures.
