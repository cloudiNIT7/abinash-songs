/* ===================================================================
 * Cloud Songs - auth client (NO BACKEND).
 *
 * The original version of this file talked to a Flask + MySQL service
 * that also emailed OTP codes. That backend was removed, so accounts now
 * live entirely in this browser's localStorage.
 *
 * !!! SECURITY NOTICE !!!
 * This is a client-side gate for demo purposes, NOT authentication.
 *   - Anyone can read or edit localStorage from devtools and let
 *     themselves in, or read the stored password hashes.
 *   - Accounts do not travel between browsers, devices, or private mode.
 *   - Verification codes cannot be emailed with no server, so the code is
 *     shown on screen.
 * If real accounts are ever needed, this must move back to a server that
 * owns the password hashing and issues session tokens.
 * =================================================================== */

const AUTH_SESSION_KEY = "cloudsongs:session";
const AUTH_USERS_KEY = "cloudsongs:users";
const AUTH_OTP_KEY = "cloudsongs:otp";

/* ---------- storage helpers ---------- */

function _read(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : fallback;
	} catch (e) {
		return fallback;
	}
}

function _write(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (e) {
		return false;   // private mode / quota
	}
}

function _users() { return _read(AUTH_USERS_KEY, {}); }
function _saveUsers(u) { return _write(AUTH_USERS_KEY, u); }
function _norm(email) { return String(email || "").trim().toLowerCase(); }

/* ---------- password hashing ----------
 * crypto.subtle is only exposed in a secure context, and this app is
 * served over plain HTTP, so it isn't available. This is a compact
 * pure-JS SHA-256 so stored values are at least salted digests rather
 * than plaintext. It does NOT make client-side auth secure. */

function _sha256(msg) {
	const K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
	let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

	// utf-8 encode
	const bytes = [];
	for (let i = 0; i < msg.length; i++) {
		let c = msg.charCodeAt(i);
		if (c < 0x80) bytes.push(c);
		else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	const bitLen = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) bytes.push(0);
	for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);

	const rotr = (x, n) => (x >>> n) | (x << (32 - n));
	const W = new Array(64);

	for (let off = 0; off < bytes.length; off += 64) {
		for (let i = 0; i < 16; i++) {
			W[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
			       (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
			const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
			W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const mj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + mj) | 0;
			h = g; g = f; f = e; e = (d + t1) | 0;
			d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0,
		     (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
	}
	return H.map((x) => ("00000000" + (x >>> 0).toString(16)).slice(-8)).join("");
}

function _randomHex(bytes) {
	let out = "";
	if (window.crypto && window.crypto.getRandomValues) {
		const a = new Uint8Array(bytes);
		window.crypto.getRandomValues(a);
		a.forEach((b) => { out += ("0" + b.toString(16)).slice(-2); });
	} else {
		for (let i = 0; i < bytes * 2; i++) out += Math.floor(Math.random() * 16).toString(16);
	}
	return out;
}

function _hash(password, salt) { return _sha256(salt + "|" + password); }

/* ---------- session ---------- */

function getCurrentUserObj() { return _read(AUTH_SESSION_KEY, null); }

function setCurrentUserObj(user) { _write(AUTH_SESSION_KEY, user); }

// Plain string: existing pages do `"Hi, " + getCurrentUser()`.
function getCurrentUser() {
	const u = getCurrentUserObj();
	return u ? (u.display_name || u.username) : null;
}

function isLoggedIn() { return !!getCurrentUserObj(); }

function isProfileComplete() {
	const u = getCurrentUserObj();
	return !!(u && u.profile_completed);
}

function logOut() {
	try { localStorage.removeItem(AUTH_SESSION_KEY); } catch (e) {}
}

/* Strip secrets before a record is put in the session / handed to a page. */
function _publicUser(rec) {
	return {
		id: rec.id,
		username: rec.username,
		email: rec.email,
		display_name: rec.display_name || rec.username,
		avatar_color: rec.avatar_color || "#1DB954",
		bio: rec.bio || "",
		profile_completed: !!rec.profile_completed
	};
}

/* ---------- one-time codes ----------
 * With no mail server the code is generated here and displayed on the
 * verify screen. getPendingOtp() is what that page reads. */

function _issueOtp(email) {
	const code = String(Math.floor(100000 + Math.random() * 900000));
	const all = _read(AUTH_OTP_KEY, {});
	all[_norm(email)] = { code: code, at: Date.now() };
	_write(AUTH_OTP_KEY, all);
	return code;
}

function getPendingOtp(email) {
	const rec = _read(AUTH_OTP_KEY, {})[_norm(email)];
	return rec ? rec.code : null;
}

function _clearOtp(email) {
	const all = _read(AUTH_OTP_KEY, {});
	delete all[_norm(email)];
	_write(AUTH_OTP_KEY, all);
}

/* ---------- public API (async to keep the original call signatures) ---------- */

async function signUp(username, email, password) {
	const key = _norm(email);
	if (!username || !key || !password) return { ok: false, message: "All fields are required." };
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return { ok: false, message: "Enter a valid email address." };
	if (String(password).length < 6) return { ok: false, message: "Use at least 6 characters for your password." };

	const users = _users();
	if (users[key]) return { ok: false, message: "That email is already registered. Try logging in." };

	const salt = _randomHex(8);
	users[key] = {
		id: _randomHex(6),
		username: String(username).trim(),
		email: key,
		salt: salt,
		hash: _hash(password, salt),
		display_name: String(username).trim(),
		avatar_color: "#1DB954",
		bio: "",
		profile_completed: false,
		verified: false
	};
	if (!_saveUsers(users)) {
		return { ok: false, message: "This browser is blocking storage, so accounts can't be saved." };
	}

	const code = _issueOtp(key);
	return { ok: true, requiresOtp: true, email: key, code: code };
}

async function logIn(email, password) {
	const key = _norm(email);
	const users = _users();
	const rec = users[key];
	if (!rec) return { ok: false, message: "No account found for that email." };
	if (rec.hash !== _hash(password, rec.salt)) return { ok: false, message: "Invalid email or password." };

	if (!rec.verified) {
		const code = _issueOtp(key);
		return { ok: false, requiresOtp: true, email: key, code: code, message: "Verify your email to finish signing in." };
	}

	setCurrentUserObj(_publicUser(rec));
	return { ok: true, user: _publicUser(rec) };
}

async function verifyOtp(email, code) {
	const key = _norm(email);
	const expected = getPendingOtp(key);
	if (!expected) return { ok: false, message: "That code has expired. Request a new one." };
	if (String(code).trim() !== expected) return { ok: false, message: "Invalid code." };

	const users = _users();
	const rec = users[key];
	if (!rec) return { ok: false, message: "No account found for that email." };

	rec.verified = true;
	_saveUsers(users);
	_clearOtp(key);
	setCurrentUserObj(_publicUser(rec));
	return { ok: true, user: _publicUser(rec) };
}

async function resendOtp(email) {
	const key = _norm(email);
	if (!_users()[key]) return { ok: false, message: "No account found for that email." };
	const code = _issueOtp(key);
	return { ok: true, code: code, message: "New code: " + code };
}

async function updateProfile(displayName, avatarColor, bio) {
	const current = getCurrentUserObj();
	if (!current) return { ok: false, message: "You're not logged in." };

	const users = _users();
	const rec = users[_norm(current.email)];
	if (!rec) return { ok: false, message: "Your account is no longer stored in this browser." };

	rec.display_name = String(displayName || "").trim() || rec.username;
	rec.avatar_color = avatarColor || "#1DB954";
	rec.bio = String(bio || "").trim();
	rec.profile_completed = true;
	_saveUsers(users);

	setCurrentUserObj(_publicUser(rec));
	return { ok: true, user: _publicUser(rec) };
}

// Existed to retry pushing a profile to the server. Nothing to sync now.
async function syncProfileIfNeeded() { /* no-op without a backend */ }
