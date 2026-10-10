#!/bin/sh
# Build the native kernels with the compiler alone - no node-gyp, no
# Python, no Node: what the Linux prebuilds are made with, inside a
# manylinux2014 (glibc 2.17) or Alpine (musl) image, and what any Linux
# or macOS host can build from source with. node-gyp users have
# binding.gyp, which carries the same flags.
#
#   sh native/build.sh OUT.node NODE_API_INCLUDE_DIR
#
# NODE_API_INCLUDE_DIR holds node_api.h: a Node install's include/node,
# or the node-api-headers package's include.
#
# The flags that matter are the floating-point ones: -ffp-contract=off
# (GCC fuses a * b + c into one FMA by default on arm64, and an FMA rounds
# once where the JS rounds twice) and no -ffast-math, so the bytes are the
# JS kernels'. Baseline ISA, so the binary loads on any CPU of its arch;
# the one AVX2 loop is picked at run time (kernels.cc).
set -eu
out=$1
inc=$2
here=$(cd "$(dirname "$0")" && pwd)
CXX=${CXX:-c++}
flags="-O3 -std=c++17 -fPIC -shared -ffp-contract=off -fno-math-errno -fno-exceptions -fno-rtti -fvisibility=hidden -Wall -Wextra -Wno-unused-parameter"
case "$(uname -s)" in
Darwin)
	# N-API's symbols come from the node binary that loads the addon
	$CXX $flags -mmacosx-version-min=11.0 -undefined dynamic_lookup -I"$inc" -o "$out" "$here/kernels.cc"
	strip -x "$out"
	;;
*)
	# libstdc++ and libgcc linked in, so the binary needs only libc
	$CXX $flags -I"$inc" -o "$out" "$here/kernels.cc" -static-libstdc++ -static-libgcc -Wl,--as-needed
	strip --strip-unneeded "$out"
	;;
esac
ls -l "$out"
