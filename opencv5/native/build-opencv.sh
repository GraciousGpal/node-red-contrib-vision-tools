#!/bin/sh
# Build the minimal static OpenCV 5 the opencv5 addon links: the six
# modules its ops need (colour conversion, resize, filters, rotation, and
# ORB + ECC alignment), and nothing that reaches outside the process.
#
#   sh native/build-opencv.sh SRC.tar.gz PREFIX [JOBS]
#
# Runs inside the pinned image (native/prebuild-linux.sh), on any
# Linux or macOS host with cmake and a C++17 compiler, or on Windows from
# git-bash with cmake and Visual Studio 2022 (MSVC, static CRT). SRC is
# the opencv-5.0.0 source tarball; PREFIX receives the headers and the
# static libraries (include/opencv5 and lib/ on Unix, include/ and
# x64/vc17/staticlib/ on Windows).
#
# Measured on a 16-thread Ryzen 7840U: 85 s in manylinux2014 (GCC 10),
# 149 s in musllinux_1_2 (GCC 14), 88 s with MSVC 19.44. Two clean
# builds in one Linux image give the same addon bytes.
#
# Modules: core, imgproc, features (4.x features2d: ORB, BFMatcher),
# flann, geometry (4.x calib3d's estimateAffine2D and USAC), video
# (findTransformECC). OpenCV 5 makes imgproc depend on geometry and
# geometry on flann, so all six are needed.
#
# Off: imgcodecs, highgui, videoio, dnn (codecs go through sharp, see
# index.js); IPP, OpenCL, TBB, OpenMP, Eigen, LAPACK, ITT; KleidiCV and
# Carotene, the arm64 HAL replacements, so arm64 runs OpenCV's own code as
# x64 does. Threads: OpenCV's pthreads backend.
#
# CPU: a baseline every machine of the arch has - x86-64-v2 (SSE4.2,
# POPCNT) on x64, NEON on arm64 - and nothing dispatched at run time
# (CPU_DISPATCH empty), so no binary needs AVX2 and every CPU runs the
# same code: the same bytes out on every machine. With AVX2 and AVX-512
# dispatched, a SSE4.2-only CPU moved the rig's local alignment by up to
# 0.34 px and its heat maps by bytes against an AVX2 one; the dispatched
# loops were worth about 1 ms of a 9 ms alignment. No fast-math, and
# -ffp-contract=off so the compiler fuses no a * b + c the source did not
# ask for. The build-info
# string skips the timestamp and the host kernel version, so the same
# image gives the same bytes.
#
# zlib is built from OpenCV's 3rdparty tree (core's FileStorage links it):
# a shipped binary needs its licence in a NOTICE beside OpenCV's.
set -eu
src=$1
prefix=$2
jobs=${3:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}
# a fixed path: __FILE__ in OpenCV's error messages puts it into the
# binary. One build at a time per host outside a container.
work=/tmp/opencv-build
rm -rf "$work" && mkdir -p "$work"
tar xzf "$src" -C "$work"
srcdir=$(ls -d "$work"/opencv-*)
build=$work/build
case "$(uname -m)" in
x86_64 | amd64) cpu="-DCPU_BASELINE=SSE4_2;POPCNT -DCPU_DISPATCH=" ;;
aarch64 | arm64) cpu="-DCPU_BASELINE=NEON;FP16 -DCPU_DISPATCH=" ;;
*) echo "build-opencv.sh: no CPU settings for $(uname -m)" >&2; exit 2 ;;
esac
case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*)
	# Windows, from git-bash: MSVC through its own generator (no vcvars
	# needed) and its default flags, static CRT as node-gyp links the
	# addon; MSVC contracts no FMA at its default /fp:precise
	set -- -G "Visual Studio 17 2022" -A x64 -DBUILD_WITH_STATIC_CRT=ON
	# cmake.exe takes Windows paths, not /tmp. /tmp is the builder's own
	# Temp folder here, so a Windows build carries that path (user name
	# included) in its __FILE__ strings and is not byte-reproducible
	# across machines; the Linux builds are.
	srcdir=$(cygpath -m "$srcdir")
	build=$(cygpath -m "$build")
	prefix=$(cygpath -m "$prefix")
	;;
*)
	flags="-ffp-contract=off -fno-fast-math -ffunction-sections -fdata-sections -fvisibility=hidden"
	set -- -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags"
	;;
esac
start=$(date +%s)
# shellcheck disable=SC2086 # $cpu is a list of arguments
cmake -S "$srcdir" -B "$build" "$@" \
	-DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF -DENABLE_PIC=ON \
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
cmake --build "$build" --config Release --target install -j "$jobs" >"$work/build.log" 2>&1 || { tail -40 "$work/build.log"; exit 1; }
end=$(date +%s)
echo "opencv built in $((end - start)) s"
find "$prefix" -name '*.a' -o -name '*.lib' | xargs ls -l
rm -rf "$work"
