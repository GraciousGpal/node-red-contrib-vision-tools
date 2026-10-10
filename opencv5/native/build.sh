#!/bin/sh
# Link the opencv5 addon (native/opencv5.cc) against a static
# OpenCV from build-opencv.sh, with the compiler alone - no node-gyp:
#
#   sh native/build.sh OUT.node NODE_API_INCLUDE_DIR OPENCV_PREFIX
#
# The same floating-point rules as OpenCV's own build (no fast-math,
# -ffp-contract=off) and the arch's baseline ISA, so the binary loads on
# any CPU of its arch. libstdc++ and libgcc are linked in and every
# OpenCV symbol is hidden, so it needs only libc and exports only the
# N-API entry point. Linux links with full RELRO (-z relro -z now): every
# symbol bound at load, the GOT read-only after.
set -eu
out=$1
inc=$2
prefix=$3
here=$(cd "$(dirname "$0")" && pwd)
CXX=${CXX:-c++}
case "$(uname -m)" in
x86_64 | amd64) march="-msse4.2 -mpopcnt" ;; # x86-64-v2; GCC 10 has no -march name for it
*) march="" ;;
esac
# include/opencv5 on Unix, include on Windows
cvinc=$prefix/include/opencv5
[ -d "$cvinc" ] || cvinc=$prefix/include
# OpenCV's modules, then the 3rdparty libraries they use, in one group so
# the link order does not matter
libs=$(find "$prefix" -name 'libopencv_*.a' | sort)
third=$(find "$prefix" -path '*3rdparty*' -name '*.a' | sort)
flags="-O3 -std=c++17 -fPIC -shared $march -ffp-contract=off -fno-fast-math -fvisibility=hidden -Wall -Wextra -Wno-unused-parameter"
case "$(uname -s)" in
Darwin)
	# shellcheck disable=SC2086
	$CXX $flags -mmacosx-version-min=11.0 -undefined dynamic_lookup -Wl,-dead_strip -I"$inc" -I"$cvinc" \
		-o "$out" "$here/opencv5.cc" $libs $third
	strip -x "$out"
	;;
*)
	# exports: N-API's two entry points and nothing else - not even the
	# libstdc++ template instances the static runtime would otherwise leak
	map=$(mktemp)
	printf '{ global: napi_register_module_v1; node_api_module_get_api_version_v1; local: *; };\n' >"$map"
	# shellcheck disable=SC2086
	$CXX $flags -I"$inc" -I"$cvinc" -o "$out" "$here/opencv5.cc" \
		-Wl,--start-group $libs $third -Wl,--end-group \
		-Wl,--gc-sections -Wl,--exclude-libs,ALL -Wl,--as-needed -Wl,-z,relro -Wl,-z,now -Wl,--version-script="$map" \
		-static-libstdc++ -static-libgcc -lpthread -ldl
	rm -f "$map"
	strip --strip-unneeded "$out"
	;;
esac
ls -l "$out"
