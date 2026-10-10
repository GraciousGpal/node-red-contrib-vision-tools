#!/bin/sh
# Build the minimal static OpenCV 5 the vision-cv addon links: the six
# modules golden-compare's alignment and label-crop's ops need, and
# nothing that reaches outside the process.
#
#   sh native/opencv/build-opencv.sh SRC.tar.gz PREFIX [JOBS]
#
# Runs inside the pinned image (native/opencv/prebuild-linux.sh), or on any
# Linux or macOS host with cmake and a C++17 compiler. SRC is the
# opencv-5.0.0 source tarball; PREFIX receives include/ and lib/.
#
# Modules: core, imgproc, features (4.x features2d: ORB, BFMatcher),
# flann, geometry (4.x calib3d's estimateAffine2D and USAC), video
# (findTransformECC). OpenCV 5 makes imgproc depend on geometry and
# geometry on flann, so all six are needed.
#
# Off: imgcodecs, highgui, videoio, dnn (codecs go through sharp, see
# lib/ownCv.js); IPP, OpenCL, TBB, OpenMP, Eigen, LAPACK, ITT; KleidiCV and
# Carotene, the arm64 HAL replacements, so arm64 runs OpenCV's own code as
# x64 does. Threads: OpenCV's pthreads backend.
#
# CPU: a baseline every machine of the arch has - x86-64-v2 (SSE4.2,
# POPCNT) on x64, NEON on arm64 - with AVX2/AVX-512 (x64) and dotprod/fp16
# (arm64) loops picked at run time by OpenCV's own cpuid checks, so no
# binary needs AVX2. No fast-math, and -ffp-contract=off so the compiler
# fuses no a * b + c the source did not ask for (OpenCV's own explicit FMA
# intrinsics in its dispatched loops are unaffected). The build-info
# string skips the timestamp and the host kernel version, so the same
# image gives the same bytes.
#
# zlib is built from OpenCV's 3rdparty tree (core's FileStorage links it):
# a shipped binary needs its licence in a NOTICE beside OpenCV's.
set -eu
src=$1
prefix=$2
jobs=${3:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}
# a fixed path: __FILE__ in OpenCV's error messages puts it into the binary
work=/tmp/opencv-build
rm -rf "$work" && mkdir -p "$work"
tar xzf "$src" -C "$work"
srcdir=$(ls -d "$work"/opencv-*)
case "$(uname -m)" in
x86_64 | amd64) cpu="-DCPU_BASELINE=SSE4_2;POPCNT -DCPU_DISPATCH=AVX;FP16;AVX2;AVX512_SKX" ;;
aarch64 | arm64) cpu="-DCPU_BASELINE=NEON;FP16 -DCPU_DISPATCH=NEON_DOTPROD;NEON_FP16" ;;
*) echo "build-opencv.sh: no CPU settings for $(uname -m)" >&2; exit 2 ;;
esac
flags="-ffp-contract=off -fno-fast-math -ffunction-sections -fdata-sections -fvisibility=hidden"
start=$(date +%s)
# shellcheck disable=SC2086 # $cpu is a list of arguments
cmake -S "$srcdir" -B "$work/build" -DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF -DENABLE_PIC=ON \
	-DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags" \
	-DBUILD_LIST=core,imgproc,features,flann,geometry,video \
	$cpu -DENABLE_FAST_MATH=OFF \
	-DWITH_IPP=OFF -DWITH_OPENCL=OFF -DWITH_TBB=OFF -DWITH_OPENMP=OFF -DWITH_PTHREADS_PF=ON \
	-DWITH_ITT=OFF -DWITH_EIGEN=OFF -DWITH_LAPACK=OFF -DWITH_PROTOBUF=OFF -DWITH_VA=OFF -DWITH_VA_INTEL=OFF \
	-DWITH_KLEIDICV=OFF -DWITH_CAROTENE=OFF -DWITH_FASTCV=OFF -DWITH_CUDA=OFF -DWITH_VULKAN=OFF \
	-DWITH_JPEG=OFF -DWITH_PNG=OFF -DWITH_WEBP=OFF -DWITH_TIFF=OFF -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF \
	-DWITH_OPENEXR=OFF -DWITH_AVIF=OFF -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_V4L=OFF -DWITH_GTK=OFF \
	-DWITH_QT=OFF -DWITH_1394=OFF -DWITH_VTK=OFF -DWITH_IMGCODEC_GIF=OFF -DWITH_IMGCODEC_HDR=OFF \
	-DWITH_IMGCODEC_SUNRASTER=OFF -DWITH_IMGCODEC_PXM=OFF -DWITH_IMGCODEC_PFM=OFF \
	-DBUILD_ZLIB=ON -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_opencv_apps=OFF \
	-DBUILD_JAVA=OFF -DBUILD_opencv_python3=OFF -DBUILD_opencv_js=OFF -DBUILD_DOCS=OFF -DCV_TRACE=OFF \
	-DOPENCV_GENERATE_PKGCONFIG=OFF -DBUILD_INFO_SKIP_TIMESTAMP=ON -DBUILD_INFO_SKIP_SYSTEM_VERSION=ON \
	>"$work/cmake.log" 2>&1 || { tail -40 "$work/cmake.log"; exit 1; }
grep -E "Baseline|Dispatched|requested|To be built|Parallel framework|ZLib" "$work/cmake.log" || true
cmake --build "$work/build" --target install -j "$jobs" >"$work/build.log" 2>&1 || { tail -40 "$work/build.log"; exit 1; }
end=$(date +%s)
echo "opencv built in $((end - start)) s"
ls -l "$prefix"/lib/*.a "$prefix"/lib/opencv5/3rdparty/*.a 2>/dev/null || ls -lR "$prefix/lib"
rm -rf "$work"
