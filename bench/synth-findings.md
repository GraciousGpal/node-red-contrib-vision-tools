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

## Update, 2026-10-06: a fixed rig, a pin, and the missing-ink gate

The set above re-rolled magnification per frame. A camera on a stand
does not, and `golden-compare` on a line pins magnification and stretch
with its trained transform - so the search's per-frame misses were being
booked as the blemish checks' false fails. `generate.js --rig` (the
default now) shoots one magnification and stretch per set, and `run.js
--train` (default on a rig set) pins to what the full search finds on one
clean frame. Then the first miss mechanism above got its structural fix:
`printMissingFraction`, a print block that lost at least that fraction of
the ink the golden has *in that block* fails, however small a share of
the block's area that ink was.

87 frames, seed 1, per-variant 1, typical, `workingSize` 2100, measured
in that order:

| configuration | recall | clean false fails |
| --- | ---: | ---: |
| rig set, unpinned, old verdict | 44.4% | 7 / 24 |
| pinned, old verdict | 36.5% | 0 / 24 |
| pinned, `printMissingFraction` 0.3 | 61.9% | 2 / 24 |
| pinned, `printMissingFraction` 0.5 | 50.8% | 2 / 24 |
| pinned, `printMissingFraction` 0.7 | 49.2% | 1 / 24 |
| pinned, 0.5, `failThreshold` 0.2 | 58.7% | 2 / 24 |
| pinned, 0.5, `failThreshold` 0.1 | 61.9% | 2 / 24 |

Pinning alone drops recall. The five detections it loses were the search
misregistering a defective frame and the residue, not the defect, tipping
a block - four of them were already `wrong-place`. Those were never
detections.

Per variant, pinned, `printMissingFraction` 0.5 and `failThreshold` 0.1
against pinned and the old verdict: `misprint/dropout` 25% → 100%,
`misprint/streak` 0% → 75%, `overprint/bleed` 33% → 100%,
`overprint/ghost` 50% → 100%, `scratch/dark` 0% → 75%, `misprint/void`
50% → 75%, `mark/spatter` 50% → 75%, `random/fold` 50% → 75%. Unmoved:
`misprint/faded` 0%, `scratch/light` 0%, `mark/smudge` 25%,
`random/void-spots` 0%, `random/dust` 25% - the tone and sub-4px
mechanisms, as predicted.

The two clean false fails are both the missing-ink gate on thin strokes:
a `harsh`-preset clean frame whose 1px hairlines blur and binarize away
(a thresholding limit, not a gate limit - `clean-rig` and `typical`
frames do not do this), and one `typical` frame with a single 16x16 block
at the gate's 6% ink floor. 0.7 clears the second at a cost of two
points of recall; 0.3 clears nothing more and gains eleven. The package
default is 0.5; the example flow runs the sweep's `failThreshold` 0.1.

## Update, 2026-10-06, later: the tone check

(The model described here was replaced the same day; the final one, and
why, is in the "last" section below. The numbers stand - the synthetic
label has no mid-grey, so both models score it the same.)

The second mechanism - both channels binary at the ink level - got its
fix: `toneThreshold`, a third check on the aligned grey. Each pixel is
measured against the paper and ink levels of its own 128 px cell (the
80th and 20th percentiles, so lighting cancels and a defect has to cover
most of a cell to move the level it is judged by), as a fraction of the
span between them; a paper pixel that far toward ink, or an ink pixel
that far toward paper, is a tone defect, through the same block stage.
The `toneMargin` px either side of an ink edge and the outer 8 px of the
canvas are left out - blur, sub-pixel registration and the warp's fill
put legitimate grey there, and the first version booked a 4 px strip of
tray along the bottom row as a tone region.

Same rig set, pinned, `printMissingFraction` 0.5:

| configuration | recall | clean false fails |
| --- | ---: | ---: |
| `failThreshold` 0.3, tone off | 50.8% | 2 / 24 |
| `failThreshold` 0.3, tone 0.25 | 61.9% | 2 / 24 |
| `failThreshold` 0.3, tone 0.3 | 60.3% | 2 / 24 |
| `failThreshold` 0.3, tone 0.4 | 55.6% | 2 / 24 |
| `failThreshold` 0.1, tone off | 61.9% | 2 / 24 |
| `failThreshold` 0.1, tone 0.3 (the example flow) | 74.6% | 2 / 24 |

No wrong-place verdicts at either setting with tone 0.3. The two false
fails are the same two print-channel frames as before; the tone check
adds none. The three variants it was built for go `mark/smudge` 25% →
100%, `misprint/faded` 0% → 100%, `overprint/ghost` 50% → 100%;
`random/fold` 50% → 100%. 0.25 scores a point higher at the package
default but sits closer to the synthetic set's own "none" floor (a
change under 64 of 255 levels, 0.25 of the span), so the default is
0.3. The check costs ~43 ms a frame at `workingSize` 2100 against 26 ms
for the two binary diffs.

What is left at the example flow's settings, 16 of 63: nine `tiny`
defects (25-60 changed pixels on a 1500x2100 label, a few pixels across
under up to 1.5 px of blur - a resolution question, not an algorithm
one), and seven small-and-up - `scratch/light` at every size, `dust`
small and medium, `void-spots` small and medium. All three are
sub-4px structure that the tolerance dilation closes; the next
mechanism to address. On small-and-up alone the set is at 39 of 46,
84.8%.

## Update, 2026-10-06, later still: specks, and the tolerances ruled out

First the obvious route, measured: could the dilation tolerances just
come down? Same rig set, pinned, tone 0.3, `failThreshold` 0.1:

| setting | recall | clean false fails |
| --- | ---: | ---: |
| `printTolerance` 2 (default) | 74.6% | 2 / 24 |
| `printTolerance` 1 | 77.8% | 3 / 24 |
| `printTolerance` 0 | 82.5% | 23 / 24 |
| `backgroundTolerance` 0 | 76.2% | 24 / 24 |

No. Below a pixel of tolerance the registration residue along every
stroke fails every clean frame, which is what the tolerance was for.

So the third mechanism - anything under ~4 px closed by the dilation -
got its own check. Dust and pinholes are one to three px each, 40 to
2400 of them; no block ever gets dense and, after the blur, not enough
of them are at ink level for the ratio. What they have is number.
`speckThreshold` takes the tone deviation (so the same edge band and
border are out) as pixel-level connected components of at least
`speckMinArea` px and fails the part at `speckMaxCount` of them, or on
one speck of `speckMaxArea` px - a single spatter no block gate sees.

| configuration | recall | clean false fails |
| --- | ---: | ---: |
| `failThreshold` 0.1, specks off | 74.6% | 2 / 24 |
| `failThreshold` 0.1, specks 0.3, count 8, area 48 (the example flow) | 85.7% | 2 / 24 |
| …count 4 | 87.3% | 2 / 24 |
| …count 16 | 84.1% | 2 / 24 |
| …threshold 0.25 | 85.7% | 3 / 24 |
| …threshold 0.4 | 85.7% | 2 / 24 |
| package defaults (`failThreshold` 0.3), specks on | 82.5% | 2 / 24 |

No wrong-place verdicts anywhere; the two false fails are the same two
print-channel frames as every run before. `random/dust` 25% → 100%,
`random/void-spots` 25% → 100%, `scratch/dark` 75% → 100%. Count 4
scores higher here but is a bet on how clean a real line's paper is;
the default is 8. The check costs ~10 ms a frame at `workingSize`
2100.

What is left at the example flow's settings, 9 of 63: six `tiny`
defects, and `scratch/light` at every size. A light scratch removes ink
only where it crosses type - 10 to 220 changed pixels in total, as 2-4
px gaps in 1-3 px strokes - and every gap sits inside the edge band
both grey checks leave out and inside the dilation the print check
applies. It is the last of the five mechanisms, and the only one left
that is not a resolution question: it needs a line detector across the
strokes, which nothing here is yet. On small-and-up alone the set is
at 43 of 46, 93.5%.

## Update, 2026-10-06, last: the real artwork

Everything above was measured on the synthetic label, which is pure
black on white. The same set generated from the line's real artwork
(`--golden`, a 2173x1498 PDF render; the file stays out of the repo)
found two things the synthetic label cannot show, both in the tone
check, both on every clean frame:

- The artwork has mid-grey panels with white type. The golden's Otsu
  level calls them paper; the frame's threshold calls them ink. The
  binary checks are shielded from that on the line by `inkMargin` 64,
  which withholds pixels near the level from both channels - the
  bench's default 8 fails every clean frame on background, so a real
  artwork is benched with the production node's settings
  (`inkMargin` 64, `blockSize` 8, `failThreshold` 0.5).
- The tone check's first model measured every pixel against a single
  paper level per cell, so a grey panel read as 0.5 of the span from
  paper and failed whole. It now measures against the artwork's own
  grey at that pixel, mapped between the cell's paper and ink levels -
  and those levels are sampled only where the golden is pure paper or
  pure ink, because sampling the panel as paper made it its own cell's
  paper level and the panel's white type then measured wrong against
  it. Second lesson: a new check is not finished until the real
  artwork has been through it.

Real artwork, 87 frames (65 expected to fail), pinned, native size:

| configuration | recall | clean false fails |
| --- | ---: | ---: |
| production settings, `speckMinArea` 2 | 86.2% | 1 / 22 |
| production settings, `speckMinArea` 3 | 86.2% | 0 / 22 |
| `failThreshold` 0.1 (the test flow), `speckMinArea` 2 | 89.2% | 1 / 22 |
| `failThreshold` 0.1, `speckMinArea` 3 | 89.2% | 0 / 22 |

The one false fail was a `harsh` clean frame reaching the speck count
on two-pixel components of JPEG and sensor noise; a three-pixel floor
clears it and costs nothing on either set, so 3 is the default. No
wrong-place verdicts. What is left on the real artwork at the test
flow's settings, 7 of 65: two `tiny`, and `misprint/void` small and
large, `misprint/faded` small, `overprint/ghost` medium and
`overprint/bleed` small - on small-and-up, 43 of 48. These are the
grey-artwork cases: a void or a bleed on a grey panel, a ghost over
one, where the span between that grey and its neighbours is a fraction
of the paper-to-ink span the checks measure in.

A `msg.heatmap` was added alongside: every check's regions on the
aligned frame in one picture, each in its own colour, with the defect
pixels filled inside. On a real-artwork smudge frame it draws the smudge
and nothing else.

A review the same evening tightened the scorer: a region now counts as a
detection only when its check *failed* - a passing speck or a tone block
under the gate on the defect no longer does. Every table above was
re-scored under that rule and under the final tone model and did not
move. The review also found the tone check silently off on any golden
without a pixel at 255 (cream paper, a photographed golden); its levels
now come from the golden's own ink and paper medians, and a golden it
cannot measure leaves the check off with a reason rather than a pass.

## How to repeat

```
node bench/synth/generate.js --out C:/tmp/set --seed 1 --per-variant 2
node bench/synth/run.js C:/tmp/set --working 2100
node bench/synth/run.js C:/tmp/set --working 2100 --sweep failThreshold=0.3,0.2,0.1
node bench/synth/run.js C:/tmp/set --working 2100 --filter "clean|stain"
node bench/synth/run.js C:/tmp/set --working 2100 --train false        # the unpinned search
node bench/synth/run.js C:/tmp/set --working 2100 --sweep printMissingFraction=0,0.3,0.5,0.7
node bench/synth/generate.js --out C:/tmp/free --rig false              # the pre-2026-10-06 set
```

`--golden path/to/artwork.png` runs the same set on a real label without
the file entering the repository. Heat maps are off in the runner; to look
at one frame, run `compareFrame` on it with `outputPrintHeatmap` and
`outputBackgroundHeatmap` on and write the two buffers out - that is how
the residual in the first section was seen to sit on strokes.
