#!/bin/sh
# Which OpenCV sources end up in the Linux binary, and whose copyright they
# carry: what NOTICE must list.
#
#   sh native/notice-sources.sh            (after prebuild-linux.sh x64 musl)
#
# Links the addon once more in the musl image against the cached OpenCV,
# with a link map, and keeps every archive member that put a non-empty
# section into the output (after --gc-sections). For each, it prints the
# source file and every copyright line in it. The OpenCV-wide lines (the
# holders in OpenCV's own COPYRIGHT) are in NOTICE under OpenCV; any other
# holder printed here needs its own entry there.
set -eu
cd "$(dirname "$0")/.."
cache=${OPENCV5_CACHE:-.opencv-cache}
image=quay.io/pypa/musllinux_1_2_x86_64@sha256:dc96c1f69b8a6241bcc8175a8d89b1caf0dccf959ff111a2272c42747af38350
prefix=$(ls -d "$cache"/opencv-5.0.0-x64-musl-* | head -1)
[ -f "$prefix/.complete" ] || { echo "notice-sources.sh: run native/prebuild-linux.sh x64 musl first" >&2; exit 2; }
tarball=$cache/opencv-5.0.0.tar.gz
work=.prebuild-notice
rm -rf "$work" && mkdir -p "$work"
(cd "$work" && npm pack --silent node-api-headers@1.9.0 >/dev/null && tar xzf node-api-headers-1.9.0.tgz)
export MSYS_NO_PATHCONV=1
host=$(command -v cygpath >/dev/null 2>&1 && cygpath -m "$PWD" || echo "$PWD")
docker run --rm -v "$host:/w" "$image" sh -c "
	set -e
	cp -r /w/$prefix /opt/opencv
	mkdir -p /tmp/src && tar xzf /w/$tarball -C /tmp/src
	L=\$(find /opt/opencv -name 'libopencv_*.a' | sort); T=\$(find /opt/opencv -path '*3rdparty*' -name '*.a' | sort)
	g++ -O3 -std=c++17 -fPIC -shared -msse4.2 -mpopcnt -ffp-contract=off -fvisibility=hidden \
		-I/w/$work/package/include -I/opt/opencv/include/opencv5 -o /tmp/u.node /w/native/opencv5.cc \
		-Wl,--start-group \$L \$T -Wl,--end-group -Wl,--gc-sections -static-libstdc++ -static-libgcc -Wl,-Map,/tmp/map
	# members with a kept, non-empty section: lines after the memory map header
	# like ' .text.x  0xADDR  0xSIZE  /opt/opencv/lib/libopencv_core.a(foo.cpp.o)'
	sed -n '/^Linker script and memory map/,\$p' /tmp/map |
		grep -oE '0x[0-9a-f]+ +0x[0-9a-f]+ +/opt/opencv/[^ ]+\\.a\\([^)]+\\)' |
		awk '\$2 != \"0x0\" { print \$3 }' | sort -u > /tmp/members
	echo \"kept members: \$(wc -l < /tmp/members)\"
	while read -r m; do
		lib=\$(echo \"\$m\" | sed -E 's|.*/lib(opencv_)?([a-z0-9_]+)\\.a\\(.*|\\2|')
		obj=\$(echo \"\$m\" | sed -E 's|.*\\((.*)\\.o\\)|\\1|')
		case \"\$lib\" in zlib) dir=3rdparty/zlib ;; *) dir=modules/\$lib ;; esac
		src=\$(find /tmp/src/opencv-5.0.0/\$dir -name \"\$obj\" | head -1)
		[ -n \"\$src\" ] || { echo \"? \$m\"; continue; }
		lines=\$(grep -iE 'copyright' \"\$src\" | sed 's/^[ /*#]*//' | sort -u | tr '\\n' '|')
		echo \"\${src#/tmp/src/opencv-5.0.0/}: \${lines:-(none; OpenCV's LICENSE)}\"
	done < /tmp/members"
rm -rf "$work"
