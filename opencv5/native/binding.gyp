{
	# The opencv5 addon with node-gyp, for Windows (Linux and macOS use
	# build.sh). OPENCV_PREFIX is a static OpenCV from build-opencv.sh:
	#
	#   OPENCV_PREFIX=C:/opencv npx node-gyp rebuild   (in native/)
	#
	# gives build/Release/opencv5.node, the name index.js loads with OPENCV5_ADDON.
	# MSVC: the static CRT (/MT) OpenCV was built with, /fp:precise, C++17,
	# exceptions on (OpenCV reports errors by throwing).
	"targets": [
		{
			"target_name": "opencv5",
			"sources": ["opencv5.cc"],
			"include_dirs": ["<!(node gyp-paths.js include)"],
			"libraries": ["<!@(node gyp-paths.js libs)"],
			"cflags_cc": ["-O3", "-std=c++17", "-ffp-contract=off", "-fvisibility=hidden", "-fexceptions"],
			"cflags_cc!": ["-fno-exceptions", "-std=gnu++17", "-std=gnu++20"],
			"msvs_settings": {
				"VCCLCompilerTool": {
					"Optimization": 2,
					"RuntimeLibrary": 0,
					"ExceptionHandling": 1,
					"AdditionalOptions": ["/fp:precise", "/std:c++17"]
				}
			}
		}
	]
}
