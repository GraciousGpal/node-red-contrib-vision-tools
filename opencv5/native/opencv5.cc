// @graciousstar/opencv5's native half: a few vision ops as a plain N-API
// addon over a minimal static OpenCV 5 (native/build-opencv.sh), wrapped
// by index.js into the op surface of the @rosepetal/node-red-contrib-
// image-tools cpp-bridge, which it replaces.
//
// Every op runs as async work on libuv's pool and returns a promise. No
// pool thread ever touches memory JavaScript can reach:
//   - every argument that is not a buffer is read first, while nothing has
//     been looked at yet (reading an element can run a getter);
//   - every input buffer is then copied into memory this file owns, on the
//     JS thread, before the work is queued - so a caller who transfers,
//     detaches or rewrites its buffer while the op runs changes nothing;
//   - every output is a Buffer created here before the work is queued and
//     handed to the caller only when the op is done, so no caller holds it
//     while a pool thread writes it.
// The copy costs a memcpy of the input into reused staging memory - about
// 1.2 ms for a 10 MB RGB frame on the rig; a caller's buffer detached
// while an op ran used to be a use-after-free. A queued op's copy is
// reported to V8 as external memory until the op completes, so a caller
// queueing many large frames at once is seen by the GC.
//
// Every allocation on the JS thread is owned by something that frees it
// if a later step throws: a C++ exception there becomes a JS error
// (guarded), never a leak.
//
// Encoded images never reach this file: decoding and encoding go through
// sharp (index.js), so OpenCV is built without codecs.
//
// align() is rosepetal image-tools 1.6.4's imageAlign for affine motion,
// the features+ecc pipeline and ORB (ORB 800/1.2/5, Lowe 0.75,
// estimateAffine2D USAC_MAGSAC 5 px, ECC skipped at >= 50 inliers in
// "auto", nearest-neighbour inverse warp), minus its per-frame costs: the
// golden's small copy, ORB features and ECC-normalised copy are made once
// per golden handle (createGolden; index.js keys handles by the golden's
// content), and the frame's working copies live in buffers kept between
// calls on each pool thread.

#include <node_api.h>

#include <opencv2/core.hpp>
#include <opencv2/features.hpp>
#include <opencv2/geometry.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video/tracking.hpp>

#include <chrono>
#include <cmath>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// The contract index.js was written against; it refuses any other.
#define OPENCV5_ABI 3

namespace {

using Clock = std::chrono::steady_clock;
double ms(Clock::time_point a, Clock::time_point b) {
	return std::chrono::duration<double, std::milli>(b - a).count();
}

// limits every op holds to: a side, a whole image, and ECC's iterations
constexpr int kMaxSide = 1 << 16;
constexpr uint64_t kMaxBytes = uint64_t(1) << 30;
constexpr int kMaxIterations = 500;
// ORB's five-level pyramid on a copy smaller than this throws inside
// OpenCV; the alignment copy must be at least this on each side
constexpr int kMinSmallSide = 32;

// ---- N-API plumbing ------------------------------------------------------

napi_value fail(napi_env env, const std::string& msg) {
	napi_throw_error(env, "ERR_OPENCV5_ARGS", msg.c_str());
	return nullptr;
}

bool intOf(napi_env env, napi_value v, int* out) {
	double d;
	if (napi_get_value_double(env, v, &d) != napi_ok || !std::isfinite(d)) return false;
	if (d < -2147483648.0 || d > 2147483647.0 || d != std::floor(d)) return false;
	*out = static_cast<int>(d);
	return true;
}

bool numOf(napi_env env, napi_value v, double* out) {
	return napi_get_value_double(env, v, out) == napi_ok && std::isfinite(*out);
}

void setNum(napi_env env, napi_value o, const char* k, double d) {
	napi_value v;
	napi_create_double(env, d, &v);
	napi_set_named_property(env, o, k, v);
}

void setBool(napi_env env, napi_value o, const char* k, bool b) {
	napi_value v;
	napi_get_boolean(env, b, &v);
	napi_set_named_property(env, o, k, v);
}

// w x h x ch is a sane image size
bool sane(int w, int h, int ch) {
	if (w <= 0 || h <= 0 || ch <= 0 || w > kMaxSide || h > kMaxSide) return false;
	return static_cast<uint64_t>(w) * h * ch <= kMaxBytes;
}

int matType(int ch) {
	return ch == 1 ? CV_8UC1 : ch == 3 ? CV_8UC3 : ch == 4 ? CV_8UC4 : -1;
}

// Test seam (_failNext): the next staging take (kFailTake) or golden
// preparation (kFailGolden) throws std::bad_alloc, as running out of
// memory there would. Nothing sets it but the tests.
constexpr int kFailGolden = 1;
constexpr int kFailTake = 2;
std::atomic<int> failNext{0};

void maybeFail(int kind) {
	int want = kind;
	if (failNext.compare_exchange_strong(want, 0)) throw std::bad_alloc();
}

/**
 * Staging memory for the input copies, reused between ops: a fresh 10 MB
 * allocation per frame costs more in first-touch page faults (~5 ms on the
 * rig) than the copy itself (~1 ms). An op takes a block at least the size
 * it needs and gives it back when it completes; at most kPoolBytes are
 * kept, the rest freed.
 */
class StagingPool {
	std::mutex mu_;
	std::vector<cv::Mat> free_;  // CV_8UC1 rows of 1 x bytes
	size_t kept_ = 0;
	static constexpr size_t kPoolBytes = size_t(64) << 20;

public:
	cv::Mat take(size_t bytes) {
		maybeFail(kFailTake);
		{
			std::lock_guard<std::mutex> lock(mu_);
			size_t best = free_.size();
			for (size_t i = 0; i < free_.size(); i++) {
				const size_t have = free_[i].total();
				if (have >= bytes && (best == free_.size() || have < free_[best].total())) best = i;
			}
			if (best != free_.size()) {
				cv::Mat m = free_[best];
				kept_ -= m.total();
				free_.erase(free_.begin() + static_cast<long>(best));
				return m;
			}
		}
		return cv::Mat(1, static_cast<int>(bytes), CV_8UC1);
	}
	void give(const cv::Mat& block) {
		if (block.empty()) return;
		std::lock_guard<std::mutex> lock(mu_);
		if (kept_ + block.total() > kPoolBytes) return;  // freed with the last header
		kept_ += block.total();
		free_.push_back(block);
	}
};

StagingPool* staging() {
	// one per process, never destroyed: pool threads may still hand blocks
	// back while an environment is torn down
	static StagingPool* pool = new StagingPool();
	return pool;
}

/**
 * A copy of the first w x h x ch bytes of a Uint8Array (a Buffer included)
 * in staging memory this file owns, as an h x w Mat over `block`, or
 * false. Called after every other argument has been read, and nothing JS
 * can run between the look and the copy. The caller gives `block` back.
 */
bool copyIn(napi_env env, napi_value v, int w, int h, int ch, cv::Mat* out, cv::Mat* block) {
	bool is = false;
	if (napi_is_typedarray(env, v, &is) != napi_ok || !is) return false;
	napi_typedarray_type type;
	size_t length;
	void* data;
	napi_value buffer;
	if (napi_get_typedarray_info(env, v, &type, &length, &data, &buffer, nullptr) != napi_ok) return false;
	if (type != napi_uint8_array && type != napi_uint8_clamped_array) return false;
	bool detached = false;
	if (napi_is_detached_arraybuffer(env, buffer, &detached) != napi_ok || detached) return false;
	if (!sane(w, h, ch) || static_cast<uint64_t>(w) * h * ch > length) return false;
	const size_t bytes = static_cast<size_t>(w) * h * ch;
	*block = staging()->take(bytes);
	std::memcpy(block->data, data, bytes);
	*out = cv::Mat(h, w, matType(ch), block->data);
	return true;
}

/** A staging block given back to the pool when this goes out of scope. */
struct Staged {
	cv::Mat block;
	~Staged() { staging()->give(block); }
};

// One async op. execute() runs on the pool and touches only memory this
// file owns; the output Buffers are pinned until the op completes. Made,
// queued and destroyed on the JS thread only (destroy()).
struct Job {
	napi_async_work work = nullptr;
	napi_deferred deferred = nullptr;
	std::vector<napi_ref> pins;
	std::string error;
	double taskMs = 0;
	// the staging block the input was copied into, given back when the op
	// ends, and the bytes of it V8 was told about
	cv::Mat block;
	int64_t staged = 0;
	virtual ~Job() { staging()->give(block); }
	virtual void execute() = 0;
	// the resolved value; null resolves to { timing }
	virtual napi_value result(napi_env env) { return nullptr; }

	/** The input copied into staging memory (copyIn), reported to V8 as
	 * external memory until destroy(). */
	bool input(napi_env env, napi_value v, int w, int h, int ch, cv::Mat* mat) {
		if (!copyIn(env, v, w, h, ch, mat, &block)) return false;
		staged = static_cast<int64_t>(block.total());
		int64_t now;
		napi_adjust_external_memory(env, staged, &now);
		return true;
	}

	napi_value pinned(napi_env env, size_t i) {
		napi_value v;
		napi_get_reference_value(env, pins[i], &v);
		return v;
	}

	/** A new Buffer of `bytes` the op writes through `mat` (h x w x type);
	 * handed to JS only in result(). */
	bool output(napi_env env, int w, int h, int type, cv::Mat* mat) {
		void* data;
		napi_value buf;
		const size_t bytes = static_cast<size_t>(w) * h * CV_ELEM_SIZE(type);
		if (napi_create_buffer(env, bytes, &data, &buf) != napi_ok || !pin(env, buf)) return false;
		*mat = cv::Mat(h, w, type, data);
		return true;
	}

	/** Holds `v` until the op completes. The slot comes first, so a throw
	 * from the vector leaves no reference behind. */
	bool pin(napi_env env, napi_value v) {
		pins.push_back(nullptr);
		return napi_create_reference(env, v, 1, &pins.back()) == napi_ok;
	}
};

/** Unpin a job's buffers, take back what V8 was told of, free it. On
 * the JS thread only. */
void destroy(napi_env env, Job* job) {
	for (napi_ref r : job->pins)
		if (r != nullptr) napi_delete_reference(env, r);
	if (job->staged != 0) {
		int64_t now;
		napi_adjust_external_memory(env, -job->staged, &now);
	}
	if (job->work != nullptr) napi_delete_async_work(env, job->work);
	delete job;
}

/** A job not yet queued: destroyed with this scope, on any return or
 * throw, unless queue() has taken it. */
template <class J>
struct Pending {
	napi_env env;
	J* job;
	Pending(napi_env e, J* j) : env(e), job(j) {}
	Pending(const Pending&) = delete;
	Pending& operator=(const Pending&) = delete;
	~Pending() {
		if (job != nullptr) destroy(env, job);
	}
	J* operator->() { return job; }
	J* release() {
		J* j = job;
		job = nullptr;
		return j;
	}
};

void runJob(napi_env, void* data) {
	auto* job = static_cast<Job*>(data);
	const auto t0 = Clock::now();
	try {
		job->execute();
	} catch (const cv::Exception& e) {
		job->error = e.what();
	} catch (const std::exception& e) {
		job->error = e.what();
	} catch (...) {
		job->error = "unknown native error";
	}
	job->taskMs = ms(t0, Clock::now());
}

void completeJob(napi_env env, napi_status status, void* data) {
	auto* job = static_cast<Job*>(data);
	if (status == napi_ok && job->error.empty()) {
		napi_value v = job->result(env);
		if (v == nullptr) napi_create_object(env, &v);
		napi_value timing;
		napi_create_object(env, &timing);
		setNum(env, timing, "taskMs", job->taskMs);
		napi_set_named_property(env, v, "timing", timing);
		napi_resolve_deferred(env, job->deferred, v);
	} else {
		napi_value msg, err;
		const std::string text = job->error.empty() ? "native op cancelled" : job->error;
		napi_create_string_utf8(env, text.c_str(), text.size(), &msg);
		napi_create_error(env, nullptr, msg, &err);
		napi_reject_deferred(env, job->deferred, err);
	}
	destroy(env, job);
}

/** Queues the job, which it then owns; a promise, or null with a JS error
 * thrown and the job destroyed. */
template <class J>
napi_value queue(napi_env env, Pending<J>& pending, const char* name) {
	napi_value promise, resource;
	Job* job = pending.job;
	if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
	    napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resource) != napi_ok ||
	    napi_create_async_work(env, nullptr, resource, runJob, completeJob, job, &job->work) != napi_ok ||
	    napi_queue_async_work(env, job->work) != napi_ok) {
		// a promise made and never settled is only garbage
		return fail(env, std::string(name) + ": could not queue the work");
	}
	pending.release();
	return promise;
}

template <size_t N>
bool args(napi_env env, napi_callback_info info, napi_value (&a)[N], void** data = nullptr) {
	size_t argc = N;
	napi_get_cb_info(env, info, &argc, a, nullptr, data);
	return argc >= N;  // the usual contract: extra arguments are ignored
}

// { data } for a job with one output
napi_value dataResult(napi_env env, Job* job) {
	napi_value r;
	napi_create_object(env, &r);
	napi_set_named_property(env, r, "data", job->pinned(env, 0));
	return r;
}

// ---- pixel ops -------------------------------------------------------------

// cvtColor(src, w, h, srcCh, code, dstCh) -> { data }
struct CvtColorJob : Job {
	cv::Mat src, dst;
	int code;
	void execute() override {
		cv::Mat out = dst;  // the right shape already, so written in place
		cv::cvtColor(src, out, code);
		if (out.data != dst.data) throw std::runtime_error("cvtColor: the conversion does not give the output asked for");
	}
	napi_value result(napi_env env) override { return dataResult(env, this); }
};

napi_value CvtColor(napi_env env, napi_callback_info info) {
	napi_value a[6];
	if (!args(env, info, a)) return fail(env, "cvtColor(src, w, h, srcCh, code, dstCh)");
	int w, h, sc, code, dc;
	if (!intOf(env, a[1], &w) || !intOf(env, a[2], &h) || !intOf(env, a[3], &sc) || !intOf(env, a[4], &code) ||
	    !intOf(env, a[5], &dc) || matType(sc) < 0 || matType(dc) < 0 || !sane(w, h, std::max(sc, dc)))
		return fail(env, "cvtColor: bad arguments");
	Pending<CvtColorJob> job(env, new CvtColorJob());
	job->code = code;
	if (!job->input(env, a[0], w, h, sc, &job->src) || !job->output(env, w, h, matType(dc), &job->dst))
		return fail(env, "cvtColor: bad arguments");
	return queue(env, job, "opencv5.cvtColor");
}

// resize(src, w, h, ch, dw, dh) -> { data }: INTER_LINEAR, as the bridge
struct ResizeJob : Job {
	cv::Mat src, dst;
	void execute() override {
		cv::Mat out = dst;
		cv::resize(src, out, dst.size(), 0, 0, cv::INTER_LINEAR);
		if (out.data != dst.data) throw std::runtime_error("resize: reallocated its output");
	}
	napi_value result(napi_env env) override { return dataResult(env, this); }
};

napi_value Resize(napi_env env, napi_callback_info info) {
	napi_value a[6];
	if (!args(env, info, a)) return fail(env, "resize(src, w, h, ch, dw, dh)");
	int w, h, ch, dw, dh;
	if (!intOf(env, a[1], &w) || !intOf(env, a[2], &h) || !intOf(env, a[3], &ch) || !intOf(env, a[4], &dw) ||
	    !intOf(env, a[5], &dh) || matType(ch) < 0 || !sane(w, h, ch) || !sane(dw, dh, ch))
		return fail(env, "resize: bad arguments");
	Pending<ResizeJob> job(env, new ResizeJob());
	if (!job->input(env, a[0], w, h, ch, &job->src) || !job->output(env, dw, dh, matType(ch), &job->dst))
		return fail(env, "resize: bad arguments");
	return queue(env, job, "opencv5.resize");
}

// filter(gray, w, h, kind, kernel, intensity) -> { data, blurred?, level? }
// kind 0 = otsu: GaussianBlur, then Otsu; `blurred` is the blurred grey, a
// new buffer like `data` (index.js hands it on; nothing is written back).
// kind 1 = edge: Sobel magnitude, kernel 1-7. The cap is a chosen bound -
// the sizes the callers use, with margin, and the same on both engines -
// not a correctness limit: the 16-bit derivative saturates on a strong
// step at 7 just as at 9.
struct FilterJob : Job {
	cv::Mat gray, dst, blurred;
	int kind, kernel;
	double intensity;
	double level = 0;
	void execute() override {
		if (kind == 0) {
			cv::Mat b = blurred;
			cv::GaussianBlur(gray, b, cv::Size(kernel, kernel), 0, 0, cv::BORDER_DEFAULT);
			if (b.data != blurred.data) throw std::runtime_error("filter: reallocated its output");
			cv::Mat out = dst;
			level = cv::threshold(blurred, out, 0, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);
			if (out.data != dst.data) throw std::runtime_error("filter: reallocated its output");
		} else {
			cv::Mat gx, gy, ax, ay;
			cv::Sobel(gray, gx, CV_16S, 1, 0, kernel);
			cv::Sobel(gray, gy, CV_16S, 0, 1, kernel);
			cv::convertScaleAbs(gx, ax);
			cv::convertScaleAbs(gy, ay);
			cv::Mat out = dst;
			cv::addWeighted(ax, 0.5 * intensity, ay, 0.5 * intensity, 0, out);
			if (out.data != dst.data) throw std::runtime_error("filter: reallocated its output");
		}
	}
	napi_value result(napi_env env) override {
		napi_value r = dataResult(env, this);
		if (kind == 0) {
			setNum(env, r, "level", level);
			napi_set_named_property(env, r, "blurred", pinned(env, 1));
		}
		return r;
	}
};

napi_value Filter(napi_env env, napi_callback_info info) {
	napi_value a[6];
	if (!args(env, info, a)) return fail(env, "filter(gray, w, h, kind, kernel, intensity)");
	int w, h, kind, kernel;
	double intensity;
	if (!intOf(env, a[1], &w) || !intOf(env, a[2], &h) || !intOf(env, a[3], &kind) || !intOf(env, a[4], &kernel) ||
	    !numOf(env, a[5], &intensity) || (kind != 0 && kind != 1) || kernel < 1 || kernel % 2 == 0 ||
	    kernel > (kind == 0 ? 31 : 7) || !sane(w, h, 1))
		return fail(env, "filter: bad arguments");
	Pending<FilterJob> job(env, new FilterJob());
	job->kind = kind;
	job->kernel = kernel;
	job->intensity = intensity;
	if (!job->input(env, a[0], w, h, 1, &job->gray) || !job->output(env, w, h, CV_8UC1, &job->dst) ||
	    (kind == 0 && !job->output(env, w, h, CV_8UC1, &job->blurred)))
		return fail(env, "filter: bad arguments");
	return queue(env, job, "opencv5.filter");
}

// rotate(src, w, h, ch, dw, dh, angleDeg, p0, p1, p2, p3) -> { data }: the
// bridge's rotate - getRotationMatrix2D about the source centre, shifted
// to the centre of the dw x dh canvas the caller sized, INTER_LINEAR,
// BORDER_CONSTANT in the pad colour (four numbers, so reading it runs no JS)
struct RotateJob : Job {
	cv::Mat src, dst;
	double angle;
	cv::Scalar pad;
	void execute() override {
		cv::Mat m = cv::getRotationMatrix2D(cv::Point2f(src.cols / 2.0f, src.rows / 2.0f), angle, 1.0);
		m.at<double>(0, 2) += dst.cols / 2.0 - src.cols / 2.0;
		m.at<double>(1, 2) += dst.rows / 2.0 - src.rows / 2.0;
		cv::Mat out = dst;
		cv::warpAffine(src, out, m, dst.size(), cv::INTER_LINEAR, cv::BORDER_CONSTANT, pad);
		if (out.data != dst.data) throw std::runtime_error("rotate: reallocated its output");
	}
	napi_value result(napi_env env) override { return dataResult(env, this); }
};

napi_value Rotate(napi_env env, napi_callback_info info) {
	napi_value a[11];
	if (!args(env, info, a)) return fail(env, "rotate(src, w, h, ch, dw, dh, angleDeg, p0, p1, p2, p3)");
	int w, h, ch, dw, dh;
	double angle, p[4];
	if (!intOf(env, a[1], &w) || !intOf(env, a[2], &h) || !intOf(env, a[3], &ch) || !intOf(env, a[4], &dw) ||
	    !intOf(env, a[5], &dh) || !numOf(env, a[6], &angle) || !numOf(env, a[7], &p[0]) || !numOf(env, a[8], &p[1]) ||
	    !numOf(env, a[9], &p[2]) || !numOf(env, a[10], &p[3]) || matType(ch) < 0 || !sane(w, h, ch) ||
	    !sane(dw, dh, ch))
		return fail(env, "rotate: bad arguments");
	Pending<RotateJob> job(env, new RotateJob());
	job->angle = angle;
	job->pad = cv::Scalar(p[0], p[1], p[2], p[3]);
	if (!job->input(env, a[0], w, h, ch, &job->src) || !job->output(env, dw, dh, matType(ch), &job->dst))
		return fail(env, "rotate: bad arguments");
	return queue(env, job, "opencv5.rotate");
}

// contentKey(bytes) -> 16 hex digits: a 64-bit hash of every byte, for
// index.js to find a golden by what it holds (about 0.2 ms for 3 MB). A
// fast hash, not a cryptographic one - two different images can be made
// to share a key - so a key is only where to look: sameGolden() compares
// the bytes before a golden is reused.
napi_value ContentKey(napi_env env, napi_callback_info info) {
	napi_value a[1];
	if (!args(env, info, a)) return fail(env, "contentKey(bytes)");
	bool is = false;
	napi_typedarray_type type;
	size_t length;
	void* data;
	napi_value buffer;
	if (napi_is_typedarray(env, a[0], &is) != napi_ok || !is ||
	    napi_get_typedarray_info(env, a[0], &type, &length, &data, &buffer, nullptr) != napi_ok ||
	    (type != napi_uint8_array && type != napi_uint8_clamped_array))
		return fail(env, "contentKey: not a Uint8Array");
	const auto* p = static_cast<const uint8_t*>(data);
	// four interleaved multiply-xorshift lanes over 8-byte words, then the tail
	uint64_t lane[4] = {0x9e3779b97f4a7c15ULL, 0xc2b2ae3d27d4eb4fULL, 0x165667b19e3779f9ULL, 0x27d4eb2f165667c5ULL};
	size_t i = 0;
	for (; i + 32 <= length; i += 32) {
		for (int k = 0; k < 4; k++) {
			uint64_t w;
			std::memcpy(&w, p + i + 8 * k, 8);
			lane[k] = (lane[k] ^ w) * 0x9e3779b97f4a7c15ULL;
			lane[k] ^= lane[k] >> 29;
		}
	}
	uint64_t h = length * 0xff51afd7ed558ccdULL;
	for (int k = 0; k < 4; k++) h = (h ^ lane[k]) * 0xc4ceb9fe1a85ec53ULL, h ^= h >> 32;
	for (; i < length; i++) h = (h ^ p[i]) * 0x100000001b3ULL;
	h ^= h >> 33;
	char hex[17];
	std::snprintf(hex, sizeof hex, "%016llx", static_cast<unsigned long long>(h));
	napi_value r;
	napi_create_string_utf8(env, hex, 16, &r);
	return r;
}

// ---- alignment -------------------------------------------------------------

cv::Ptr<cv::ORB> orb() { return cv::ORB::create(800, 1.2f, 5); }

// rosepetal's ECC input: float, zero mean, unit deviation; false when flat
bool eccPrepare(const cv::Mat& src, cv::Mat& dst) {
	constexpr double eps = 1e-6;
	src.convertTo(dst, CV_32F);
	cv::Scalar mean, stddev;
	cv::meanStdDev(dst, mean, stddev);
	dst -= static_cast<float>(mean[0]);
	const double s = stddev[0];
	if (!std::isfinite(s) || s <= eps) return false;
	dst *= static_cast<float>(1.0 / s);
	return true;
}

cv::Size smallSize(int w, int h, double scale) {
	return cv::Size(std::max(1, static_cast<int>(std::round(w * scale))), std::max(1, static_cast<int>(std::round(h * scale))));
}

void smallOf(const cv::Mat& full, double scale, cv::Mat& out) { cv::resize(full, out, smallSize(full.cols, full.rows, scale)); }

const napi_type_tag kGoldenTag = {0x6f70656e63763567ULL, 0x676f6c64656e3031ULL};

// One golden at one alignment scale. Its derived data is made on the pool,
// by whichever align gets there first, and read-only after that.
//
// An OpenCV error making it is a property of the image and is kept: every
// align against this golden rejects with it. Anything else - running out
// of memory, in OpenCV (StsNoMem) or outside it - says nothing about the
// image, so it is not kept: that align rejects, the partial state is
// dropped, and the next align tries again. (A mutex, not std::call_once:
// an exception thrown through call_once terminates the process on musl.)
struct Golden {
	cv::Mat gray;  // our own copy
	double scale;
	std::mutex mu;
	bool ready = false;
	cv::Mat small, des, prepared;
	std::vector<cv::KeyPoint> kp;
	bool preparedOk = false;
	std::string initError;
	// what V8 was told this holds outside its heap: the grey, the small
	// copy, its float ECC copy and ORB's 800 x 32-byte descriptors
	int64_t accounted = 0;

	void init() {
		std::lock_guard<std::mutex> lock(mu);
		if (!ready) {
			try {
				maybeFail(kFailGolden);
				smallOf(gray, scale, small);
				orb()->detectAndCompute(small, cv::noArray(), kp, des);
				preparedOk = eccPrepare(small, prepared);
				ready = true;
			} catch (const cv::Exception& e) {
				if (e.code == cv::Error::StsNoMem) {
					drop();
					throw;
				}
				initError = std::string("the golden's features: ") + e.what();
				ready = true;
			} catch (...) {
				drop();
				throw;
			}
		}
		if (!initError.empty()) throw std::runtime_error(initError);
	}

	// the derived state, back to what a fresh golden has
	void drop() {
		small.release();
		des.release();
		prepared.release();
		kp.clear();
		preparedOk = false;
	}
};

void deleteGolden(napi_env env, void* data, void*) {
	auto* golden = static_cast<Golden*>(data);
	int64_t now;
	napi_adjust_external_memory(env, -golden->accounted, &now);
	delete golden;
}

// createGolden(gray, w, h, scale) -> handle
napi_value CreateGolden(napi_env env, napi_callback_info info) {
	napi_value a[4];
	if (!args(env, info, a)) return fail(env, "createGolden(gray, w, h, scale)");
	int w, h;
	double scale;
	if (!intOf(env, a[1], &w) || !intOf(env, a[2], &h) || !numOf(env, a[3], &scale) || !(scale > 0 && scale <= 1) ||
	    !sane(w, h, 1))
		return fail(env, "createGolden: bad arguments");
	const cv::Size s = smallSize(w, h, scale);
	if (s.width < kMinSmallSide || s.height < kMinSmallSide) {
		return fail(env, "createGolden: the alignment copy would be " + std::to_string(s.width) + "x" +
		                     std::to_string(s.height) + " px; it needs at least " + std::to_string(kMinSmallSide) +
		                     " a side (a larger scale or golden)");
	}
	// owned until the handle owns it: a throw (clone, take) frees both
	std::unique_ptr<Golden> golden(new Golden());
	golden->scale = scale;
	cv::Mat copy;
	Staged staged;
	if (!copyIn(env, a[0], w, h, 1, &copy, &staged.block)) return fail(env, "createGolden: bad arguments");
	golden->gray = copy.clone();  // its own memory, for as long as it lives
	napi_value handle;
	if (napi_create_external(env, golden.get(), deleteGolden, nullptr, &handle) != napi_ok)
		return fail(env, "createGolden: no handle");
	Golden* g = golden.release();  // deleteGolden's now
	napi_type_tag_object(env, handle, &kGoldenTag);
	g->accounted = static_cast<int64_t>(w) * h + static_cast<int64_t>(s.width) * s.height * 5 + 800 * 32;
	int64_t now;
	napi_adjust_external_memory(env, g->accounted, &now);
	return handle;
}

/** The golden behind a handle made here, or null. */
Golden* goldenOf(napi_env env, napi_value v) {
	napi_valuetype t;
	bool tagged = false;
	void* ptr = nullptr;
	if (napi_typeof(env, v, &t) != napi_ok || t != napi_external ||
	    napi_check_object_type_tag(env, v, &kGoldenTag, &tagged) != napi_ok || !tagged ||
	    napi_get_value_external(env, v, &ptr) != napi_ok)
		return nullptr;
	return static_cast<Golden*>(ptr);
}

// sameGolden(handle, gray, w, h) -> true when the golden was made from
// exactly these w x h bytes: index.js's check before it reuses a golden
// found by contentKey (a memcmp, about 0.3 ms for 3 MB)
napi_value SameGolden(napi_env env, napi_callback_info info) {
	napi_value a[4];
	if (!args(env, info, a)) return fail(env, "sameGolden(handle, gray, w, h)");
	Golden* golden = goldenOf(env, a[0]);
	int w, h;
	if (golden == nullptr || !intOf(env, a[2], &w) || !intOf(env, a[3], &h)) return fail(env, "sameGolden: bad arguments");
	bool same = false;
	bool is = false;
	napi_typedarray_type type;
	size_t length;
	void* data;
	napi_value buffer;
	bool detached = true;
	if (w == golden->gray.cols && h == golden->gray.rows && napi_is_typedarray(env, a[1], &is) == napi_ok && is &&
	    napi_get_typedarray_info(env, a[1], &type, &length, &data, &buffer, nullptr) == napi_ok &&
	    (type == napi_uint8_array || type == napi_uint8_clamped_array) &&
	    napi_is_detached_arraybuffer(env, buffer, &detached) == napi_ok && !detached &&
	    length >= static_cast<size_t>(w) * h) {
		same = std::memcmp(data, golden->gray.data, static_cast<size_t>(w) * h) == 0;
	}
	napi_value r;
	napi_get_boolean(env, same, &r);
	return r;
}

// What one pool thread keeps between frames, so a frame's working copies
// are not fresh pages every time: the frame at golden size (only when the
// frame is not that size already), its small copy and that copy as float.
// Bounded by the largest golden aligned on that thread - for a 1475x2125
// golden at scale 0.35, about 3.1 + 0.4 + 1.5 MB - times libuv's pool
// (UV_THREADPOOL_SIZE, 4 by default), and held for the life of the
// process; a later golden of another size reallocates them, not adds.
thread_local cv::Mat tlResized, tlSmall, tlPrepared;

struct AlignJob : Job {
	Golden* golden;
	cv::Mat target, out;
	int iterations;
	double eps;
	bool eccAlways;
	// results
	bool success = true, ranEcc = false;
	int inliers = 0;
	cv::Mat M;
	double stage[8] = {};

	void execute() override {
		golden->init();
		const Golden& g = *golden;
		const auto t0 = Clock::now();
		cv::Mat resized;
		if (target.size() != g.gray.size()) {
			cv::resize(target, tlResized, g.gray.size());
			resized = tlResized;
		} else {
			resized = target;
		}
		const auto t1 = Clock::now();
		smallOf(resized, g.scale, tlSmall);
		const auto t2 = Clock::now();
		std::vector<cv::KeyPoint> kp2;
		cv::Mat des2;
		orb()->detectAndCompute(tlSmall, cv::noArray(), kp2, des2);
		const auto t3 = Clock::now();

		cv::Mat seed;
		bool haveSeed = false;
		auto t4 = t3, t5 = t3;
		if (!g.des.empty() && !des2.empty() && g.kp.size() >= 10 && kp2.size() >= 10) {
			cv::BFMatcher matcher(cv::NORM_HAMMING, false);
			std::vector<std::vector<cv::DMatch>> knn;
			matcher.knnMatch(g.des, des2, knn, 2);
			std::vector<cv::Point2f> src, dst;
			for (const auto& pair : knn) {
				if (pair.size() < 2) continue;
				if (pair[0].distance < 0.75f * pair[1].distance) {
					src.push_back(g.kp[pair[0].queryIdx].pt);
					dst.push_back(kp2[pair[0].trainIdx].pt);
				}
			}
			t4 = Clock::now();
			if (src.size() >= 12) {
				cv::Mat mask;
				cv::Mat A = cv::estimateAffine2D(src, dst, mask, cv::USAC_MAGSAC, 5.0);
				if (!A.empty()) {
					A.convertTo(seed, CV_32F);
					inliers = cv::countNonZero(mask);
					haveSeed = true;
				}
			}
			t5 = Clock::now();
		}

		auto t6 = t5;
		if (haveSeed && !eccAlways && inliers >= 50) {
			M = seed.clone();
		} else {
			ranEcc = true;
			cv::Mat refP = g.prepared;
			const bool tgtOk = eccPrepare(tlSmall, tlPrepared);
			cv::Mat tgtP = tlPrepared;
			if (!g.preparedOk || !tgtOk) {
				refP = refP.clone();
				tgtP = tgtP.clone();
				cv::normalize(refP, refP, 0.0f, 1.0f, cv::NORM_MINMAX);
				cv::normalize(tgtP, tgtP, 0.0f, 1.0f, cv::NORM_MINMAX);
			}
			M = haveSeed ? seed.clone() : cv::Mat::eye(2, 3, CV_32F);
			bool eccOk = false;
			try {
				const double corr = cv::findTransformECC(
				    refP, tgtP, M, cv::MOTION_AFFINE,
				    cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, iterations, eps));
				eccOk = corr > 0.1;
			} catch (const cv::Exception&) {
				eccOk = false;
			}
			if (!eccOk) {
				if (haveSeed) M = seed.clone();
				else success = false;
			}
			t6 = Clock::now();
		}
		if (success) {
			const float s = static_cast<float>(g.scale);
			M.at<float>(0, 2) /= s;
			M.at<float>(1, 2) /= s;
			cv::Mat dst = out;
			cv::warpAffine(resized, dst, M, out.size(), cv::INTER_NEAREST | cv::WARP_INVERSE_MAP);
			if (dst.data != out.data) throw std::runtime_error("align: reallocated its output");
		} else {
			resized.copyTo(out);
		}
		const auto t7 = Clock::now();
		const Clock::time_point marks[] = {t0, t1, t2, t3, t4, t5, t6, t7};
		for (int i = 0; i < 7; i++) stage[i] = ms(marks[i], marks[i + 1]);
		stage[7] = ms(t0, t7);
	}

	napi_value result(napi_env env) override {
		napi_value r = dataResult(env, this), matrix, stages;
		setBool(env, r, "success", success);
		setBool(env, r, "ecc", ranEcc);
		setNum(env, r, "inliers", inliers);
		napi_create_array_with_length(env, success ? 6 : 0, &matrix);
		if (success) {
			for (int i = 0; i < 6; i++) {
				napi_value v;
				napi_create_double(env, M.at<float>(i / 3, i % 3), &v);
				napi_set_element(env, matrix, i, v);
			}
		}
		napi_set_named_property(env, r, "matrix", matrix);
		napi_create_object(env, &stages);
		const char* names[] = {"resize", "small", "orb", "match", "ransac", "ecc", "warp", "total"};
		for (int i = 0; i < 8; i++) setNum(env, stages, names[i], stage[i]);
		napi_set_named_property(env, r, "stages", stages);
		return r;
	}
};

// align(golden, target, tW, tH, iterations, eps, eccAlways) -> { data, ... }
napi_value Align(napi_env env, napi_callback_info info) {
	napi_value a[7];
	if (!args(env, info, a)) return fail(env, "align(golden, target, tW, tH, iterations, eps, eccAlways)");
	Golden* golden = goldenOf(env, a[0]);
	if (golden == nullptr) return fail(env, "align: not a golden handle");
	int tW, tH, iterations;
	double eps;
	bool eccAlways = false;
	if (!intOf(env, a[2], &tW) || !intOf(env, a[3], &tH) || !intOf(env, a[4], &iterations) ||
	    !numOf(env, a[5], &eps) || napi_get_value_bool(env, a[6], &eccAlways) != napi_ok || iterations < 1 ||
	    iterations > kMaxIterations || !(eps > 0) || !sane(tW, tH, 1))
		return fail(env, "align: bad arguments (iterations 1-" + std::to_string(kMaxIterations) + ")");
	Pending<AlignJob> job(env, new AlignJob());
	job->golden = golden;
	job->iterations = iterations;
	job->eps = eps;
	job->eccAlways = eccAlways;
	if (!job->input(env, a[1], tW, tH, 1, &job->target) ||
	    !job->output(env, golden->gray.cols, golden->gray.rows, CV_8UC1, &job->out) || !job->pin(env, a[0]))
		return fail(env, "align: bad arguments");
	// the pin keeps the golden alive while the work runs
	return queue(env, job, "opencv5.align");
}

// _failNext(kind): the tests' fault injection (see maybeFail)
napi_value FailNext(napi_env env, napi_callback_info info) {
	napi_value a[1];
	int kind;
	if (!args(env, info, a) || !intOf(env, a[0], &kind) || (kind != kFailGolden && kind != kFailTake))
		return fail(env, "_failNext(1 golden | 2 staging)");
	failNext.store(kind);
	return nullptr;
}

// _externalMemory() -> what V8 counts as external memory, which includes
// what this file reported (Node 24's process.memoryUsage().external does
// not show napi_adjust_external_memory's share); for the tests
napi_value ExternalMemory(napi_env env, napi_callback_info) {
	int64_t now = 0;
	napi_adjust_external_memory(env, 0, &now);
	napi_value r;
	napi_create_double(env, static_cast<double>(now), &r);
	return r;
}

napi_value BuildInfo(napi_env env, napi_callback_info) {
	napi_value r;
	const std::string s = cv::getBuildInformation();
	napi_create_string_utf8(env, s.c_str(), s.size(), &r);
	return r;
}

// A C++ exception reaching N-API would terminate the process (Node-RED
// with it): an allocation that fails on the JS thread - a golden's copy,
// a job - becomes a JS error instead.
template <napi_callback F>
napi_value guarded(napi_env env, napi_callback_info info) {
	try {
		return F(env, info);
	} catch (const std::exception& e) {
		napi_throw_error(env, "ERR_OPENCV5", e.what());
	} catch (...) {
		napi_throw_error(env, "ERR_OPENCV5", "unknown native error");
	}
	return nullptr;
}

}  // namespace

NAPI_MODULE_INIT() {
	struct {
		const char* name;
		napi_callback fn;
	} fns[] = {
	    {"cvtColor", guarded<CvtColor>},         {"resize", guarded<Resize>}, {"filter", guarded<Filter>},
	    {"rotate", guarded<Rotate>},             {"createGolden", guarded<CreateGolden>},
	    {"align", guarded<Align>},               {"contentKey", guarded<ContentKey>},
	    {"sameGolden", guarded<SameGolden>},     {"_failNext", guarded<FailNext>},
	    {"_externalMemory", guarded<ExternalMemory>},
	    {"buildInfo", guarded<BuildInfo>},
	};
	for (const auto& f : fns) {
		napi_value v;
		napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &v);
		napi_set_named_property(env, exports, f.name, v);
	}
	napi_value v;
	napi_create_int32(env, OPENCV5_ABI, &v);
	napi_set_named_property(env, exports, "abi", v);
	napi_create_int32(env, kMaxIterations, &v);
	napi_set_named_property(env, exports, "maxIterations", v);
	napi_create_int32(env, kMinSmallSide, &v);
	napi_set_named_property(env, exports, "minAlignSide", v);
	napi_create_string_utf8(env, CV_VERSION, NAPI_AUTO_LENGTH, &v);
	napi_set_named_property(env, exports, "opencv", v);
	// COLOR_* codes for index.js, so it never hard-codes OpenCV's enum
	napi_value codes;
	napi_create_object(env, &codes);
	struct {
		const char* name;
		int code;
	} colors[] = {
	    {"GRAY>BGR", cv::COLOR_GRAY2BGR},   {"GRAY>RGB", cv::COLOR_GRAY2RGB},   {"GRAY>BGRA", cv::COLOR_GRAY2BGRA},
	    {"GRAY>RGBA", cv::COLOR_GRAY2RGBA}, {"BGR>GRAY", cv::COLOR_BGR2GRAY},   {"BGR>RGB", cv::COLOR_BGR2RGB},
	    {"BGR>BGRA", cv::COLOR_BGR2BGRA},   {"BGR>RGBA", cv::COLOR_BGR2RGBA},   {"RGB>GRAY", cv::COLOR_RGB2GRAY},
	    {"RGB>BGR", cv::COLOR_RGB2BGR},     {"RGB>BGRA", cv::COLOR_RGB2BGRA},   {"RGB>RGBA", cv::COLOR_RGB2RGBA},
	    {"BGRA>GRAY", cv::COLOR_BGRA2GRAY}, {"BGRA>BGR", cv::COLOR_BGRA2BGR},   {"BGRA>RGB", cv::COLOR_BGRA2RGB},
	    {"BGRA>RGBA", cv::COLOR_BGRA2RGBA}, {"RGBA>GRAY", cv::COLOR_RGBA2GRAY}, {"RGBA>BGR", cv::COLOR_RGBA2BGR},
	    {"RGBA>RGB", cv::COLOR_RGBA2RGB},   {"RGBA>BGRA", cv::COLOR_RGBA2BGRA},
	};
	for (const auto& c : colors) {
		napi_create_int32(env, c.code, &v);
		napi_set_named_property(env, codes, c.name, v);
	}
	napi_set_named_property(env, exports, "colorCodes", codes);
	return exports;
}
