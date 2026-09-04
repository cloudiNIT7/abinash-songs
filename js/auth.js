/* ===================================================================
 * Cloud Songs - auth client.
 *
 * Accounts live on the server now: Cloudflare Pages Functions under
 * /api/auth/* backed by a D1 database. Passwords are hashed with
 * PBKDF2-SHA256 server-side and the browser only ever holds an HttpOnly,
 * signed session cookie, so nothing here can be forged from devtools.
 *
 * The session is fetched once per page load. Because that is asynchronous
 * while the old localStorage version was not, pages must wait for
 * `authReady()` before calling isLoggedIn() / getCurrentUserObj():
 *
 *     authReady().then(() => { if (!isLoggedIn()) location.href = "./login.html"; });
 * =================================================================== */

const AUTH_API = "/api/auth";

let _user = null;        // cached public user object, or null
let _readyPromise = null;

/* ---------- plumbing ---------- */

async function _request(path, { method = "GET", body = null } = {}) {
	try {
		const res = await fetch(AUTH_API + path, {
			method,
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			credentials: "same-origin",
			cache: "no-store",
		});
		let data = {};
		try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
		if (!res.ok) {
			return { ok: false, status: res.status, message: data.error || "Something went wrong." };
		}
		return { ok: true, status: res.status, ...data };
	} catch (e) {
		return { ok: false, status: 0, message: "Can't reach the server. Check your connection." };
	}
}

/** Adds the field name the existing pages read (`profile_completed`). */
function _shape(user) {
	if (!user) return null;
	return { ...user, profile_completed: !!(user.profile_complete || user.profile_completed) };
}

async function _loadSession() {
	const res = await _request("/me");
	_user = res.ok ? _shape(res.user) : null;
	return _user;
}

/** Resolves once the session is known. Safe to call many times. */
function authReady() {
	if (!_readyPromise) _readyPromise = _loadSession();
	return _readyPromise;
}

/* ---------- synchronous accessors (valid after authReady) ---------- */

function getCurrentUserObj() { return _user; }

// Plain string: existing pages do `"Hi, " + getCurrentUser()`.
function getCurrentUser() {
	return _user ? (_user.display_name || _user.username) : null;
}

function isLoggedIn() { return !!_user; }

function isProfileComplete() { return !!(_user && _user.profile_completed); }

/* ---------- actions ---------- */

async function signUp(username, email, password) {
	const res = await _request("/signup", {
		method: "POST",
		body: { username: username, email: email, password: password },
	});
	if (!res.ok) return { ok: false, message: res.message };
	_user = _shape(res.user);
	_readyPromise = Promise.resolve(_user);
	return { ok: true, user: _user };
}

async function logIn(email, password) {
	const res = await _request("/login", {
		method: "POST",
		body: { email: email, password: password },
	});
	if (!res.ok) return { ok: false, message: res.message };
	_user = _shape(res.user);
	_readyPromise = Promise.resolve(_user);
	return { ok: true, user: _user };
}

async function logOut() {
	await _request("/logout", { method: "POST" });
	_user = null;
	_readyPromise = Promise.resolve(null);
	return { ok: true };
}

async function updateProfile(displayName, avatarColor, bio) {
	const res = await _request("/profile", {
		method: "POST",
		body: { display_name: displayName, avatar_color: avatarColor, bio: bio },
	});
	if (!res.ok) return { ok: false, message: res.message };
	_user = _shape(res.user);
	_readyPromise = Promise.resolve(_user);
	return { ok: true, user: _user };
}

/* ---------- email verification ----------
 * Signing up logs you straight in: there is no mail provider wired up, so
 * there is no code to send. These remain so the old verify screen degrades
 * gracefully instead of throwing. */

function getPendingOtp() { return null; }

async function verifyOtp() {
	return { ok: false, message: "Email verification isn't required - just log in." };
}

async function resendOtp() {
	return { ok: false, message: "Email verification isn't required - just log in." };
}

async function syncProfileIfNeeded() { /* the server is the source of truth */ }

// Start fetching immediately so pages that await authReady() don't add a
// round-trip of their own.
authReady();
