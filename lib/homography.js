/**
 * Plane-to-plane geometry for the perspective calibration: a 2D
 * similarity fit, a least-squares homography fit, and the small matrix
 * helpers the rectify path needs. Pure JS on a few dozen points; nothing
 * here touches pixels.
 *
 * Conventions:
 *  - a homography is a row-major 3x3 as nine numbers, normalised so
 *    H[8] === 1, mapping (x, y) -> (X, Y) with
 *      X = (H0 x + H1 y + H2) / (H6 x + H7 y + H8)
 *      Y = (H3 x + H4 y + H5) / (H6 x + H7 y + H8)
 *  - points are { x, y } in image pixels, origin top-left, y down.
 */

"use strict";

/**
 * Least-squares similarity (uniform scale, rotation, translation, no
 * reflection) mapping src[i] -> dst[i]. Umeyama's closed form in 2D: the
 * rotation is the angle of the cross-covariance, the scale is its length
 * over the source variance.
 *
 * Returns { s, cos, sin, tx, ty, angleDeg } with
 *   X = s (cos x - sin y) + tx,  Y = s (sin x + cos y) + ty.
 */
function fitSimilarity(src, dst) {
	const n = src.length;
	if (n < 2 || dst.length !== n) {
		throw new Error("fitSimilarity needs at least 2 point pairs");
	}
	let mx = 0;
	let my = 0;
	let ux = 0;
	let uy = 0;
	for (let i = 0; i < n; i++) {
		mx += src[i].x;
		my += src[i].y;
		ux += dst[i].x;
		uy += dst[i].y;
	}
	mx /= n;
	my /= n;
	ux /= n;
	uy /= n;
	// a = sum(p . q), b = sum(p x q), v = sum(|p|^2) on centred points
	let a = 0;
	let b = 0;
	let v = 0;
	for (let i = 0; i < n; i++) {
		const px = src[i].x - mx;
		const py = src[i].y - my;
		const qx = dst[i].x - ux;
		const qy = dst[i].y - uy;
		a += px * qx + py * qy;
		b += px * qy - py * qx;
		v += px * px + py * py;
	}
	if (!(v > 0)) {
		throw new Error("fitSimilarity: source points are coincident");
	}
	const s = Math.hypot(a, b) / v;
	const angle = Math.atan2(b, a);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const tx = ux - s * (cos * mx - sin * my);
	const ty = uy - s * (sin * mx + cos * my);
	return { s, cos, sin, tx, ty, angleDeg: (angle * 180) / Math.PI };
}

function applySimilarity(sim, p) {
	return {
		x: sim.s * (sim.cos * p.x - sim.sin * p.y) + sim.tx,
		y: sim.s * (sim.sin * p.x + sim.cos * p.y) + sim.ty,
	};
}

// Hartley normalisation: translate the centroid to the origin and scale so
// the mean distance from it is sqrt(2). The DLT normal equations are badly
// conditioned on raw pixel coordinates (entries range from 1 to ~1e7 on a
// 4k image); on normalised ones they are fine.
function normalisation(pts) {
	const n = pts.length;
	let mx = 0;
	let my = 0;
	for (const p of pts) {
		mx += p.x;
		my += p.y;
	}
	mx /= n;
	my /= n;
	let mean = 0;
	for (const p of pts) mean += Math.hypot(p.x - mx, p.y - my);
	mean /= n;
	const s = mean > 0 ? Math.SQRT2 / mean : 1;
	// T maps raw -> normalised; row-major 3x3
	return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

function mul3(A, B) {
	const C = new Array(9);
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			C[r * 3 + c] =
				A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
		}
	}
	return C;
}

function normaliseHomography(H) {
	const w = H[8];
	if (!Number.isFinite(w) || w === 0) {
		throw new Error("homography has a zero projective scale");
	}
	return H.map((v) => v / w);
}

function invertHomography(H) {
	const [a, b, c, d, e, f, g, h, i] = H;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!Number.isFinite(det) || Math.abs(det) < 1e-300) {
		throw new Error("homography is singular");
	}
	const inv = [
		A,
		-(b * i - c * h),
		b * f - c * e,
		B,
		a * i - c * g,
		-(a * f - c * d),
		C,
		-(a * h - b * g),
		a * e - b * d,
	].map((v) => v / det);
	return normaliseHomography(inv);
}

function applyHomography(H, x, y) {
	const w = H[6] * x + H[7] * y + H[8];
	return {
		x: (H[0] * x + H[1] * y + H[2]) / w,
		y: (H[3] * x + H[4] * y + H[5]) / w,
	};
}

// Solve the square system M x = rhs in place by Gaussian elimination with
// partial pivoting. M is row-major n x n.
function solveLinear(M, rhs, n) {
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) {
			if (Math.abs(M[r * n + col]) > Math.abs(M[pivot * n + col])) pivot = r;
		}
		if (Math.abs(M[pivot * n + col]) < 1e-12) {
			throw new Error("homography fit is degenerate (collinear points?)");
		}
		if (pivot !== col) {
			for (let c = 0; c < n; c++) {
				const t = M[col * n + c];
				M[col * n + c] = M[pivot * n + c];
				M[pivot * n + c] = t;
			}
			const t = rhs[col];
			rhs[col] = rhs[pivot];
			rhs[pivot] = t;
		}
		for (let r = col + 1; r < n; r++) {
			const f = M[r * n + col] / M[col * n + col];
			if (f === 0) continue;
			for (let c = col; c < n; c++) M[r * n + c] -= f * M[col * n + c];
			rhs[r] -= f * rhs[col];
		}
	}
	const x = new Array(n);
	for (let r = n - 1; r >= 0; r--) {
		let sum = rhs[r];
		for (let c = r + 1; c < n; c++) sum -= M[r * n + c] * x[c];
		x[r] = sum / M[r * n + r];
	}
	return x;
}

/**
 * Least-squares homography mapping src[i] -> dst[i], four or more pairs.
 * Normalised inhomogeneous DLT: with H[8] fixed at 1 each pair gives two
 * linear equations in the remaining eight unknowns, solved through the
 * normal equations. Fixing H[8] is safe here because the points are
 * normalised first, so the true H[8] is never near zero.
 */
function fitHomography(src, dst) {
	const n = src.length;
	if (n < 4 || dst.length !== n) {
		throw new Error("fitHomography needs at least 4 point pairs");
	}
	const Ts = normalisation(src);
	const Td = normalisation(dst);
	const M = new Float64Array(64);
	const rhs = new Float64Array(8);
	const row = new Float64Array(8);
	const accumulate = (b) => {
		for (let i = 0; i < 8; i++) {
			const ri = row[i];
			if (ri === 0) continue;
			for (let j = 0; j < 8; j++) M[i * 8 + j] += ri * row[j];
			rhs[i] += ri * b;
		}
	};
	for (let k = 0; k < n; k++) {
		const p = applyHomography(Ts, src[k].x, src[k].y);
		const q = applyHomography(Td, dst[k].x, dst[k].y);
		// X (h6 x + h7 y + 1) = h0 x + h1 y + h2
		row.set([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y]);
		accumulate(q.x);
		row.set([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y]);
		accumulate(q.y);
	}
	const h = solveLinear(Array.from(M), Array.from(rhs), 8);
	const Hn = [...h, 1];
	// H = Td^-1 Hn Ts
	return normaliseHomography(mul3(invertHomography(Td), mul3(Hn, Ts)));
}

/**
 * Re-express a homography measured on a `from` sized image for a `to`
 * sized image of the same field of view (the same camera at a different
 * capture resolution): H' = S H S^-1 with S = diag(sx, sy, 1). A different
 * aspect ratio is a different crop of the sensor, which this cannot
 * follow, so it is refused.
 */
function rescaleHomography(H, from, to) {
	if (from.width === to.width && from.height === to.height) return H.slice();
	const sx = to.width / from.width;
	const sy = to.height / from.height;
	if (Math.abs(sx / sy - 1) > 0.005) {
		throw new Error(
			`frame ${to.width}x${to.height} is not the same aspect ratio as the ` +
				`calibration photo ${from.width}x${from.height} - re-run ` +
				`checkerboard-calibrate at the production capture size`,
		);
	}
	const S = [sx, 0, 0, 0, sy, 0, 0, 0, 1];
	const Si = [1 / sx, 0, 0, 0, 1 / sy, 0, 0, 0, 1];
	return normaliseHomography(mul3(S, mul3(H, Si)));
}

function isIdentityLike(H, eps = 1e-9) {
	const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	return H.every((v, i) => Math.abs(v - I[i]) <= eps);
}

/** Root-mean-square and maximum distance between H(src[i]) and dst[i]. */
function reprojection(H, src, dst) {
	let sum = 0;
	let max = 0;
	for (let i = 0; i < src.length; i++) {
		const p = applyHomography(H, src[i].x, src[i].y);
		const d = Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
		sum += d * d;
		if (d > max) max = d;
	}
	return { rms: Math.sqrt(sum / src.length), max };
}

/** A well-formed homography record as stored in the scale file: nine
 * finite numbers, projective scale 1, invertible. Returns a reason string
 * when it is not, null when it is. */
function validateHomography(H) {
	if (!Array.isArray(H) || H.length !== 9) {
		return "homography must be an array of 9 numbers";
	}
	if (!H.every((v) => typeof v === "number" && Number.isFinite(v))) {
		return "homography must contain only finite numbers";
	}
	if (H[8] !== 1) return "homography must be normalised to H[8] === 1";
	try {
		invertHomography(H);
	} catch (err) {
		return err.message;
	}
	return null;
}

module.exports = {
	fitSimilarity,
	applySimilarity,
	fitHomography,
	applyHomography,
	invertHomography,
	rescaleHomography,
	isIdentityLike,
	reprojection,
	validateHomography,
};
