# @graciousstar/opencv5

A few OpenCV 5 vision ops on raw image buffers, as a prebuilt N-API addon:
colour conversion, resize, Otsu and Sobel filters, crop, rotate, and an
ORB + ECC affine alignment. Not general OpenCV bindings - the ops
[node-red-contrib-vision-tools](https://github.com/GraciousGpal/node-red-contrib-vision-tools)
needs, done well:

- **Prebuilt, no toolchain.** One binary per platform: Linux x64 (glibc
  2.17+ and musl) and Windows x64 are built and tested; Linux arm64 and
  macOS x64/arm64 come from the CI workflow, which has not run yet. No
  install script; each binary's size and SHA-256 are checked against
  `prebuilds/manifest.json` before it is opened.
- **Any CPU of its arch, the same bytes on all.** Built for the baseline
  (x86-64-v2: SSE4.2 + POPCNT; arm64: NEON) with nothing chosen at run
  time, no fast-math and no FMA contraction. `test/expected.json` pins
  every op's output bytes per arch, and each OS's binary of that arch
  must reproduce them (on x64, Linux glibc, Linux musl and Windows do).
- **Async, bounds-checked, and never sharing a buffer with a pool
  thread.** Every op runs on libuv's pool and returns a promise. Every
  argument is checked before native code touches a byte; the input is
  copied into the addon's own memory before the op is queued, and every
  reply is a new buffer, so a caller may reuse, rewrite or even transfer
  its buffers the moment a call returns. The copy costs about 1.2 ms for
  a 10 MB RGB frame (reused staging memory: no page faults).
- **Small.** A static OpenCV of six modules (core, imgproc, features,
  flann, geometry, video) and no codecs: 5-7 MB a binary, 2-2.8 MB
  gzipped. Encoded images go through [sharp](https://sharp.pixelplumbing.com).

```js
const cv = require("@graciousstar/opencv5");
const { image } = await cv.resize(
	{ data, width: 4000, height: 3000, channels: 3, colorSpace: "RGB", dtype: "uint8" },
	"num", 1000, "num", 0, "raw",
);
```

## API

Images are raw descriptors, `{ data, width, height, channels, colorSpace,
dtype }`: `data` a Buffer or Uint8Array of at least `width * height *
channels` bytes, `channels` 1, 3 or 4, `colorSpace` `GRAY`, `RGB`,
`RGBA`, `BGR` or `BGRA`, `dtype` `uint8`. Every op returns a promise of
`{ image, timing }`, with `image` a new raw descriptor - or an encoded
Buffer when `fmt` is `jpg`, `png` or `webp` (through sharp; `quality`
applies to jpg and webp). `fmt` `raw` (or omitted) returns raw.

| op | does |
|---|---|
| `colorConvert(image, target, [fmt], [quality])` | `cvtColor` to `target` (any pair of the colour spaces above); a copy when they match. `image` may also be an encoded Buffer (jpg/png/webp/tiff..., decoded by sharp at its own channel count, grey + alpha as RGBA, no EXIF rotation). |
| `resize(image, wMode, w, hMode, h, [fmt], [quality])` | `INTER_LINEAR`. Mode `num` is pixels, `pct` a percentage, `scale` a factor; a 0 on one side keeps the aspect ratio. |
| `filter(image, type, kernel, intensity, [fmt], [quality])` | `otsu`: Gaussian blur (kernel 3-31, sigma 0) then Otsu threshold to a 0/255 mask - **the blurred image is written back over a single-channel input** when the op completes, as the bridge this replaces did; `edge`: Sobel magnitude, \|gx\|/2 + \|gy\|/2 times `intensity`, kernel 3-7 (larger overflows OpenCV's 16-bit derivative). A colour input is taken to grey first. |
| `crop(image, x, y, w, h, normalized, [fmt], [quality])` | A copy of the rect, clamped into the frame; `normalized` reads x/y/w/h as fractions of the frame. Non-numbers are TypeErrors, NaN or infinite values and a non-positive size RangeErrors. |
| `rotate(image, angleDeg, [padColor], [fmt], [quality])` | `getRotationMatrix2D(centre, angleDeg)` into a canvas grown to hold the rotated frame (each side `Math.trunc` of the rotated extent), re-centred; bilinear, the border in `padColor` (`#rrggbb`; a grey image takes its luma). |
| `imageAlign(reference, target, scale, iterations, epsilon, fmt, quality, pngOptimize, returnImage, polygon, motion, pipeline, eccRefine, detector)` | Grey images. ORB (800 features, 1.2, 5 levels) on copies at `scale`, Lowe ratio 0.75, `estimateAffine2D` (USAC MAGSAC, 5 px), then ECC (`iterations`, `epsilon`) from that seed - skipped in `eccRefine` `auto` when the seed has 50 inliers or more. Returns `{ success, image, transformMatrix: { matrix2x3 }, inliers, timing }`: the matrix maps reference coordinates into the target resized to the reference's size; `image` is the target warped onto the reference (nearest neighbour, 0 outside). Only `affine`, `features+ecc`, `orb` and no polygon are supported; anything else is refused. `iterations` is 1-500, and the alignment copy at `scale` must be at least 32 px a side (ORB's pyramid): either is otherwise a RangeError. |

The argument positions are those of the `@rosepetal/node-red-contrib-image-tools`
cpp-bridge, which this replaces. `pngOptimize` true compresses a png
output harder (zlib 9, adaptive filtering), false fast (zlib 1).

Raw `data` must be a Buffer, Uint8Array or Uint8ClampedArray (a
Float32Array or DataView is a TypeError), and not a resizable or growable
store. Outputs are capped at 64 megapixels and 16384 px a side.

`imageAlign` finds a reference's ORB features once, keyed by the
reference's content (a 64-bit hash of every byte, about 0.3 ms for 3 MP),
and keeps the four most recently used: a reference rewritten in place is
a new reference, and a caller cycling through scales or references does
not keep each alive.

Also: `load()` (the addon, or a throw saying why it does not load here),
`available()`, `ready()`, `candidates()` (the binary paths it would try).

`OPENCV5_ADDON=/path/to/opencv5.node` loads that binary instead, unchecked
- for a local build (a path that does not exist says so). A binary that
does not load is remembered for the process, as nothing that decides it
changes while it runs; `_reset()` forgets it.

The binaries built so far (`prebuilds/manifest.json` holds their sizes
and SHA-256; the Linux ones rebuild to the same bytes):

| binary | bytes | SHA-256 |
|---|---|---|
| linux-x64/opencv5.glibc.node | 6520536 | `31e81d3a4b81656b6e63bf599242f9d50e6d72227c0313709f06c05fb4abc6fa` |
| linux-x64/opencv5.musl.node | 7018448 | `9ebf79fe907101b34e25328c95cdcacf8d04ec069c5aa64b61bf7d8c4114e9ca` |
| win32-x64/opencv5.node | 5054976 | `9095954b9ecc8e0c24862ddf6dd39e563d3792209ce5ff22642485dec88ea812` |

## Building

```sh
sh native/prebuild-linux.sh x64|arm64 glibc|musl   # docker; pinned images, cached OpenCV
OPENCV_PREFIX=... npx node-gyp rebuild             # Windows, in native/ (after build-opencv.sh)
sh native/build.sh OUT.node NODE_INCLUDE OPENCV_PREFIX   # macOS / any Unix
node native/manifest.js                            # rewrite prebuilds/manifest.json
```

`native/build-opencv.sh` builds the static OpenCV 5.0.0 from its release
tarball (SHA-256 pinned in `prebuild-linux.sh`): 85 s in manylinux2014,
150 s in musllinux, 90 s with MSVC on 16 threads. Two clean Linux builds
give the same bytes; CI (`.github/workflows/prebuild.yml`, once this is
its own repository) rebuilds the x64 ones and fails on any difference from
the manifest. `node native/manifest.js --complete` runs before `npm
publish` and refuses a package without all seven binaries.

## Licence

Apache-2.0. The binaries link OpenCV (Apache-2.0), FLANN, Berkeley
SoftFloat, fdlibm and zlib: see NOTICE.
