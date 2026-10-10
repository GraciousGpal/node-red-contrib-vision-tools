// @graciousstar/opencv5's native half: a few vision ops as a plain N-API
// addon over a minimal static OpenCV 5 (native/build-opencv.sh), wrapped
// by index.js into the op surface of the @rosepetal/node-red-contrib-
// image-tools cpp-bridge, which it replaces.
//
// Every op runs as async work on libuv's pool and returns a promise.
// Buffers are the caller's: an op reads its input and writes into an
// output the caller sized - index.js does the size arithmetic - and
// checks every length against the dimensions before anything runs.
// Encoded images never reach this file: decoding and encoding go through
// sharp (index.js), so OpenCV is built without codecs.
//
// align() is rosepetal image-tools 1.6.4's imageAlign for affine motion,
// the features+ecc pipeline and ORB (ORB 800/1.2/5, Lowe 0.75,
// estimateAffine2D USAC_MAGSAC 5 px, ECC skipped at >= 50 inliers in
// "auto", nearest-neighbour inverse warp), minus its per-frame costs:
//   - the golden's small copy, ORB features and ECC-normalised copy are
//     made once per golden handle (createGolden); rosepetal re-finds them
//     every call through an FNV hash of 768 of the image's bytes, which
//     two goldens can share;
//   - the frame's golden-sized resize and small copies live in buffers
//     kept between calls on each pool thread;
//   - the warp writes straight into the caller's output.

#include <node_api.h>

#include <opencv2/core.hpp>
#include <opencv2/features.hpp>
#include <opencv2/geometry.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video/tracking.hpp>

#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

// The contract index.js was written against; it refuses any other.
#define OPENCV5_ABI 1

namespace {

using Clock = std::chrono::steady_clock;
double ms(Clock::time_point a, Clock::time_point b) {
	return std::chrono::duration<double, std::milli>(b - a).count();
}

// ---- N-API plumbing ------------------------------------------------------

struct View {
	uint8_t* data = nullptr;
	size_t bytes = 0;
};

// A typed array's bytes (Buffer included), or false.
bool viewOf(napi_env env, napi_value v, View* out) {
	bool is = false;
	if (napi_is_typedarray(env, v, &is) != napi_ok || !is) return false;
	napi_typedarray_type type;
	size_t length;
	void* data;
	napi_value buffer;
	if (napi_get_typedarray_info(env, v, &type, &length, &data, &buffer, nullptr) != napi_ok) return false;
	if (type != napi_uint8_array && type != napi_uint8_clamped_array) return false;
	// a detached store has no bytes to read; a resizable one could shrink
	// under the pool thread, and index.js refuses those (N-API cannot
	// tell). A store the caller transfers or shrinks while an op runs is
	// outside the contract, as with every async op over a caller's buffer.
	bool detached = false;
	if (napi_is_detached_arraybuffer(env, buffer, &detached) != napi_ok || detached) return false;
	out->data = static_cast<uint8_t*>(data);
	out->bytes = length;
	return true;
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

napi_value fail(napi_env env, const std::string& msg) {
	napi_throw_error(env, "ERR_OPENCV5_ARGS", msg.c_str());
	return nullptr;
}

// width * height * channels fits in `bytes`, all positive and sane
bool fits(int w, int h, int ch, size_t bytes) {
	if (w <= 0 || h <= 0 || ch <= 0 || w > 1 << 16 || h > 1 << 16) return false;
	return static_cast<uint64_t>(w) * h * ch <= bytes;
}

int matType(int ch) {
	return ch == 1 ? CV_8UC1 : ch == 3 ? CV_8UC3 : ch == 4 ? CV_8UC4 : -1;
}

// One async op: the JS values it touches are pinned by reference until it
// completes; execute() runs on the pool and must not touch napi.
struct Job {
	napi_async_work work = nullptr;
	napi_deferred deferred = nullptr;
	std::vector<napi_ref> pins;
	std::string error;
	Clock::time_point queued = Clock::now();
	double taskMs = 0;
	virtual ~Job() = default;
	virtual void execute() = 0;
	// the resolved value; null resolves to { taskMs }
	virtual napi_value result(napi_env env) { return nullptr; }

	void pin(napi_env env, napi_value v) {
		napi_ref r;
		napi_create_reference(env, v, 1, &r);
		pins.push_back(r);
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
	for (napi_ref r : job->pins) napi_delete_reference(env, r);
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
	napi_delete_async_work(env, job->work);
	delete job;
}

napi_value queue(napi_env env, Job* job, const char* name) {
	napi_value promise, resource;
	napi_create_promise(env, &job->deferred, &promise);
	napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resource);
	napi_create_async_work(env, nullptr, resource, runJob, completeJob, job, &job->work);
	napi_queue_async_work(env, job->work);
	return promise;
}

template <size_t N>
bool args(napi_env env, napi_callback_info info, napi_value (&a)[N], void** data = nullptr) {
	size_t argc = N;
	napi_get_cb_info(env, info, &argc, a, nullptr, data);
	return argc >= N;  // the usual contract: extra arguments are ignored
}

// ---- pixel ops -------------------------------------------------------------

// cvtColor(src, w, h, srcCh, code, dst, dstCh)
struct CvtColorJob : Job {
	cv::Mat src, dst;
	int code;
	void execute() override {
		cv::Mat out = dst;  // the right shape already, so written in place
		cv::cvtColor(src, out, code);
		if (out.data != dst.data) throw std::runtime_error("cvtColor: the conversion does not give the output asked for");
	}
};

napi_value CvtColor(napi_env env, napi_callback_info info) {
	napi_value a[7];
	if (!args(env, info, a)) return fail(env, "cvtColor(src, w, h, srcCh, code, dst, dstCh)");
	View s, d;
	int w, h, sc, code, dc;
	if (!viewOf(env, a[0], &s) || !viewOf(env, a[5], &d) || !intOf(env, a[1], &w) || !intOf(env, a[2], &h) ||
	    !intOf(env, a[3], &sc) || !intOf(env, a[4], &code) || !intOf(env, a[6], &dc) || matType(sc) < 0 ||
	    matType(dc) < 0 || !fits(w, h, sc, s.bytes) || !fits(w, h, dc, d.bytes))
		return fail(env, "cvtColor: bad arguments");
	auto* job = new CvtColorJob();
	job->src = cv::Mat(h, w, matType(sc), s.data);
	job->dst = cv::Mat(h, w, matType(dc), d.data);
	job->code = code;
	job->pin(env, a[0]);
	job->pin(env, a[5]);
	return queue(env, job, "opencv5.cvtColor");
}

// resize(src, w, h, ch, dst, dw, dh): INTER_LINEAR, as the bridge
struct ResizeJob : Job {
	cv::Mat src, dst;
	void execute() override {
		cv::Mat out = dst;  // a header over the caller's buffer: written in place
		cv::resize(src, out, dst.size(), 0, 0, cv::INTER_LINEAR);
		if (out.data != dst.data) throw std::runtime_error("resize: reallocated its output");
	}
};

napi_value Resize(napi_env env, napi_callback_info info) {
	napi_value a[7];
	if (!args(env, info, a)) return fail(env, "resize(src, w, h, ch, dst, dw, dh)");
	View s, d;
	int w, h, ch, dw, dh;
	if (!viewOf(env, a[0], &s) || !viewOf(env, a[4], &d) || !intOf(env, a[1], &w) || !intOf(env, a[2], &h) ||
	    !intOf(env, a[3], &ch) || !intOf(env, a[5], &dw) || !intOf(env, a[6], &dh) || matType(ch) < 0 ||
	    !fits(w, h, ch, s.bytes) || !fits(dw, dh, ch, d.bytes))
		return fail(env, "resize: bad arguments");
	auto* job = new ResizeJob();
	job->src = cv::Mat(h, w, matType(ch), s.data);
	job->dst = cv::Mat(dh, dw, matType(ch), d.data);
	job->pin(env, a[0]);
	job->pin(env, a[4]);
	return queue(env, job, "opencv5.resize");
}

// filter(gray, w, h, kind, kernel, intensity, dst): kind 0 = otsu, 1 = edge.
// "otsu" blurs `gray` IN PLACE before thresholding it: the bridge does,
// and callers written against it depend on it (README, filter).
struct FilterJob : Job {
	cv::Mat gray, dst;
	int kind, kernel;
	double intensity;
	double level = 0;
	void execute() override {
		if (kind == 0) {
			cv::Mat blurred;
			cv::GaussianBlur(gray, blurred, cv::Size(kernel, kernel), 0, 0, cv::BORDER_DEFAULT);
			blurred.copyTo(gray);
			cv::Mat out = dst;
			level = cv::threshold(gray, out, 0, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);
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
		napi_value r;
		napi_create_object(env, &r);
		if (kind == 0) setNum(env, r, "level", level);
		return r;
	}
};

napi_value Filter(napi_env env, napi_callback_info info) {
	napi_value a[7];
	if (!args(env, info, a)) return fail(env, "filter(gray, w, h, kind, kernel, intensity, dst)");
	View s, d;
	int w, h, kind, kernel;
	double intensity;
	if (!viewOf(env, a[0], &s) || !viewOf(env, a[6], &d) || !intOf(env, a[1], &w) || !intOf(env, a[2], &h) ||
	    !intOf(env, a[3], &kind) || !intOf(env, a[4], &kernel) || !numOf(env, a[5], &intensity) ||
	    (kind != 0 && kind != 1) || kernel < 1 || kernel > 31 || kernel % 2 == 0 || !fits(w, h, 1, s.bytes) ||
	    !fits(w, h, 1, d.bytes))
		return fail(env, "filter: bad arguments");
	auto* job = new FilterJob();
	job->gray = cv::Mat(h, w, CV_8UC1, s.data);
	job->dst = cv::Mat(h, w, CV_8UC1, d.data);
	job->kind = kind;
	job->kernel = kernel;
	job->intensity = intensity;
	job->pin(env, a[0]);
	job->pin(env, a[6]);
	return queue(env, job, "opencv5.filter");
}

// rotate(src, w, h, ch, dst, dw, dh, angleDeg, pad[4]): the bridge's
// rotate - getRotationMatrix2D about the source centre, shifted to the
// centre of the dw x dh canvas the caller sized, INTER_LINEAR,
// BORDER_CONSTANT in the pad colour
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
};

napi_value Rotate(napi_env env, napi_callback_info info) {
	napi_value a[9];
	if (!args(env, info, a)) return fail(env, "rotate(src, w, h, ch, dst, dw, dh, angleDeg, pad)");
	View s, d;
	int w, h, ch, dw, dh;
	double angle;
	if (!viewOf(env, a[0], &s) || !viewOf(env, a[4], &d) || !intOf(env, a[1], &w) || !intOf(env, a[2], &h) ||
	    !intOf(env, a[3], &ch) || !intOf(env, a[5], &dw) || !intOf(env, a[6], &dh) || !numOf(env, a[7], &angle) ||
	    matType(ch) < 0 || !fits(w, h, ch, s.bytes) || !fits(dw, dh, ch, d.bytes))
		return fail(env, "rotate: bad arguments");
	double p[4];
	for (int i = 0; i < 4; i++) {
		napi_value e;
		if (napi_get_element(env, a[8], i, &e) != napi_ok || !numOf(env, e, &p[i])) {
			return fail(env, "rotate: bad pad colour");
		}
	}
	auto* job = new RotateJob();
	job->src = cv::Mat(h, w, matType(ch), s.data);
	job->dst = cv::Mat(dh, dw, matType(ch), d.data);
	job->angle = angle;
	job->pad = cv::Scalar(p[0], p[1], p[2], p[3]);
	job->pin(env, a[0]);
	job->pin(env, a[4]);
	return queue(env, job, "opencv5.rotate");
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

void smallOf(const cv::Mat& full, double scale, cv::Mat& out) {
	const int w = std::max(1, static_cast<int>(std::round(full.cols * scale)));
	const int h = std::max(1, static_cast<int>(std::round(full.rows * scale)));
	cv::resize(full, out, cv::Size(w, h));
}

// One golden at one alignment scale. Its derived data is made on the pool,
// by whichever align gets there first, and read-only after that.
struct Golden {
	cv::Mat gray;  // our own copy: the caller's buffer may be reused
	double scale;
	std::once_flag once;
	cv::Mat small, des, prepared;
	std::vector<cv::KeyPoint> kp;
	bool preparedOk = false;
	// what V8 is told this holds outside its heap: the grey copy, its
	// small copy and the float ECC copy of that (ORB's data is small)
	int64_t bytes() const { return static_cast<int64_t>(gray.total() * (1 + 5 * scale * scale)); }

	void init() {
		std::call_once(once, [this] {
			smallOf(gray, scale, small);
			orb()->detectAndCompute(small, cv::noArray(), kp, des);
			preparedOk = eccPrepare(small, prepared);
		});
	}
};

void deleteGolden(napi_env env, void* data, void*) {
	auto* golden = static_cast<Golden*>(data);
	int64_t now;
	napi_adjust_external_memory(env, -golden->bytes(), &now);
	delete golden;
}

// createGolden(gray, w, h, scale) -> handle
napi_value CreateGolden(napi_env env, napi_callback_info info) {
	napi_value a[4];
	if (!args(env, info, a)) return fail(env, "createGolden(gray, w, h, scale)");
	View g;
	int w, h;
	double scale;
	if (!viewOf(env, a[0], &g) || !intOf(env, a[1], &w) || !intOf(env, a[2], &h) || !numOf(env, a[3], &scale) ||
	    !fits(w, h, 1, g.bytes) || !(scale > 0 && scale <= 1))
		return fail(env, "createGolden: bad arguments");
	auto* golden = new Golden();
	golden->gray = cv::Mat(h, w, CV_8UC1, g.data).clone();
	golden->scale = scale;
	napi_value handle;
	if (napi_create_external(env, golden, deleteGolden, nullptr, &handle) != napi_ok) {
		delete golden;
		return fail(env, "createGolden: no handle");
	}
	// so the GC weighs a golden by what it holds, not by its handle
	int64_t now;
	napi_adjust_external_memory(env, golden->bytes(), &now);
	return handle;
}

// What one pool thread keeps between frames, so a frame's working copies
// are not fresh pages every time: the frame at golden size (only when the
// frame is not that size already), its small copy and that copy as float.
// Bounded by the largest golden aligned on that thread - for a
// 1475x2125 golden at scale 0.35, about 3.1 + 0.4 + 1.5 MB - times libuv's pool
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
		napi_value r, matrix, stages;
		napi_create_object(env, &r);
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

// align(golden, target, tW, tH, out, iterations, eps, eccAlways)
napi_value Align(napi_env env, napi_callback_info info) {
	napi_value a[8];
	if (!args(env, info, a)) return fail(env, "align(golden, target, tW, tH, out, iterations, eps, eccAlways)");
	void* ptr = nullptr;
	napi_valuetype t;
	napi_typeof(env, a[0], &t);
	if (t != napi_external || napi_get_value_external(env, a[0], &ptr) != napi_ok || ptr == nullptr)
		return fail(env, "align: not a golden handle");
	auto* golden = static_cast<Golden*>(ptr);
	View tv, ov;
	int tW, tH, iterations;
	double eps;
	bool eccAlways = false;
	const int gW = golden->gray.cols, gH = golden->gray.rows;
	if (!viewOf(env, a[1], &tv) || !viewOf(env, a[4], &ov) || !intOf(env, a[2], &tW) || !intOf(env, a[3], &tH) ||
	    !intOf(env, a[5], &iterations) || !numOf(env, a[6], &eps) ||
	    napi_get_value_bool(env, a[7], &eccAlways) != napi_ok || iterations < 1 || !(eps > 0) ||
	    !fits(tW, tH, 1, tv.bytes) || !fits(gW, gH, 1, ov.bytes))
		return fail(env, "align: bad arguments");
	auto* job = new AlignJob();
	job->golden = golden;
	job->target = cv::Mat(tH, tW, CV_8UC1, tv.data);
	job->out = cv::Mat(gH, gW, CV_8UC1, ov.data);
	job->iterations = iterations;
	job->eps = eps;
	job->eccAlways = eccAlways;
	job->pin(env, a[0]);  // keeps the golden alive while the work runs
	job->pin(env, a[1]);
	job->pin(env, a[4]);
	return queue(env, job, "opencv5.align");
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
	    {"align", guarded<Align>},               {"buildInfo", guarded<BuildInfo>},
	};
	for (const auto& f : fns) {
		napi_value v;
		napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &v);
		napi_set_named_property(env, exports, f.name, v);
	}
	napi_value v;
	napi_create_int32(env, OPENCV5_ABI, &v);
	napi_set_named_property(env, exports, "abi", v);
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
