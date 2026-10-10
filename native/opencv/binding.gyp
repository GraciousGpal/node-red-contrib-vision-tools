{
	# The vision-cv addon with node-gyp, for Windows (Linux and macOS use
	# build.sh). OPENCV_PREFIX is a static OpenCV from build-opencv.sh:
	#
	#   OPENCV_PREFIX=C:/opencv npx node-gyp rebuild   (in native/opencv)
	#
	# MSVC: the static CRT (/MT) OpenCV was built with, /fp:precise, C++17,
	# exceptions on (OpenCV reports errors by throwing).
	"targets": [
		{
			"target_name": "vision_cv",
			"sources": ["vision-cv.cc"],
			"include_dirs": ["<!(node -p \"require('path').join(process.env.OPENCV_PREFIX, 'include')\")", "<!(node -p \"require('path').join(process.env.OPENCV_PREFIX, 'include', 'opencv5')\")"],
			"libraries": ["<!@(node -e \"const f=require('fs'),p=require('path');const w=(d)=>f.readdirSync(d,{withFileTypes:true}).flatMap((e)=>e.isDirectory()?w(p.join(d,e.name)):/\\.(lib|a)$/.test(e.name)?[p.join(d,e.name)]:[]);console.log(w(process.env.OPENCV_PREFIX).map((x)=>JSON.stringify(x.split(p.sep).join('/'))).join(' '))\")"],
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
