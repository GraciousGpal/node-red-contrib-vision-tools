/**
 * A persistent worker-thread pool for the per-pixel stages.
 *
 * Everything after decode used to run on one core while the rest of the
 * machine sat idle: on a 16-core host, ~630ms of an 850ms frame was
 * single-threaded JavaScript. (`sharp` already decodes and resizes on all
 * cores, which is why decode is not in here.)
 *
 * The pool is created once and reused. That is not an optimisation
 * detail, it is the whole feasibility argument: spawning eight workers
 * costs ~60ms, which would wipe out the ~40ms a frame's parallel stages
 * save. Measured on the tile matcher, a warm pool takes 48ms of work down
 * to 8ms with eight workers.
 *
 * Buffers are passed as SharedArrayBuffers, so a dispatch ships a handful
 * of numbers and a memory handle rather than tens of megabytes.
 *
 * Callers must be able to do without it: `shouldParallelise` is false for
 * small images, for a pool of one, and when SharedArrayBuffer is missing,
 * and every kernel here has a serial twin that stays the reference
 * implementation.
 *
 * Two invariants hold the concurrent case together, because Node-RED never
 * awaits a node's input handler and two frames overlap freely inside
 * compareFrame:
 *
 *  - **A dispatch is settled by id, never by "the next reply".** See
 *    spawn(). Getting this wrong did not fail loudly; it returned a frame
 *    aligned against a half-written buffer.
 *  - **The pool is never torn down because a different size was asked
 *    for.** See getPool(). It grows and stays grown.
 */

const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { HAS_SAB } = require("./shared.js");

const WORKER_PATH = path.join(__dirname, "poolWorker.js");

// Below this many pixels the dispatch costs more than the work saved.
const MIN_PIXELS_TO_SPLIT = 400000;

let pool = null;
let nextDispatchId = 1;

function defaultSize() {
	const cpus = os.cpus().length;
	// Leave a core for the event loop and for libvips finishing a decode.
	//
	// The cap used to be eight, on the grounds that the defect scan's curve
	// is flat past it (5.76x at 8, 6.55x at 16). That is true of the scan
	// and false of the alignment polish, which is the larger cost: the
	// polish is ~15 *sequential* rounds of a small batch, so each round
	// pays a fixed dispatch cost and finishes no sooner than its slowest
	// worker. Measured on a 16-core host against a 4096x5500 frame, pinned,
	// with bit-identical transforms and verdicts at every size:
	//
	//   workers   8 -> polish 342ms, align 798ms
	//   workers  12 -> polish 220ms, align 680ms
	//   workers  16 -> polish 215ms, align 678ms
	//   workers  24 -> polish 216ms, align 680ms
	//
	// It plateaus around twelve, so the cap is sixteen rather than "one per
	// core": past the plateau the extra threads only cost memory and
	// contend with whatever else the instance is running. Boxes with nine
	// cores or fewer are unaffected.
	return Math.max(1, Math.min(16, cpus - 1));
}

/** The pool size a request resolves to. 0 (the default) means "one per
 * core, capped at sixteen"; anything else is taken literally. */
function wanted(size) {
	return size && size > 0 ? size : defaultSize();
}

/**
 * Spawn one worker and give it the *only* listeners it will ever have.
 *
 * The listeners are permanent, and each dispatch is tracked by id in
 * `pending`, because the obvious alternative is broken: registering
 * `once("message")` per dispatch means two concurrent dispatches to the
 * same worker each add a listener, and the first reply fires *both* -
 * EventEmitter delivers to every listener registered at emit time, and
 * `once` only removes after delivery. The second caller then resolved on
 * someone else's reply and read a half-written output buffer. Through the
 * real pipeline that surfaced as two concurrent frames both reporting
 * transform.score = 0, which is not an error value: it is a perfect match,
 * it beats every candidate, and the part passes.
 *
 * Permanent listeners cost one thing that has to be paid back explicitly:
 * an attached listener refs the worker's port, and the old per-dispatch
 * attach/detach was doing that ref-counting by accident. Hence the
 * ref()/unref() around `pending` going empty and non-empty - without it an
 * idle pool holds the process open and `npm test` never exits.
 */
function spawn() {
	const worker = new Worker(WORKER_PATH);
	const pending = new Map();
	worker.pending = pending;

	const rejectAll = (err) => {
		if (pending.size === 0) return;
		const waiting = Array.from(pending.values());
		pending.clear();
		worker.unref();
		for (const entry of waiting) entry.reject(err);
	};

	worker.on("message", (msg) => {
		// null-safe, and an unknown id is ignored rather than thrown on: a
		// reply can arrive for a dispatch already rejected by an earlier
		// error or exit, and throwing here would be an uncaught exception
		// inside the EventEmitter - it would take the process down, not the
		// frame.
		const entry = msg == null ? undefined : pending.get(msg.id);
		if (!entry) return;
		pending.delete(msg.id);
		if (pending.size === 0) worker.unref();
		if (msg.error) entry.reject(new Error(msg.error));
		else entry.resolve();
	});
	worker.on("error", (err) => {
		// only this worker leaves the pool. Tearing the whole pool down here
		// would fail every other in-flight frame for one worker's fault; the
		// next getPool() grows a replacement.
		remove(worker);
		rejectAll(err);
		worker.terminate();
	});
	worker.on("exit", (code) => {
		// a terminated or crashed worker can never answer its dispatches;
		// without this they hung forever and the frame silently never
		// settled (shutdown()/terminate() emit only 'exit')
		remove(worker);
		rejectAll(
			new Error(`worker exited (code ${code}) before finishing its range`),
		);
	});
	// idle: the listeners above would otherwise hold the loop open
	worker.unref();
	return worker;
}

function remove(worker) {
	if (!pool) return;
	const i = pool.workers.indexOf(worker);
	if (i >= 0) pool.workers.splice(i, 1);
}

/**
 * One pool, grown to the largest size anyone has asked for, never torn
 * down because a different size was asked for next.
 *
 * The pool used to be rebuilt whenever the requested size changed, which
 * two things reach: `msg.workers` is a per-message override, and two
 * golden-compare nodes can be configured differently. That cost ~60ms of
 * respawn per frame - the very cost this module's header argues is
 * unaffordable - and, worse, the teardown terminated workers that another
 * in-flight frame was still waiting on, failing that frame for no reason
 * of its own.
 *
 * Growing instead keeps the thread count bounded by the same `workers`
 * clamp as before (64), and a caller asking for fewer simply dispatches to
 * a prefix of the pool.
 */
function getPool(size) {
	const want = wanted(size);
	if (!HAS_SAB || want <= 1) return null;
	if (!pool) pool = { workers: [] };
	while (pool.workers.length < want) pool.workers.push(spawn());
	return pool;
}

function shouldParallelise(pixels, size) {
	if (!HAS_SAB) return false;
	if (size === 1) return false;
	return pixels >= MIN_PIXELS_TO_SPLIT;
}

/**
 * How many workers getPool(size) will actually run - for callers that
 * must size per-worker scratch before dispatching (defectParallel's
 * counter slots) and cannot wait until the pool exists. Keep in step
 * with getPool's `want` computation.
 */
function poolSize(size) {
	const want = wanted(size);
	if (!HAS_SAB || want <= 1) return 0;
	return want;
}

/** One dispatch to one worker, settled by id. */
function dispatch(worker, message) {
	return new Promise((resolve, reject) => {
		const id = nextDispatchId++;
		if (worker.pending.size === 0) worker.ref();
		worker.pending.set(id, { resolve, reject });
		try {
			worker.postMessage({ ...message, id });
		} catch (err) {
			// a worker terminated between getPool() and here would otherwise
			// leave this promise unsettled forever
			worker.pending.delete(id);
			if (worker.pending.size === 0) worker.unref();
			reject(err);
		}
	});
}

/**
 * Split [0,total) into one contiguous range per worker and run `kernel`
 * over each. `ctx` must contain only SharedArrayBuffers and structured-
 * cloneable scalars.
 */
function runRanges(kernel, ctx, total, size) {
	const p = getPool(size);
	if (!p) return null;
	// A prefix of the pool, not all of it: the pool may hold more workers
	// than this caller asked for, and `index` has to stay within 0..want-1
	// to match the per-worker scratch the caller already sized from
	// poolSize() - defectParallel's counter slots, in particular.
	const want = wanted(size);
	const workers = p.workers.slice(0, want);
	const n = workers.length;
	return Promise.all(
		workers.map((worker, i) => {
			const lo = Math.floor((i * total) / n);
			const hi = Math.floor(((i + 1) * total) / n);
			if (hi <= lo) return Promise.resolve();
			return dispatch(worker, { kernel, ctx, lo, hi, index: i });
		}),
	);
}

function shutdown() {
	if (!pool) return;
	const workers = pool.workers;
	pool = null;
	for (const w of workers) w.terminate();
}

module.exports = {
	getPool,
	runRanges,
	shouldParallelise,
	shutdown,
	defaultSize,
	poolSize,
};
