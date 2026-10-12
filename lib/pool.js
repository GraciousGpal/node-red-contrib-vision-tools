/**
 * A persistent worker-thread pool for the per-pixel stages.
 *
 * (`sharp` already decodes and resizes on all cores, which is why decode
 * is not in here.)
 *
 * The pool is created once and reused. That is the whole feasibility
 * argument: spawning the workers costs more than a frame's parallel
 * stages save.
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
 *    spawn(). Getting this wrong fails silently: a frame aligned against a
 *    half-written buffer.
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
// runOne's worker
let side = null;
let nextDispatchId = 1;
let spawned = 0;

// Where in its collection interval a worker starts, as a fraction of it.
// Every worker is shown the same new buffers - a rectified frame goes to
// all of them - so workers that all started at 0 would cross the interval
// in the same frame and collect together, slowing every stage of it.
// Stepped by the golden ratio, any number of workers is spread evenly and
// about one collects in a frame. See lib/poolWorker.js.
function gcPhase(index) {
	return (index * 0.6180339887498949) % 1;
}

function defaultSize() {
	const cpus = os.cpus().length;
	// Leave a core for the event loop and for libvips finishing a decode.
	// The defect scan is flat past eight workers, but the alignment polish
	// (~15 sequential small-batch rounds, each waiting for its slowest
	// worker) was measured to plateau around twelve, so the cap is sixteen
	// rather than "one per core": past the plateau extra threads only cost
	// memory and contend with whatever else the instance is running.
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
 * `once` only removes after delivery. The second caller would resolve on
 * someone else's reply and read a half-written output buffer, which can
 * surface as transform.score = 0: not an error value but a perfect match
 * that beats every candidate, so the part passes.
 *
 * Permanent listeners cost one thing that has to be paid back explicitly:
 * an attached listener refs the worker's port. Hence the
 * ref()/unref() around `pending` going empty and non-empty - without it an
 * idle pool holds the process open and `npm test` never exits.
 */
function spawn() {
	const worker = new Worker(WORKER_PATH, { workerData: { gcPhase: gcPhase(spawned++) } });
	const pending = new Map();
	worker.pending = pending;
	// the shared buffers this worker has already been handed, by identity,
	// which only this side has: a buffer arrives in the worker as a fresh
	// object every message. See newBytesFor.
	worker.seen = new WeakSet();

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
		else entry.resolve(msg.value);
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
		// without this they would hang forever and the frame never settle
		// (shutdown()/terminate() emit only 'exit')
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
	if (worker === side) side = null;
	if (!pool) return;
	const i = pool.workers.indexOf(worker);
	if (i >= 0) pool.workers.splice(i, 1);
}

/**
 * One pool, grown to the largest size anyone has asked for, never torn
 * down because a different size was asked for next.
 *
 * The requested size varies: `msg.workers` is a per-message override, and
 * two golden-compare nodes can be configured differently. Rebuilding on a
 * change would pay the respawn cost per frame and terminate workers that
 * another in-flight frame is still waiting on, failing that frame.
 *
 * The thread count stays bounded by the `workers` clamp (64), and a caller
 * asking for fewer simply dispatches to a prefix of the pool.
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

// How many shared bytes a dispatch hands this worker for the first time.
// The worker collects its garbage by volume (lib/poolWorker.js), and the
// polish resends the same grey, ink and table buffers every round, so
// counting every buffer every message would overstate that volume and
// make the worker collect several times a frame.
function newBytesFor(worker, ctx) {
	let bytes = 0;
	const note = (v) => {
		if (v instanceof SharedArrayBuffer && !worker.seen.has(v)) {
			worker.seen.add(v);
			bytes += v.byteLength;
		}
	};
	for (const v of Object.values(ctx)) {
		note(v);
		if (v !== null && typeof v === "object" && !(v instanceof SharedArrayBuffer)) {
			for (const inner of Object.values(v)) note(inner);
		}
	}
	return bytes;
}

/** One dispatch to one worker, settled by id. */
function dispatch(worker, message) {
	return new Promise((resolve, reject) => {
		const id = nextDispatchId++;
		if (worker.pending.size === 0) worker.ref();
		worker.pending.set(id, { resolve, reject });
		try {
			worker.postMessage({ ...message, id, newBytes: newBytesFor(worker, message.ctx) });
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

/**
 * Run `kernel` once, on a worker of its own beside the pool, for a job
 * that is one piece of work rather than a range: resolves to what the
 * kernel returned (a store it moved back, say). Null when there is no
 * pool.
 *
 * Beside the pool, not in it: a range dispatch settles when its slowest
 * worker does, so a pool worker busy with a single job would hold up every
 * dispatch the frame sent meanwhile, and a worker that allocates a frame's
 * worth of memory collects more often, holding up the next frame's
 * alignment.
 */
function runOne(kernel, ctx, size) {
	if (!getPool(size)) return null;
	if (side === null) side = spawn();
	return dispatch(side, { kernel, ctx, lo: 0, hi: 1, index: 0 });
}

function shutdown() {
	if (side !== null) side.terminate();
	side = null;
	if (!pool) return;
	const workers = pool.workers;
	pool = null;
	for (const w of workers) w.terminate();
}

module.exports = { runRanges, runOne, shouldParallelise, shutdown, poolSize, gcPhase };
