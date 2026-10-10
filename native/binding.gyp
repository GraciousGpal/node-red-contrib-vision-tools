{
	# Build from source with node-gyp: `cd native && npx node-gyp rebuild`,
	# which lib/nativeKernels.js then prefers over the shipped prebuilds.
	# The Linux prebuilds come from build.sh, with these same flags; the
	# floating-point ones are what keep the bytes the JS kernels' (see
	# kernels.cc).
	"targets": [
		{
			"target_name": "vision_kernels",
			"sources": ["kernels.cc"],
			"cflags_cc": ["-O3", "-std=c++17", "-ffp-contract=off", "-fno-math-errno", "-fno-exceptions", "-fno-rtti", "-fvisibility=hidden"],
			"cflags_cc!": ["-std=gnu++17", "-std=gnu++20"],
			"ldflags": ["-static-libstdc++", "-static-libgcc"],
			"xcode_settings": {
				"MACOSX_DEPLOYMENT_TARGET": "11.0",
				"GCC_OPTIMIZATION_LEVEL": "3",
				"GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
				"CLANG_CXX_LANGUAGE_STANDARD": "c++17",
				"OTHER_CPLUSPLUSFLAGS": ["-ffp-contract=off", "-fno-math-errno"]
			},
			"msvs_settings": {
				"VCCLCompilerTool": {
					"Optimization": 2,
					"AdditionalOptions": ["/fp:precise"]
				}
			}
		}
	]
}
