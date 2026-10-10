/**
 * Native twins of golden-compare's five hottest pool kernels
 * (lib/poolWorker.js): localField and localApply (lib/localAlign.js
 * fieldCells, applyCells), binarize with the tone comparison riding on it
 * and toneCompare alone (lib/toneRows.js toneCompareRows), and diff
 * (lib/diffRows.js diffRows).
 *
 * The JavaScript stays the reference, and these must give its bytes, not
 * close ones: a mask, a count or a field value that differed would be a
 * verdict that depends on whether a binary loaded. So the arithmetic is
 * the JS's, in its order, on doubles where the JS has doubles. That rules
 * out any build flag that lets the compiler reorder or fuse floating-point
 * work: -ffp-contract=off (an FMA rounds once where the JS rounds twice,
 * and GCC fuses by default on arm64), no -ffast-math, MSVC /fp:precise.
 * test/nativeKernels.test.js holds every kernel to the JS one's bytes.
 *
 * Plain node_api.h, so one binary serves every Node with N-API 8, and
 * context-aware, so each pool worker thread loads its own instance. The
 * kernels take the views lib/nativeKernels.js builds over the dispatch's
 * shared buffers, and claim chunks off ctx.next with the same atomic add
 * as the JS's Atomics.add, so native and JS workers could share one
 * dispatch. Everything a kernel will index is checked before it claims
 * anything: a bad dispatch throws, and the caller runs the JS kernel on
 * it instead, where a read out of bounds is an undefined and not a crash
 * of the whole Node-RED process.
 *
 * SIMD: plain loops for the auto-vectoriser, built for the baseline ISA
 * (x86-64 / armv8-a), so the binary loads on any CPU of its arch. The one
 * loop that gained from more, the field search's SSD (~15% of it, a few
 * percent of a frame), is built a second time for AVX2 and picked at load
 * with __builtin_cpu_supports - GCC and Clang on Linux x86-64 only, since
 * musl has no IFUNC for target_clones and the rest is not worth a path.
 * Its sums are integers, so both builds give the same bits.
 */

#define NAPI_VERSION 8
#include <node_api.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

#ifdef _MSC_VER
#include <intrin.h>
#endif

#if defined(__x86_64__) && defined(__linux__) && (defined(__GNUC__) || defined(__clang__))
#define VT_AVX2_PATH 1
#else
#define VT_AVX2_PATH 0
#endif

// Bumped whenever a kernel's ctx contract changes, so lib/nativeKernels.js
// refuses a binary built for another one rather than misreading buffers.
#define VT_KERNELS_ABI 1

namespace {

const double INF = std::numeric_limits<double>::infinity();
// see Ctx::dim
constexpr int MAX_DIM = 1 << 24;
// the field search's offset cap: lib/localAlign.js runs (2R + 1)^2
// offsets a tile, and the node clamps localAlignMax to 16; past this a
// library caller's dispatch runs on the JS kernel
constexpr int MAX_OFFSET = 64;

// ------------------------------------------------------------- napi glue

template <class T>
struct TypeOf;
template <>
struct TypeOf<uint8_t> {
	static constexpr napi_typedarray_type value = napi_uint8_array;
};
template <>
struct TypeOf<int16_t> {
	static constexpr napi_typedarray_type value = napi_int16_array;
};
template <>
struct TypeOf<uint32_t> {
	static constexpr napi_typedarray_type value = napi_uint32_array;
};
template <>
struct TypeOf<float> {
	static constexpr napi_typedarray_type value = napi_float32_array;
};

// One dispatch's ctx object. Every property is read once, up front
// (snapshot), and every check after that works on what was read: a getter
// or a Proxy trap is JavaScript, and run between two reads it could detach
// or shrink a buffer whose data pointer the first had already taken. After
// the snapshot no JavaScript runs until the kernel returns. Every check
// is kept: the first failure is in `err`, and the kernel throws it before
// it claims or writes anything.
struct Prop {
	char key[40];
	napi_value v;
	// an array's elements (the tone check's darkest / lightest), up to 32
	napi_value elems[32];
	uint32_t n;
};
struct Ctx {
	napi_env env;
	const char* err = nullptr;
	Prop props[48];
	int count = 0;

	// false with a JS exception pending (a getter threw), else true, with
	// `err` set if the ctx has more properties than any kernel reads
	bool snapshot(napi_value obj) {
		napi_value names;
		uint32_t n = 0;
		if (napi_get_property_names(env, obj, &names) != napi_ok) return false;
		if (napi_get_array_length(env, names, &n) != napi_ok) return false;
		if (n > 48) {
			fail("(too many properties)");
			return true;
		}
		for (uint32_t i = 0; i < n; i++) {
			Prop& p = props[count];
			napi_value name;
			size_t len = 0;
			if (napi_get_element(env, names, i, &name) != napi_ok) return false;
			if (napi_get_value_string_utf8(env, name, p.key, sizeof p.key, &len) != napi_ok) return false;
			if (len >= sizeof p.key - 1) continue;  // no kernel reads a key that long
			if (napi_get_property(env, obj, name, &p.v) != napi_ok) return false;
			p.n = 0;
			bool list = false;
			napi_is_array(env, p.v, &list);
			if (list) {
				uint32_t m = 0;
				if (napi_get_array_length(env, p.v, &m) != napi_ok) return false;
				p.n = m > 32 ? 33 : m;
				for (uint32_t j = 0; j < m && j < 32; j++)
					if (napi_get_element(env, p.v, j, &p.elems[j]) != napi_ok) return false;
			}
			count++;
		}
		return true;
	}
	const Prop* prop(const char* k) const {
		for (int i = 0; i < count; i++)
			if (std::strcmp(props[i].key, k) == 0) return &props[i];
		return nullptr;
	}
	napi_value get(const char* k) const {
		const Prop* p = prop(k);
		return p ? p->v : nullptr;
	}
	bool fail(const char* why) {
		if (!err) err = why;
		return false;
	}
	// a number as the JS reads it; absent, or not a number, is NaN
	double num(const char* k) const {
		napi_value v = get(k);
		napi_valuetype t = napi_undefined;
		if (v) napi_typeof(env, v, &t);
		if (t != napi_number) return std::numeric_limits<double>::quiet_NaN();
		double d = 0;
		napi_get_value_double(env, v, &d);
		return d;
	}
	// a whole number in [lo, hi]: the JS has integers here, and a
	// fraction or a NaN would index differently from it
	int whole(const char* k, int lo = 0, int hi = 1 << 30) {
		const double d = num(k);
		if (!(d >= lo && d <= hi && d == std::floor(d))) {
			fail(k);
			return lo;
		}
		return (int)d;
	}
	// a size in pixels, cells or blocks: at most 2^24, so that a sum or
	// product of two of them, which the kernels take in int, cannot wrap
	int dim(const char* k) { return whole(k, 1, MAX_DIM); }
	// a typed view of type T with at least `min` elements, or null when
	// absent and not `required`
	template <class T>
	T* arr(const char* k, size_t min, bool required = true) {
		napi_value v = get(k);
		napi_valuetype t = napi_undefined;
		if (v) napi_typeof(env, v, &t);
		if (t == napi_null || t == napi_undefined) {
			if (required) fail(k);
			return nullptr;
		}
		return view<T>(v, min, k);
	}
	template <class T>
	T* view(napi_value v, size_t min, const char* k) {
		bool is = false;
		napi_is_typedarray(env, v, &is);
		if (!is) {
			fail(k);
			return nullptr;
		}
		napi_typedarray_type type;
		size_t n = 0;
		void* data = nullptr;
		napi_get_typedarray_info(env, v, &type, &n, &data, nullptr, nullptr);
		if (type != TypeOf<T>::value || n < min || (min > 0 && !data)) {
			fail(k);
			return nullptr;
		}
		return static_cast<T*>(data);
	}
	// an array of Uint8Arrays (the tone check's darkest / lightest, one
	// per slack level: lib/localAlign.js SLACK_LEVELS has nine)
	uint32_t u8list(const char* k, size_t min, const uint8_t** out, uint32_t max) {
		const Prop* p = prop(k);
		bool is = false;
		if (p) napi_is_array(env, p->v, &is);
		if (!is || p->n > max) {
			fail(k);
			return 0;
		}
		for (uint32_t i = 0; i < p->n; i++) out[i] = view<uint8_t>(p->elems[i], min, k);
		return p->n;
	}
};

inline size_t ceilDiv(size_t a, size_t b) { return (a + b - 1) / b; }

// A grid's width must be the one its cell size makes of the image, not
// merely enough: a wider one runs the kernels' x past the image (first *
// cell in applyCells, as an int, reached 2^32 and wrote before `out`).
inline bool exactGrid(int gridW, int width, int cell) { return (size_t)gridW == ceilDiv(width, cell); }

// Atomics.add(next, 0, 1) on the dispatch's shared counter
inline uint32_t claim(uint32_t* next) {
#ifdef _MSC_VER
	return (uint32_t)_InterlockedExchangeAdd(reinterpret_cast<volatile long*>(next), 1);
#else
	return __atomic_fetch_add(next, 1u, __ATOMIC_SEQ_CST);
#endif
}

// The claimed loop of lib/poolWorker.js eachClaimed over [0, total).
struct Claim {
	uint32_t* next = nullptr;
	int total = 0, chunk = 1;
	bool read(Ctx& c) {
		next = c.arr<uint32_t>("next", 1);
		total = c.whole("total");
		chunk = c.whole("chunk", 1);
		return !c.err;
	}
	template <class F>
	void each(F fn) const {
		for (uint32_t k = claim(next); (int64_t)k * chunk < total; k = claim(next))
			fn((int)k * chunk, (int)std::min<int64_t>(total, ((int64_t)k + 1) * chunk));
	}
};

// JS Math.round: the nearest integer, ties toward +Infinity. v - floor(v)
// is exact for every double, so this is too.
inline double jsRound(double v) {
	const double f = std::floor(v);
	return (v - f >= 0.5) ? f + 1.0 : f;
}

// A growable scratch array on malloc: nothing here needs the C++ runtime,
// so the binary links none: 88 KB on linux-x64, against 370 KB with
// libstdc++ linked in for std::vector.
template <class T>
struct Buf {
	T* p;
	size_t cap;
	// at least n elements; null when the memory is not there. Each kernel
	// grows its scratch to the most it will use before it claims a chunk
	// (and refuses the dispatch when it cannot), so inside the kernel this
	// only ever hands back what it already has.
	T* need(size_t n) {
		if (n > cap) {
			void* q = std::realloc(p, n * sizeof(T));
			if (!q) return nullptr;
			p = static_cast<T*>(q);
			cap = n;
		}
		return p;
	}
	void release() { std::free(p); }
};

// Per-thread scratch, kept between dispatches as the JS kernels keep
// theirs: one per napi_env, which is one per worker thread, and freed
// with it. Zeroed is empty.
struct ApplyScratch {
	Buf<int32_t> gx0s, gx1s, cellOf;
	Buf<double> wxs, topX, stepX, topY, stepY;
};
struct Scratch {
	Buf<uint8_t> tileG, planes, hrow;
	Buf<int32_t> cols;
	ApplyScratch apply;
	// setIsa("base"), for the tests: this thread's field search on the
	// baseline build
	bool forceBase;
};
Scratch& scratchOf(napi_env env) {
	void* data = nullptr;
	napi_get_instance_data(env, &data);
	return *static_cast<Scratch*>(data);
}

// ------------------------------------------------------------ localField

constexpr int SSD_STEP = 3;

double tileSsd(const uint8_t* g, const uint8_t* t, int w, int h, int x0, int y0, int x1, int y1, int dx, int dy) {
	double sum = 0;
	double count = 0;
	for (int y = y0; y < y1; y += SSD_STEP) {
		const int sy = y + dy;
		if (sy < 0 || sy >= h) continue;
		const uint8_t* gr = g + (size_t)y * w;
		const uint8_t* tr = t + (size_t)sy * w;
		for (int x = x0; x < x1; x += SSD_STEP) {
			const int sx = x + dx;
			if (sx < 0 || sx >= w) continue;
			const int d = (int)gr[x] - (int)tr[sx];
			sum += d * d;
			count++;
		}
	}
	return count ? sum / count : INF;
}

int samplesIn(int lo, int hi, int d, int n) {
	int c = 0;
	for (int v = lo; v < hi; v += SSD_STEP)
		if (v + d >= 0 && v + d < n) c++;
	return c;
}

double tileSsdBelow(const uint8_t* g, const uint8_t* t, int w, int h, int x0, int y0, int x1, int y1, int dx, int dy,
                    double count, double best) {
	double sum = 0;
	for (int y = y0; y < y1; y += SSD_STEP) {
		const int sy = y + dy;
		if (sy < 0 || sy >= h) continue;
		const uint8_t* gr = g + (size_t)y * w;
		const uint8_t* tr = t + (size_t)sy * w;
		for (int x = x0; x < x1; x += SSD_STEP) {
			const int sx = x + dx;
			if (sx < 0 || sx >= w) continue;
			const int d = (int)gr[x] - (int)tr[sx];
			sum += d * d;
		}
		if (sum / count >= best) return INF;
	}
	return sum / count;
}

// One row of the inside SSD on contiguous samples. Integer sums: a row is
// at most ceil(tile / 3) samples of at most 65025, so int64 holds a whole
// tile at any tile size, and every partial sum is the JS double's exact
// value (both stay far below 2^53).
template <int N>
inline int64_t rowSsd(const uint8_t* a, const uint8_t* b) {
	int32_t s = 0;
	for (int k = 0; k < N; k++) {
		const int d = (int)a[k] - (int)b[k];
		s += d * d;
	}
	return s;
}
inline int64_t rowSsdN(const uint8_t* a, const uint8_t* b, int n) {
	int64_t s = 0;
	for (int k = 0; k < n; k++) {
		const int d = (int)a[k] - (int)b[k];
		s += d * d;
	}
	return s;
}

// The search for a tile every offset keeps inside the frame
// (tileSsdInside), on per-phase copies of the frame window: plane p holds,
// for each window row, the samples at window x = p, p + 3, ..., so the
// samples the JS reads for offset (dx, dy) are `cols` contiguous bytes of
// plane (dx + R) % 3 from (dx + R) / 3, rows dy + R + 3j. The same samples
// in the same order, so the same sums. The JS stops a candidate as soon
// as its running mean reaches the best; this checks every fourth row
// instead, which changes no result: a stopped candidate is Infinity, a
// finished one is at least the best, and only a candidate strictly below
// it is kept either way.
struct Search {
	int bestDx, bestDy;
	double bestVal;
};

#define VT_INSIDE_BODY                                                                                  \
	Search s{0, 0, INF};                                                                                \
	for (int dy = -R; dy <= R; dy++) {                                                                  \
		for (int dx = -R; dx <= R; dx++) {                                                              \
			const int ph = (dx + R) % 3, off = (dx + R) / 3;                                            \
			const uint8_t* P = planes + (size_t)ph * prow * wrows + off;                                \
			int64_t sum = 0;                                                                            \
			bool out = false;                                                                           \
			for (int j = 0; j < rows; j++) {                                                            \
				const uint8_t* b = P + (size_t)(dy + R + 3 * j) * prow;                                 \
				sum += cols == 32 ? rowSsd<32>(tileG + j * cols, b) : rowSsdN(tileG + j * cols, b, cols); \
				if ((j & 3) == 3 && (double)sum / count >= s.bestVal) {                                 \
					out = true;                                                                         \
					break;                                                                              \
				}                                                                                       \
			}                                                                                           \
			if (out) continue;                                                                          \
			const double v = (double)sum / count;                                                       \
			if (v < s.bestVal) {                                                                        \
				s.bestVal = v;                                                                          \
				s.bestDx = dx;                                                                          \
				s.bestDy = dy;                                                                          \
			}                                                                                           \
		}                                                                                               \
	}                                                                                                   \
	return s;

#define VT_FULL_BODY                                                                                  \
	const int ph = (dx + R) % 3, off = (dx + R) / 3;                                                  \
	const uint8_t* P = planes + (size_t)ph * prow * wrows + off;                                      \
	int64_t sum = 0;                                                                                  \
	for (int j = 0; j < rows; j++) sum += rowSsdN(tileG + j * cols, P + (size_t)(dy + R + 3 * j) * prow, cols); \
	return (double)sum / count;

Search insideBase(const uint8_t* tileG, const uint8_t* planes, int prow, int wrows, int rows, int cols, int R,
                  double count) {
	VT_INSIDE_BODY
}
double fullBase(const uint8_t* tileG, const uint8_t* planes, int prow, int wrows, int rows, int cols, int R, int dx,
                int dy, double count) {
	VT_FULL_BODY
}

#if VT_AVX2_PATH
__attribute__((target("avx2"))) Search insideAvx2(const uint8_t* tileG, const uint8_t* planes, int prow, int wrows,
                                                  int rows, int cols, int R, double count) {
	VT_INSIDE_BODY
}
__attribute__((target("avx2"))) double fullAvx2(const uint8_t* tileG, const uint8_t* planes, int prow, int wrows,
                                                int rows, int cols, int R, int dx, int dy, double count) {
	VT_FULL_BODY
}
// __builtin_cpu_init has run in the module's init
bool haveAvx2() { return __builtin_cpu_supports("avx2"); }
#else
bool haveAvx2() { return false; }
#endif

inline bool useAvx2(const Scratch& sc) { return VT_AVX2_PATH && haveAvx2() && !sc.forceBase; }

double parabolic(double before, double at, double after) {
	if (!std::isfinite(before) || !std::isfinite(at) || !std::isfinite(after)) return 0;
	const double denom = before - 2 * at + after;
	if (std::fabs(denom) < 1e-9) return 0;
	const double shift = (0.5 * (before - after)) / denom;
	return shift > 1 || shift < -1 ? 0 : shift;
}

struct FieldArgs {
	const uint8_t *g, *t, *searchable;
	int width, height, tile, maxOffset, gridW;
	float *fx, *fy;
	uint8_t* valid;
};

void fieldCells(const FieldArgs& a, int cellLo, int cellHi, Scratch& sc) {
	const int tile = a.tile, R = a.maxOffset, w = a.width, h = a.height;
	const bool avx2 = useAvx2(sc);
	for (int cell = cellLo; cell < cellHi; cell++) {
		const int gy = cell / a.gridW;
		const int gx = cell - gy * a.gridW;
		const int y0 = gy * tile, y1 = std::min(h, y0 + tile);
		const int x0 = gx * tile, x1 = std::min(w, x0 + tile);
		if (!a.searchable[cell]) continue;
		const bool inside = x0 - R >= 0 && y0 - R >= 0 && x1 - 1 + R < w && y1 - 1 + R < h;
		const int cols = (x1 - x0 + SSD_STEP - 1) / SSD_STEP;
		const int rows = (y1 - y0 + SSD_STEP - 1) / SSD_STEP;
		const double count = (double)cols * rows;
		Search s{0, 0, INF};
		int prow = 0, wrows = 0;
		if (inside) {
			uint8_t* tg = sc.tileG.need((size_t)rows * cols);
			int k = 0;
			for (int y = y0; y < y1; y += SSD_STEP)
				for (int x = x0; x < x1; x += SSD_STEP) tg[k++] = a.g[(size_t)y * w + x];
			// the frame window [x0 - R, x1 + R) x [y0 - R, y1 + R), by x phase
			const int ww = (x1 - x0) + 2 * R;
			wrows = (y1 - y0) + 2 * R;
			prow = (ww + 2) / 3;
			uint8_t* planes = sc.planes.need((size_t)3 * prow * wrows);
			std::memset(planes, 0, (size_t)3 * prow * wrows);
			for (int p = 0; p < 3; p++) {
				uint8_t* P = planes + (size_t)p * prow * wrows;
				for (int r = 0; r < wrows; r++) {
					const uint8_t* src = a.t + (size_t)(y0 - R + r) * w + (x0 - R);
					uint8_t* dst = P + (size_t)r * prow;
					for (int k2 = 0, x = p; x < ww; x += 3, k2++) dst[k2] = src[x];
				}
			}
#if VT_AVX2_PATH
			if (avx2) s = insideAvx2(tg, planes, prow, wrows, rows, cols, R, count);
			else
#endif
				s = insideBase(tg, planes, prow, wrows, rows, cols, R, count);
		} else {
			for (int dy = -R; dy <= R; dy++) {
				for (int dx = -R; dx <= R; dx++) {
					const int c = samplesIn(x0, x1, dx, w) * samplesIn(y0, y1, dy, h);
					const double v =
						c ? tileSsdBelow(a.g, a.t, w, h, x0, y0, x1, y1, dx, dy, (double)c, s.bestVal) : INF;
					if (v < s.bestVal) {
						s.bestVal = v;
						s.bestDx = dx;
						s.bestDy = dy;
					}
				}
			}
		}
		// a minimum on the edge of the search box is not a minimum
		if (std::abs(s.bestDx) == R || std::abs(s.bestDy) == R) continue;
		auto ssd = [&](int dx, int dy) {
			if (!inside) return tileSsd(a.g, a.t, w, h, x0, y0, x1, y1, dx, dy);
#if VT_AVX2_PATH
			if (avx2) return fullAvx2(sc.tileG.p, sc.planes.p, prow, wrows, rows, cols, R, dx, dy, count);
#endif
			return fullBase(sc.tileG.p, sc.planes.p, prow, wrows, rows, cols, R, dx, dy, count);
		};
		const double sx = parabolic(ssd(s.bestDx - 1, s.bestDy), s.bestVal, ssd(s.bestDx + 1, s.bestDy));
		const double sy = parabolic(ssd(s.bestDx, s.bestDy - 1), s.bestVal, ssd(s.bestDx, s.bestDy + 1));
		// the double sum, then rounded to float as a Float32Array store does
		a.fx[cell] = (float)(s.bestDx + sx);
		a.fy[cell] = (float)(s.bestDy + sy);
		a.valid[cell] = 1;
	}
}

// ------------------------------------------------------------ localApply

struct ApplyArgs {
	uint8_t* out;
	const uint8_t* target;
	int width, height, tile, gridW, gridH;
	const float *fx, *fy;
	// the counts, when asked for
	uint32_t* grey;  // this worker's 256 bins
	const uint8_t* classes;
	uint32_t *histP, *histK;
	int paperBit, inkBit, cell, cellsW;
	bool counted;
};

void applyRows(const ApplyArgs& a, int yLo, int yHi, int xLo, int xHi, ApplyScratch& sc) {
	const int n = xHi - xLo;
	if (n <= 0) return;
	const int gridW = a.gridW, gridH = a.gridH, tile = a.tile, width = a.width;
	int32_t* gx0s = sc.gx0s.need(n);
	int32_t* gx1s = sc.gx1s.need(n);
	double* wxs = sc.wxs.need(n);
	for (int j = 0; j < n; j++) {
		double gxf = (double)(xLo + j) / tile - 0.5;
		if (gxf < 0) gxf = 0;
		else if (gxf > gridW - 1) gxf = gridW - 1;
		const double gx0 = std::floor(gxf);
		gx0s[j] = (int)gx0;
		gx1s[j] = (int)gx0 + 1 < gridW ? (int)gx0 + 1 : (int)gx0;
		wxs[j] = gxf - gx0;
	}
	int32_t* cellOf = nullptr;
	if (a.counted && a.classes) {
		cellOf = sc.cellOf.need(n);
		for (int j = 0; j < n; j++) cellOf[j] = (xLo + j) / a.cell;
	}
	double *topX = sc.topX.need(n), *stepX = sc.stepX.need(n), *topY = sc.topY.need(n), *stepY = sc.stepY.need(n);
	int bandGy0 = -1, bandGy1 = -1;
	const int maxX = width - 1, maxY = a.height - 1;
	for (int y = yLo; y < yHi; y++) {
		double gyf = (double)y / tile - 0.5;
		if (gyf < 0) gyf = 0;
		else if (gyf > gridH - 1) gyf = gridH - 1;
		const int gy0 = (int)std::floor(gyf);
		const int gy1 = gy0 + 1 < gridH ? gy0 + 1 : gy0;
		const double wy = gyf - gy0;
		const size_t row = (size_t)y * width;
		if (gy0 != bandGy0 || gy1 != bandGy1) {
			bandGy0 = gy0;
			bandGy1 = gy1;
			const int r0 = gy0 * gridW, r1 = gy1 * gridW;
			for (int j = 0; j < n; j++) {
				const int i00 = r0 + gx0s[j], i01 = r0 + gx1s[j], i10 = r1 + gx0s[j], i11 = r1 + gx1s[j];
				const double wx = wxs[j];
				const double f00 = a.fx[i00], f01 = a.fx[i01], f10 = a.fx[i10], f11 = a.fx[i11];
				const double top = f00 + (f01 - f00) * wx;
				const double bot = f10 + (f11 - f10) * wx;
				topX[j] = top;
				stepX[j] = bot - top;
				const double v00 = a.fy[i00], v01 = a.fy[i01], v10 = a.fy[i10], v11 = a.fy[i11];
				const double topV = v00 + (v01 - v00) * wx;
				const double botV = v10 + (v11 - v10) * wx;
				topY[j] = topV;
				stepY[j] = botV - topV;
			}
		}
		// the source pixel: the field's displacement rounded as Math.round
		// does, then clamped to the frame (sampleNearest)
		auto source = [&](int j, int x) {
			const double dx = topX[j] + stepX[j] * wy;
			const double dy = topY[j] + stepY[j] * wy;
			const double fsx = x + jsRound(dx), fsy = y + jsRound(dy);
			// a NaN displacement reads past the JS array: undefined, stored as 0
			if (fsx != fsx || fsy != fsy) return (uint8_t)0;
			const int sx = fsx < 0 ? 0 : fsx > maxX ? maxX : (int)fsx;
			const int sy = fsy < 0 ? 0 : fsy > maxY ? maxY : (int)fsy;
			return a.target[(size_t)sy * width + sx];
		};
		if (!a.counted) {
			for (int j = 0, x = xLo; j < n; j++, x++) a.out[row + x] = source(j, x);
			continue;
		}
		const int rowCell = a.classes ? (y / a.cell) * a.cellsW : 0;
		for (int j = 0, x = xLo; j < n; j++, x++) {
			const uint8_t v = source(j, x);
			const size_t i = row + x;
			a.out[i] = v;
			if (a.grey) a.grey[v]++;
			if (a.classes) {
				const uint8_t k = a.classes[i];
				if (k & a.paperBit) a.histP[((size_t)(rowCell + cellOf[j]) << 8) + v]++;
				else if (k & a.inkBit) a.histK[((size_t)(rowCell + cellOf[j]) << 8) + v]++;
			}
		}
	}
}

void applyCells(const ApplyArgs& a, int cellLo, int cellHi, ApplyScratch& sc) {
	if (cellHi <= cellLo) return;
	const int cellsW = a.cellsW, cell = a.cell;
	const int cyLast = (cellHi - 1) / cellsW;
	for (int cy = cellLo / cellsW; cy <= cyLast; cy++) {
		const int first = std::max(cellLo, cy * cellsW) - cy * cellsW;
		const int last = std::min(cellHi, (cy + 1) * cellsW) - cy * cellsW;
		applyRows(a, cy * cell, std::min(a.height, (cy + 1) * cell), first * cell, std::min(a.width, last * cell), sc);
	}
}

// ------------------------------------------------------------ tone compare

struct ToneArgs {
	const uint8_t *classes, *gray;
	const uint8_t *darkest[32], *lightest[32];
	uint32_t levels;
	const uint8_t* tileLevel;
	int tile, slackGridW, width, height, cell, cellsW, measuredBit, blockSize, blocksW;
	const float* spans;
	const int16_t *lo, *hi, *speckLo, *speckHi;
	const float* expected;
	uint8_t *defect, *speck, *map;
	uint32_t *rowSpecks, *blocks;
};

// The comparison's buffers, every index it will make checked first.
// `height` is the rows the comparison covers.
ToneArgs toneArgs(Ctx& c, int height, int chunk) {
	ToneArgs t{};
	t.width = c.dim("width");
	t.height = height;
	const size_t n = (size_t)t.width * height;
	t.classes = c.arr<uint8_t>("classes", n);
	t.gray = c.arr<uint8_t>("gray", n);
	t.levels = c.u8list("darkest", n, t.darkest, 32);
	const uint32_t lights = c.u8list("lightest", n, t.lightest, 32);
	t.tile = c.dim("tile");
	t.slackGridW = c.dim("slackGridW");
	t.cell = c.dim("cell");
	t.cellsW = c.dim("cellsW");
	t.measuredBit = c.whole("measuredBit");
	if (c.err) return t;
	if (!exactGrid(t.cellsW, t.width, t.cell)) c.fail("cellsW");
	if (!exactGrid(t.slackGridW, t.width, t.tile)) c.fail("slackGridW");
	if (lights != t.levels) c.fail("lightest");
	const size_t slack = (size_t)t.slackGridW * ceilDiv(height, t.tile);
	t.tileLevel = c.arr<uint8_t>("tileLevel", slack);
	const size_t cells = (size_t)t.cellsW * ceilDiv(height, t.cell);
	t.spans = c.arr<float>("spans", cells);
	t.lo = c.arr<int16_t>("lo", cells * 256);
	t.hi = c.arr<int16_t>("hi", cells * 256);
	t.speckLo = c.arr<int16_t>("speckLo", cells * 256, false);
	t.speckHi = c.arr<int16_t>("speckHi", cells * 256, t.speckLo != nullptr);
	t.defect = c.arr<uint8_t>("defect", n);
	t.speck = c.arr<uint8_t>("speck", n, false);
	t.map = c.arr<uint8_t>("map", n, false);
	t.expected = c.arr<float>("expected", cells * 256, t.map != nullptr);
	t.rowSpecks = c.arr<uint32_t>("rowSpecks", (size_t)height, false);
	t.blocks = c.arr<uint32_t>("blocks", 0, false);
	if (t.blocks) {
		t.blockSize = c.dim("blockSize");
		t.blocksW = c.dim("blocksW");
		if (!c.err && !exactGrid(t.blocksW, t.width, t.blockSize)) c.fail("blocksW");
		// a block's count is a plain ++, so no two chunks may share a row
		// of blocks: whole rows of them a chunk (lib/compare.js rowChunk)
		if (!c.err && chunk % t.blockSize != 0) c.fail("chunk");
		if (!c.err) t.blocks = c.arr<uint32_t>("blocks", (size_t)t.blocksW * ceilDiv(height, t.blockSize));
	}
	if (c.err) return t;
	// every level a slack tile names must have its pair of windows
	for (size_t i = 0; i < slack; i++)
		if (t.tileLevel[i] >= t.levels) return c.fail("tileLevel"), t;
	return t;
}

void toneCompareRows(const ToneArgs& t, int yLo, int yHi, uint32_t* tally) {
	const bool plain = t.map == nullptr && t.speckLo == nullptr;
	uint32_t count = 0, specks = 0;
	const int width = t.width, cell = t.cell, tile = t.tile;
	for (int y = yLo; y < yHi; y++) {
		const int rowCell = (y / cell) * t.cellsW;
		const int slackRow = (y / tile) * t.slackGridW;
		const size_t row = (size_t)y * width;
		const int blockRow = t.blocks ? (y / t.blockSize) * t.blocksW : 0;
		const uint32_t specksBefore = specks;
		int x0 = 0;
		while (x0 < width) {
			const int cx = x0 / cell, tx = x0 / tile;
			const int x1 = std::min(width, std::min((cx + 1) * cell, (tx + 1) * tile));
			const int c = rowCell + cx;
			const float span = t.spans[c];
			// `if (span)`: neither 0 nor NaN
			if (span != 0.0f && !std::isnan(span)) {
				const int level = t.tileLevel[slackRow + tx];
				const uint8_t* dk = t.darkest[level];
				const uint8_t* lt = t.lightest[level];
				const size_t base = (size_t)c << 8;
				if (plain) {
					const int16_t* lo = t.lo + base;
					const int16_t* hi = t.hi + base;
					for (size_t i = row + x0, end = row + x1; i < end; i++) {
						if (!(t.classes[i] & t.measuredBit)) continue;
						const int v = t.gray[i];
						if (v <= lo[dk[i]] || v >= hi[lt[i]]) {
							t.defect[i] = 1;
							count++;
							if (t.blocks) t.blocks[blockRow + (int)((i - row) / t.blockSize)]++;
							if (t.speck) {
								t.speck[i] = 1;
								specks++;
							}
						}
					}
				} else {
					for (size_t i = row + x0, end = row + x1; i < end; i++) {
						if (!(t.classes[i] & t.measuredBit)) continue;
						const size_t dark = base + dk[i], light = base + lt[i];
						const int v = t.gray[i];
						const bool hit = v <= t.lo[dark] || v >= t.hi[light];
						if (hit) {
							t.defect[i] = 1;
							count++;
							if (t.blocks) t.blocks[blockRow + (int)((i - row) / t.blockSize)]++;
						}
						if (t.speck && (t.speckLo == nullptr ? hit : v <= t.speckLo[dark] || v >= t.speckHi[light])) {
							t.speck[i] = 1;
							specks++;
						}
						if (t.map) {
							const double eLo = t.expected[dark], eHi = t.expected[light];
							if (v < eLo || v > eHi) {
								const double dev = (v < eLo ? eLo - v : v - eHi) / (double)span;
								if (dev >= 1) {
									t.map[i] = 255;
								} else {
									// a Uint8Array store of Math.round's integer: modulo 256,
									// which only a negative span could reach
									const double r = jsRound(dev * 255);
									t.map[i] = (uint8_t)(int64_t)(r < -1e15 ? 0 : r);
								}
							}
						}
					}
				}
			}
			x0 = x1;
		}
		if (t.rowSpecks) t.rowSpecks[y] = specks - specksBefore;
	}
	tally[0] += count;
	tally[1] += specks;
}

// ------------------------------------------------------------ diff

struct DiffArgs {
	const uint8_t *targetFg, *goldenFg, *goldenFgDilatedBackground, *goldenAmbiguous, *targetAmbiguous;
	uint8_t *dilated, *printDefect, *backgroundDefect;
	uint32_t *printBlocks, *backgroundBlocks;
	int width, height, blockSize, radius, margin;
};

void diffRows(const DiffArgs& t, int gyLo, int gyHi, uint64_t* tally, Scratch& sc) {
	const int width = t.width, height = t.height, blockSize = t.blockSize;
	const int r = t.radius;
	const int m = std::min(t.margin, std::min(width / 2, height / 2));
	const int gridW = (width + blockSize - 1) / blockSize;
	const int y0 = gyLo * blockSize;
	const int y1 = std::min(height, gyHi * blockSize);
	if (y0 >= y1) return;
	// the horizontal pass, over this range's rows and r more either side
	const int hy0 = std::max(0, y0 - r);
	const int hy1 = std::min(height, y1 + r);
	const size_t need = (size_t)(hy1 - hy0) * width;
	uint8_t* hrow = sc.hrow.need(need);
	int32_t* cols = sc.cols.need(width);
	const uint8_t* tf = t.targetFg;
	const int enterTo = std::max(0, width - r);
	const int leaveFrom = std::min(width, r + 1);
	for (int y = hy0; y < hy1; y++) {
		const uint8_t* src = tf + (size_t)y * width;
		uint8_t* dst = hrow + (size_t)(y - hy0) * width;
		int c = 0;
		for (int x = 0; x < r && x < width; x++) c += src[x];
		int x = 0;
		const int both = std::min(enterTo, leaveFrom);
		for (; x < both; x++) {
			c += src[x + r];
			dst[x] = c > 0;
		}
		if (enterTo >= leaveFrom) {
			for (; x < enterTo; x++) {
				c += src[x + r] - src[x - r - 1];
				dst[x] = c > 0;
			}
		} else {
			for (; x < leaveFrom; x++) dst[x] = c > 0;
		}
		for (; x < width; x++) {
			c -= src[x - r - 1];
			dst[x] = c > 0;
		}
	}
	// the vertical pass's window for the first row: [y0 - r, y0 + r]
	std::fill(cols, cols + width, 0);
	for (int y = hy0; y < std::min(height, y0 + r + 1); y++) {
		const uint8_t* s = hrow + (size_t)(y - hy0) * width;
		for (int x = 0; x < width; x++) cols[x] += s[x];
	}
	uint64_t prints = 0, backgrounds = 0;
	const bool anyAmb = t.goldenAmbiguous || t.targetAmbiguous;
	for (int y = y0; y < y1; y++) {
		if (y > y0) {
			const int add = y + r, drop = y - r - 1;
			if (add < height && drop >= 0) {
				const uint8_t* A = hrow + (size_t)(add - hy0) * width;
				const uint8_t* D = hrow + (size_t)(drop - hy0) * width;
				for (int x = 0; x < width; x++) cols[x] += (int)A[x] - (int)D[x];
			} else if (add < height) {
				const uint8_t* A = hrow + (size_t)(add - hy0) * width;
				for (int x = 0; x < width; x++) cols[x] += A[x];
			} else if (drop >= 0) {
				const uint8_t* D = hrow + (size_t)(drop - hy0) * width;
				for (int x = 0; x < width; x++) cols[x] -= D[x];
			}
		}
		const size_t row = (size_t)y * width;
		const int cells = (y / blockSize) * gridW;
		// what clearEdge keeps of this row
		const int keepFrom = y < m || y >= height - m ? width : m;
		const int keepTo = width - m;
		const uint8_t* gF = t.goldenFg + row;
		const uint8_t* tF = tf + row;
		const uint8_t* gB = t.goldenFgDilatedBackground + row;
		const uint8_t* gA = t.goldenAmbiguous ? t.goldenAmbiguous + row : nullptr;
		const uint8_t* tA = t.targetAmbiguous ? t.targetAmbiguous + row : nullptr;
		uint8_t* pD = t.printDefect + row;
		uint8_t* bD = t.backgroundDefect + row;
		uint8_t* dl = t.dilated ? t.dilated + row : nullptr;
		for (int gx = 0; gx < gridW; gx++) {
			const int xEnd = std::min(width, (gx + 1) * blockSize);
			uint32_t p = 0, b = 0;
			for (int x = gx * blockSize; x < xEnd; x++) {
				const uint8_t dil = cols[x] > 0;
				if (dl) dl[x] = dil;
				uint8_t dp = gF[x] & ~dil & 1;
				uint8_t db = tF[x] & ~gB[x] & 1;
				const bool amb = (anyAmb && ((gA && gA[x]) || (tA && tA[x]))) || x < keepFrom || x >= keepTo;
				if ((dp | db) && amb) {
					dp = 0;
					db = 0;
				}
				pD[x] = dp;
				bD[x] = db;
				p += dp;
				b += db;
			}
			t.printBlocks[cells + gx] += p;
			t.backgroundBlocks[cells + gx] += b;
			prints += p;
			backgrounds += b;
		}
	}
	tally[0] += prints;
	tally[1] += backgrounds;
}

// ------------------------------------------------------------ exports
// every kernel: (ctx, lo, hi, index), as lib/poolWorker.js's

struct Call {
	Ctx c;
	int index = 0;
};

bool callArgs(napi_env env, napi_callback_info info, Call& out) {
	size_t argc = 4;
	napi_value argv[4];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	napi_valuetype t = napi_undefined;
	if (argc >= 1) napi_typeof(env, argv[0], &t);
	if (t != napi_object) {
		napi_throw_type_error(env, nullptr, "ctx must be an object");
		return false;
	}
	out.c.env = env;
	// a getter that threw: its exception goes back to the caller as is
	if (!out.c.snapshot(argv[0])) return false;
	double d = 0;
	if (argc >= 4 && napi_get_value_double(env, argv[3], &d) == napi_ok && d >= 0 && d < (1 << 20) && d == std::floor(d))
		out.index = (int)d;
	else
		out.c.fail("index");
	return true;
}

// Throws the first failed check: the kernel has claimed and written nothing.
bool rejected(Ctx& c) {
	if (!c.err) return false;
	char msg[96];
	std::snprintf(msg, sizeof msg, "native kernel: bad or missing ctx.%s", c.err);
	napi_throw_range_error(c.env, "ERR_VT_KERNEL_CTX", msg);
	return true;
}

napi_value LocalField(napi_env env, napi_callback_info info) {
	Call k;
	if (!callArgs(env, info, k)) return nullptr;
	Ctx& c = k.c;
	FieldArgs a{};
	Claim cl;
	cl.read(c);
	a.width = c.dim("width");
	a.height = c.dim("height");
	a.tile = c.dim("tile");
	a.maxOffset = c.whole("maxOffset", 0, MAX_OFFSET);
	a.gridW = c.dim("gridW");
	if (rejected(c)) return nullptr;
	if (!exactGrid(a.gridW, a.width, a.tile)) c.fail("gridW");
	if ((size_t)cl.total > (size_t)a.gridW * ceilDiv(a.height, a.tile)) c.fail("total");
	const size_t n = (size_t)a.width * a.height;
	a.g = c.arr<uint8_t>("golden", n);
	a.t = c.arr<uint8_t>("target", n);
	// required: the JS kernel views a missing one as an empty array and
	// skips every tile, which is nothing a caller wants either
	a.searchable = c.arr<uint8_t>("searchable", cl.total);
	a.fx = c.arr<float>("fx", cl.total);
	a.fy = c.arr<float>("fy", cl.total);
	a.valid = c.arr<uint8_t>("valid", cl.total);
	Scratch& sc = scratchOf(env);
	{
		// the most a tile's samples and frame window take
		const size_t mw = std::min(a.tile, a.width), mh = std::min(a.tile, a.height), R = a.maxOffset;
		if (!sc.tileG.need(ceilDiv(mw, SSD_STEP) * ceilDiv(mh, SSD_STEP)) ||
		    !sc.planes.need(3 * ((mw + 2 * R + 2) / 3) * (mh + 2 * R)))
			c.fail("(scratch: out of memory)");
	}
	if (rejected(c)) return nullptr;
	cl.each([&](int lo, int hi) { fieldCells(a, lo, hi, sc); });
	return nullptr;
}

napi_value LocalApply(napi_env env, napi_callback_info info) {
	Call k;
	if (!callArgs(env, info, k)) return nullptr;
	Ctx& c = k.c;
	ApplyArgs a{};
	Claim cl;
	cl.read(c);
	a.width = c.dim("width");
	a.height = c.dim("height");
	a.tile = c.dim("tile");
	a.gridW = c.dim("gridW");
	a.gridH = c.dim("gridH");
	a.cell = c.dim("cell");
	a.cellsW = c.dim("cellsW");
	a.paperBit = c.whole("paperBit");
	a.inkBit = c.whole("inkBit");
	if (rejected(c)) return nullptr;
	if (!exactGrid(a.cellsW, a.width, a.cell)) c.fail("cellsW");
	const size_t cells = (size_t)a.cellsW * ceilDiv(a.height, a.cell);
	if ((size_t)cl.total > cells) c.fail("total");
	const size_t n = (size_t)a.width * a.height;
	a.out = c.arr<uint8_t>("out", n);
	a.target = c.arr<uint8_t>("target", n);
	a.fx = c.arr<float>("fx", (size_t)a.gridW * a.gridH);
	a.fy = c.arr<float>("fy", (size_t)a.gridW * a.gridH);
	a.grey = c.arr<uint32_t>("grey", ((size_t)k.index + 1) * 256, false);
	if (a.grey) a.grey += (size_t)k.index * 256;
	a.classes = c.arr<uint8_t>("classes", n, false);
	a.histP = c.arr<uint32_t>("histP", cells * 256, a.classes != nullptr);
	a.histK = c.arr<uint32_t>("histK", cells * 256, a.classes != nullptr);
	a.counted = a.grey != nullptr || a.classes != nullptr;
	ApplyScratch& sc = scratchOf(env).apply;
	// a call's columns are at most a row
	const size_t w = a.width;
	if (!sc.gx0s.need(w) || !sc.gx1s.need(w) || !sc.cellOf.need(w) || !sc.wxs.need(w) || !sc.topX.need(w) ||
	    !sc.stepX.need(w) || !sc.topY.need(w) || !sc.stepY.need(w))
		c.fail("(scratch: out of memory)");
	if (rejected(c)) return nullptr;
	cl.each([&](int lo, int hi) { applyCells(a, lo, hi, sc); });
	return nullptr;
}

napi_value Binarize(napi_env env, napi_callback_info info) {
	Call k;
	if (!callArgs(env, info, k)) return nullptr;
	Ctx& c = k.c;
	Claim cl;
	cl.read(c);
	const int width = c.dim("width");
	// doubles, compared as the JS compares them: a level need not be whole
	const double level = c.num("level"), margin = c.num("margin");
	if (cl.total > MAX_DIM) c.fail("total");
	if (rejected(c)) return nullptr;
	const size_t n = (size_t)width * cl.total;
	const uint8_t* G = c.arr<uint8_t>("gray", n);
	uint8_t* F = c.arr<uint8_t>("fg", n);
	uint8_t* A = c.arr<uint8_t>("ambiguous", n, false);
	const uint8_t* R = c.arr<uint8_t>("golden", n, false);
	uint32_t* C = R ? c.arr<uint32_t>("counts", ((size_t)k.index + 1) * 3) : nullptr;
	uint32_t* toneCounts = c.arr<uint32_t>("toneCounts", ((size_t)k.index + 1) * 2, false);
	ToneArgs t{};
	if (toneCounts) t = toneArgs(c, cl.total, cl.chunk);
	if (rejected(c)) return nullptr;
	const double floor_ = level - margin, ceil_ = level + margin;
	uint32_t* tally = toneCounts ? toneCounts + (size_t)k.index * 2 : nullptr;
	uint64_t ink = 0, covered = 0, mismatch = 0;
	cl.each([&](int from, int to) {
		const size_t a0 = (size_t)from * width, a1 = (size_t)to * width;
		if (A) {
			for (size_t i = a0; i < a1; i++) {
				const int v = G[i];
				F[i] = v < level;
				A[i] = v >= floor_ && v <= ceil_;
			}
		} else {
			for (size_t i = a0; i < a1; i++) F[i] = G[i] < level;
		}
		if (R) {
			uint32_t in = 0, cov = 0, mis = 0;
			for (size_t i = a0; i < a1; i++) {
				const uint8_t g = R[i], f = F[i];
				in += g;
				cov += g & f;
				mis += f != g;
			}
			ink += in;
			covered += cov;
			mismatch += mis;
		}
		if (tally) {
			// the masks may hold the last frame's pixels
			std::memset(t.defect + a0, 0, a1 - a0);
			if (t.speck) std::memset(t.speck + a0, 0, a1 - a0);
			toneCompareRows(t, from, to, tally);
		}
	});
	if (C) {
		C[(size_t)k.index * 3] = (uint32_t)ink;
		C[(size_t)k.index * 3 + 1] = (uint32_t)covered;
		C[(size_t)k.index * 3 + 2] = (uint32_t)mismatch;
	}
	return nullptr;
}

napi_value ToneCompare(napi_env env, napi_callback_info info) {
	Call k;
	if (!callArgs(env, info, k)) return nullptr;
	Ctx& c = k.c;
	Claim cl;
	cl.read(c);
	const int height = c.dim("height");
	if (rejected(c)) return nullptr;
	if (cl.total > height) c.fail("total");
	uint32_t* toneCounts = c.arr<uint32_t>("toneCounts", ((size_t)k.index + 1) * 2);
	ToneArgs t = toneArgs(c, height, cl.chunk);
	if (rejected(c)) return nullptr;
	uint32_t* tally = toneCounts + (size_t)k.index * 2;
	cl.each([&](int from, int to) {
		const size_t a0 = (size_t)from * t.width, a1 = (size_t)to * t.width;
		std::memset(t.defect + a0, 0, a1 - a0);
		if (t.speck) std::memset(t.speck + a0, 0, a1 - a0);
		toneCompareRows(t, from, to, tally);
	});
	return nullptr;
}

napi_value Diff(napi_env env, napi_callback_info info) {
	Call k;
	if (!callArgs(env, info, k)) return nullptr;
	Ctx& c = k.c;
	DiffArgs a{};
	Claim cl;
	cl.read(c);
	a.width = c.dim("width");
	a.height = c.dim("height");
	a.blockSize = c.dim("blockSize");
	// JS: a radius or margin that is not above 0 is 0
	const double radius = c.num("radius"), margin = c.num("margin");
	a.radius = radius > 0 ? c.dim("radius") : 0;
	if (rejected(c)) return nullptr;
	a.margin = std::min(margin, (double)std::min(a.width / 2, a.height / 2)) > 0 ? c.whole("margin") : 0;
	const size_t gridW = ceilDiv(a.width, a.blockSize), gridH = ceilDiv(a.height, a.blockSize);
	if ((size_t)cl.total > gridH) c.fail("total");
	const size_t n = (size_t)a.width * a.height;
	a.targetFg = c.arr<uint8_t>("targetFg", n);
	a.goldenFg = c.arr<uint8_t>("goldenFg", n);
	a.goldenFgDilatedBackground = c.arr<uint8_t>("goldenFgDilatedBackground", n);
	a.goldenAmbiguous = c.arr<uint8_t>("goldenAmbiguous", n, false);
	a.targetAmbiguous = c.arr<uint8_t>("targetAmbiguous", n, false);
	a.dilated = c.arr<uint8_t>("dilated", n, false);
	a.printDefect = c.arr<uint8_t>("printDefect", n);
	a.backgroundDefect = c.arr<uint8_t>("backgroundDefect", n);
	a.printBlocks = c.arr<uint32_t>("printBlocks", gridW * gridH);
	a.backgroundBlocks = c.arr<uint32_t>("backgroundBlocks", gridW * gridH);
	uint32_t* C = c.arr<uint32_t>("counts", ((size_t)k.index + 1) * 2);
	Scratch& sc = scratchOf(env);
	// a chunk's rows and its halo either side, at most the image
	const size_t rows = std::min((size_t)a.height, (size_t)cl.chunk * a.blockSize + 2 * (size_t)a.radius);
	if (!sc.hrow.need(rows * a.width) || !sc.cols.need(a.width)) c.fail("(scratch: out of memory)");
	if (rejected(c)) return nullptr;
	uint64_t tally[2] = {0, 0};
	cl.each([&](int from, int to) { diffRows(a, from, to, tally, sc); });
	C[(size_t)k.index * 2] = (uint32_t)tally[0];
	C[(size_t)k.index * 2 + 1] = (uint32_t)tally[1];
	return nullptr;
}

// setIsa("base" | "auto"), for the tests: which build of the field search
// this thread runs; returns the one it will ("avx2" or "base")
napi_value SetIsa(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	char buf[16] = {0};
	size_t n = 0;
	napi_valuetype t = napi_undefined;
	if (argc) napi_typeof(env, argv[0], &t);
	if (t == napi_string) {
		napi_get_value_string_utf8(env, argv[0], buf, sizeof buf, &n);
		scratchOf(env).forceBase = std::strcmp(buf, "base") == 0;
	}
	napi_value r;
	napi_create_string_utf8(env, useAvx2(scratchOf(env)) ? "avx2" : "base", NAPI_AUTO_LENGTH, &r);
	return r;
}

void freeScratch(napi_env, void* data, void*) {
	Scratch* s = static_cast<Scratch*>(data);
	s->tileG.release();
	s->planes.release();
	s->hrow.release();
	s->cols.release();
	ApplyScratch& a = s->apply;
	a.gx0s.release();
	a.gx1s.release();
	a.cellOf.release();
	a.wxs.release();
	a.topX.release();
	a.stepX.release();
	a.topY.release();
	a.stepY.release();
	std::free(s);
}

}  // namespace

NAPI_MODULE_INIT() {
#if VT_AVX2_PATH
	__builtin_cpu_init();
#endif
	void* scratch = std::calloc(1, sizeof(Scratch));
	if (!scratch) return nullptr;
	napi_set_instance_data(env, scratch, freeScratch, nullptr);
	struct {
		const char* name;
		napi_callback fn;
	} fns[] = {
		{"localField", LocalField}, {"localApply", LocalApply}, {"binarize", Binarize},
		{"toneCompare", ToneCompare}, {"diff", Diff},           {"setIsa", SetIsa},
	};
	for (auto& f : fns) {
		napi_value v;
		napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &v);
		napi_set_named_property(env, exports, f.name, v);
	}
	napi_value abi;
	napi_create_uint32(env, VT_KERNELS_ABI, &abi);
	napi_set_named_property(env, exports, "abi", abi);
	return exports;
}
