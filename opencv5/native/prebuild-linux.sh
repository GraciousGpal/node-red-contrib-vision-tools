#!/bin/sh
# Build the addon for Linux in an image pinned by digest, so the same
# source gives the same bytes (prebuilds/manifest.json; CI rebuilds the
# x64 ones and fails on any difference):
#
#   sh native/prebuild-linux.sh x64|arm64 glibc|musl
#
# glibc: manylinux2014 (CentOS 7, glibc 2.17 - past its end of life, kept
#        because one binary then loads on any glibc from 2.17 on; GCC 10)
# musl:  musllinux_1_2 (Alpine, GCC 14)
# headers: node-api-headers 1.9.0 (node_api.h alone; the binary links no
#        Node)
#
# Two steps, both inside the image: the static OpenCV 5 (build-opencv.sh,
# the slow one - minutes) and the addon linked against it (build.sh,
# seconds). The OpenCV install is kept in $OPENCV5_CACHE (default
# .opencv-cache/ at the package root, ignored by git) under a key of the
# image digest, the OpenCV tarball's SHA-256 and build-opencv.sh's own
# hash, so only a change to one of those rebuilds it; CI caches the
# directory on the same key. OPENCV5_CACHE is a path relative to the
# package root, without spaces: the container sees it under that mount.
#
# The OpenCV source is the 5.0.0 release tarball from GitHub, checked
# against the SHA-256 below before anything is built from it.
#
# Needs docker and npm on the host; writes
# prebuilds/linux-<arch>/opencv5.<libc>.node.
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
OPENCV_VERSION=5.0.0
OPENCV_SHA256=b0528f5a1d379d59d4701cb28c36e22214cc51cf64594e5b56f2d3e6c0233095
HEADERS_INTEGRITY=sha512-2oNILP4jXwRB4ywnYKjVk1YyJ96n2D4EOVJO6S3oYZ5PtbJrw3Yt9TpAuX3nBLMuzn74rnfGQrv13pS9vC+YiA==
cd "$(dirname "$0")/.."
cache=${OPENCV5_CACHE:-.opencv-cache}
case "$cache" in
/* | *:* | *" "* | *..*) echo "prebuild-linux.sh: OPENCV5_CACHE must be a relative path inside the repo, without spaces" >&2; exit 2 ;;
esac
mkdir -p "$cache" "prebuilds/linux-$arch"
tarball=$cache/opencv-$OPENCV_VERSION.tar.gz
if [ ! -f "$tarball" ]; then
	curl -fsSL -o "$tarball.part" "https://github.com/opencv/opencv/archive/refs/tags/$OPENCV_VERSION.tar.gz"
	mv "$tarball.part" "$tarball"
fi
got=$(sha256sum "$tarball" | cut -d' ' -f1)
if [ "$got" != "$OPENCV_SHA256" ]; then
	echo "prebuild-linux.sh: $tarball has SHA-256 $got, expected $OPENCV_SHA256" >&2
	exit 1
fi
key=$(printf '%s %s %s' "$image" "$OPENCV_SHA256" "$(sha256sum native/build-opencv.sh | cut -d' ' -f1)" | sha256sum | cut -c1-16)
prefix=opencv-$OPENCV_VERSION-$arch-$libc-$key
work=.prebuild-$arch-$libc
rm -rf "$work"
mkdir -p "$work"
(cd "$work" && npm pack --silent node-api-headers@1.9.0 >/dev/null)
# the registry's integrity for that version, so a changed tarball stops here
got=$(openssl dgst -sha512 -binary "$work/node-api-headers-1.9.0.tgz" | base64 | tr -d '\n')
if [ "sha512-$got" != "$HEADERS_INTEGRITY" ]; then
	echo "prebuild-linux.sh: node-api-headers-1.9.0.tgz is sha512-$got, expected $HEADERS_INTEGRITY" >&2
	exit 1
fi
(cd "$work" && tar xzf node-api-headers-1.9.0.tgz)
# the builds in fixed paths inside the container, so no host path reaches
# a binary (git-bash on Windows: no path conversion, a C:/ mount path)
export MSYS_NO_PATHCONV=1
host=$(command -v cygpath >/dev/null 2>&1 && cygpath -m "$PWD" || echo "$PWD")
docker run --rm -v "$host:/w" "$image" sh -c "
	set -e
	if [ ! -f /w/$cache/$prefix/.complete ]; then
		sh /w/native/build-opencv.sh /w/$tarball /opt/opencv && touch /opt/opencv/.complete
		rm -rf /w/$cache/$prefix.part && cp -r /opt/opencv /w/$cache/$prefix.part
		mv /w/$cache/$prefix.part /w/$cache/$prefix
	else
		cp -r /w/$cache/$prefix /opt/opencv
	fi
	cp -r /w/native /tmp/src && cp -r /w/$work/package/include /tmp/include
	sh /tmp/src/build.sh /tmp/out.node /tmp/include /opt/opencv
	cp /tmp/out.node /w/prebuilds/linux-$arch/opencv5.$libc.node
	chmod 644 /w/prebuilds/linux-$arch/opencv5.$libc.node"
rm -rf "$work"
