# golden-compare on synthetic defects: first findings

What `bench/synth/` found on its first runs, what was changed because of
it, and what it says the node cannot see yet. Numbers are from one set
and one label style, on this laptop; they are for ranking causes and
choosing what to change, not for quoting as the node's accuracy.

## The set

`node bench/synth/generate.js --out set --seed 1 --per-variant 2`, then
`node bench/synth/run.js set --working 2100`: the default synthetic label
at 1500×2100, 170 frames - 136 with one defect each across 17 variants and
four sizes, 34 expected to pass (26 clean, 8 `stain` frames whose change
is under the 64-level floor) - under the `typical` capture preset with
two clean frames each at `clean-rig` and `harsh`. `--working 2100` keeps
the golden at native size, as a rig whose `workingSize` is at or above
the artwork does; the 1024 default resamples the 1-3px strokes and hides
one of the findings below. Frames ran with no trained transform, so the
full scale/stretch/angle search is what is measured; the rig pins scale
from a trained transform and is not affected by the ladder finding.

## What changed because of it

1. **Two-level artwork had no ink** (`lib/threshold.js`). Otsu's
   between-class variance is identical at every level between the modes
   of a histogram with an empty gap, and the first won: level 0, an empty
   golden, zero print defect on every frame, a background region the size
   of the tray, a position hundreds of pixels out. A smaller `workingSize`
   resamples greys into the gap, which is why PDF renders on the rig never
   showed it. Now the midpoint of the plateau.

2. **Position was measured at the corner** (`lib/compare.js`). A label
   rotated about its centre moves its top-left corner by about half its
   height times sin(theta): 12-14px at 0.7° on a 2100px label, against a
   16px tolerance. Three of 34 clean frames failed on position for that
   alone. Now measured at the centre; identical at zero rotation.

3. **The scale ladder was too coarse** (`scaleSearchSteps` 19 → 37). Over
   0.6-2.5 that is a 4% rung instead of 8%. On the 34 clean frames:

   | setting | pass | grade good | mean scale error | mean angle error | p50 |
   | --- | ---: | ---: | ---: | ---: | ---: |
   | 19 rungs | 19 | 8 | 0.31% | 0.043° | 1926ms |
   | 37 rungs | 24 | 12 | 0.08% | 0.019° | 1828ms |
   | true scale pinned | 32 | 12 | 0 | 0.041° | 422ms |

   `angleSteps` 9, `alignCandidates` 10, `aspectSteps` 13 and
   `localAlignMax` 8 were each tried alone; none improved the scale error
   and `aspectSteps` made it worse. The last row is what a trained
   transform gives the rig: the search, not the diff, is where clean
   parts are lost.

   Over the whole set the ladder change reads as a loss of recall, 48% →
   39%, and it is not one. Of the 15 detections lost, 11 were on frames
   carrying 350-630 residue regions at 19 rungs, one of which covered the
   defect; at 37 the same frames carry 0-2. Those were the scorer's
   `wrong-place` rule doing its job one step late.

With all three, clean false fails are 7 of 34 (21%), from 15 (44%).

## What is left on clean frames

| cause | frames | signature |
| --- | ---: | --- |
| residual misregistration | 5 | alignment marginal (0.065-0.075), print 0.1-1.8%, background 0.4-2.3%, regions on strokes throughout |
| faint stain | 2 | a stain 15-40 levels off paper, under the ground-truth floor, crosses the frame's Otsu level after blur and lighting: background ratio 0.28-0.31% against `failRatio` 0.2%, one region at density 0.17 |

The first is the search again. Pinning the true scale leaves 2 of 34, so
on a trained rig it is the angle and translation polish; unpinned it is
the ladder's remaining 4% and a joint refine that occasionally settles
next to the optimum rather than on it.

## Recall, honestly, at the new defaults

170 frames, 37 rungs, `failThreshold` 0.3, `blockThreshold` 0.15, frames
p50 1.84s.

| family | tiny | small | medium | large | all |
| --- | ---: | ---: | ---: | ---: | ---: |
| mark | 3/6 | 2/6 | 4/6 | 4/6 | 13/24 |
| misprint | 0/8 | 2/8 | 3/8 | 3/8 | 8/32 |
| overprint | 0/8 | 3/8 | 6/8 | 6/8 | 15/32 |
| random | 3/8 | 2/8 | 5/8 | 6/8 | 16/32 |
| scratch | 0/4 | 1/4 | 0/4 | 0/4 | 1/16 |

| changed pixels | cases | detected |
| --- | ---: | ---: |
| under 50 | 11 | 0 |
| 50-150 | 18 | 1 |
| 150-400 | 25 | 10 |
| 400-1000 | 25 | 12 |
| 1000-3000 | 25 | 12 |
| 3000-10000 | 21 | 11 |
| over 10000 | 11 | 7 |

Per variant: `mark/ink` 8/8, `overprint/stroke` 6/8, `random/combo` 6/8,
`overprint/fill` 5/8, `misprint/dropout` 4/8, `random/dust` 4/8,
`random/fold` 4/8, `mark/spatter` 4/8, `misprint/void` 3/8,
`overprint/bleed` 3/8, `random/void-spots` 2/8, `mark/smudge` 1/8,
`misprint/streak` 1/8, `overprint/ghost` 1/8, `scratch/dark` 1/8,
`misprint/faded` 0/8, `scratch/light` 0/8.

## Why the misses miss

Reading the missed cases against their pixels, five mechanisms account
for nearly all of them. The first is a tuning gap; the rest are limits of
the method.

- **Thin type cannot fill a block.** A channel fails only when some block
  reaches `failThreshold` (0.3) density or the defect reaches `failRatio`
  (0.2% of the label, ~6300px here). Body type is 10-15% ink, so a dropped
  word of 2900px never reaches 0.3 in any block and never reaches the
  ratio: `misprint/dropout` medium passes with 8-13 regions on the message
  and none dense enough to fail. Sweeps at 37 rungs:

  | `failThreshold` | recall | false fails |
  | --- | ---: | ---: |
  | 0.3 | 39.0% | 10 |
  | 0.2 | 47.8% | 10 |
  | 0.1 | 52.2% | 11 |

  | `blockThreshold` | recall | false fails |
  | --- | ---: | ---: |
  | 0.15 | 39.0% | 10 |
  | 0.10 | 42.6% | 10 |
  | 0.05 | 45.6% | 10 |

  On this set `failThreshold` 0.2 is free. The defaults are not changed
  here - one label style is not a basis for a package default that every
  line inherits, and the rig already sets its own - but the better fix is
  structural: score a block's missing ink against the golden's ink in that
  block, so a block that lost 80% of its type fails whether that was 12%
  of the block or 40%.

- **Both channels are binary at the ink level.** A grey smudge (`mark/
  smudge`, level ~112 at 70% opacity: 6400-8500px, background ratio
  0.0000) and a half-tone double print (`overprint/ghost`, 46% opacity:
  5000-12000px, 0.0001) land above the frame's Otsu level and are paper.
  Nothing in the pipeline looks at tone on paper. A tone channel - grey
  difference against the golden's paper, with its own tolerance - would
  see both.

- **Anything under ~4px is closed by the tolerance dilation.** `printTolerance`
  2 and `backgroundTolerance` 1, plus the capture's blur, remove a 3px
  dead-column streak (547px, print 0.0001), pinholes in ink (16000px of
  1-3px voids, 0.0002) and 1-3px dust (4000px, 0.0005). By design: the
  dilation is what absorbs registration error, and the fix for a thinner
  floor is better registration, not a smaller tolerance.

- **Thin scratches are both.** A light scratch removes ink only where it
  crosses type, 30-100px in total; a dark one is 2-4px wide and blurs to
  grey. `scratch` is 1/16. A tone or edge channel is the only route.

- **Diffuse defects fail without a region.** Dust everywhere and pinholes
  everywhere fail on the ratio with no block over `blockThreshold`; the
  scorer calls that `wrong-place` because the node cannot point at it.
  One case. Arguably a detection; left strict.

## How to repeat

```
node bench/synth/generate.js --out C:/tmp/set --seed 1 --per-variant 2
node bench/synth/run.js C:/tmp/set --working 2100
node bench/synth/run.js C:/tmp/set --working 2100 --sweep failThreshold=0.3,0.2,0.1
node bench/synth/run.js C:/tmp/set --working 2100 --filter "clean|stain"
```

`--golden path/to/artwork.png` runs the same set on a real label without
the file entering the repository. Heat maps are off in the runner; to look
at one frame, run `compareFrame` on it with `outputPrintHeatmap` and
`outputBackgroundHeatmap` on and write the two buffers out - that is how
the residual in the first section was seen to sit on strokes.
