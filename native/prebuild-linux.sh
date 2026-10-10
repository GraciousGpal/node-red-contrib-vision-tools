#!/bin/sh
# Build a Linux prebuild the way the shipped ones are built, in a pinned
# image, so the same source gives the same bytes (prebuilds/manifest.json;
# CI rebuilds and fails on any difference):
#
#   sh native/prebuild-linux.sh x64|arm64 glibc|musl
#
# glibc: manylinux2014 (CentOS 7, glibc 2.17 - past its end of life, kept
#        because it is what lets one binary load on any glibc from 2.17 on;
#        devtoolset GCC 10)
# musl:  musllinux_1_2 (Alpine, GCC 14)
# headers: node-api-headers 1.9.0 (node_api.h alone; the binary links no
#        Node), the same for every build whatever Node runs this script
#
# Needs docker and npm on the host; writes
# prebuilds/linux-<arch>/vision-kernels.<libc>.node.
set -eu
arch=$1
libc=$2
case "$arch-$libc" in
x64-glibc) image=quay.io/pypa/manylinux2014_x86_64@sha256:f6a6f153c9cf45470507ebbc27013e5db14ce21331b62fd2c540561f25e5f0a5 ;;
x64-musl) image=quay.io/pypa/musllinux_1_2_x86_64@sha256:dc96c1f69b8a6241bcc8175a8d89b1caf0dccf959ff111a2272c42747af38350 ;;
arm64-glibc) image=quay.io/pypa/manylinux2014_aarch64@sha256:c10b5d2ce68a4426011b5b9b8492f01037b9d0fd2187ed1956b346aa42faeb17 ;;
arm64-musl) image=quay.io/pypa/musllinux_1_2_aarch64@sha256:83a69fa8383ba5ac2d4f01597b791ebf93269c9748270b51b7a54fbba0dcdd39 ;;
*) echo "usage: prebuild-linux.sh x64|arm64 glibc|musl" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
work=.prebuild-$arch-$libc
rm -rf "$work"
mkdir -p "$work" "prebuilds/linux-$arch"
(cd "$work" && npm pack --silent node-api-headers@1.9.0 >/dev/null && tar xzf node-api-headers-1.9.0.tgz)
# the build in /tmp inside the container, so no host path reaches the
# binary (git-bash on Windows: no path conversion, a C:/ mount path)
export MSYS_NO_PATHCONV=1
host=$(command -v cygpath >/dev/null 2>&1 && cygpath -m "$PWD" || echo "$PWD")
docker run --rm -v "$host:/w" "$image" sh -c "
	set -e
	cp -r /w/native /tmp/native && cp -r /w/$work/package/include /tmp/include
	cd /tmp && sh native/build.sh /tmp/out.node /tmp/include
	cp /tmp/out.node /w/prebuilds/linux-$arch/vision-kernels.$libc.node
	chmod 644 /w/prebuilds/linux-$arch/vision-kernels.$libc.node"
rm -rf "$work"
