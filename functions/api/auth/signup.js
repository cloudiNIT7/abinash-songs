/* POST /api/auth/signup  {username, email, password}
   Creates an unverified account and emails a 6-digit code. No session is
   issued until the code is confirmed at /api/auth/verify. */
import {
	hashPassword, publicUser, reply, badRequest, readJson,
	normaliseEmail, validateCredentials, randomHex, issueOtp, PBKDF2_ITERATIONS,
} from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	const username = String(body.username || "").trim();
	const password = String(body.password || "");

	const problem = validateCredentials({ email, password, username });
	if (problem) return badRequest(problem);

	const existing = await env.DB.prepare("SELECT id, verified FROM users WHERE email = ?").bind(email).first();
	if (existing && existing.verified) {
		return badRequest("An account with that email already exists.", 409);
	}

	const salt = randomHex(16);
	const now = new Date().toISOString();
	const passwordHash = await hashPassword(password, salt);

	if (existing) {
		// An earlier, never-verified signup: overwrite it with the new details
		// rather than blocking the user forever.
		await env.DB.prepare(
			`UPDATE users SET username = ?, display_name = ?, password_hash = ?, password_salt = ?,
			 iterations = ?, profile_complete = 0, verified = 0, updated_at = ? WHERE id = ?`,
		).bind(username, username, passwordHash, salt, PBKDF2_ITERATIONS, now, existing.id).run();
	} else {
		await env.DB.prepare(
			`INSERT INTO users (id, email, username, display_name, bio, avatar_color,
			                    password_hash, password_salt, iterations, profile_complete, verified,
			                    created_at, updated_at)
			 VALUES (?, ?, ?, ?, '', '#1DB954', ?, ?, ?, 0, 0, ?, ?)`,
		).bind(randomHex(16), email, username, username, passwordHash, salt, PBKDF2_ITERATIONS, now, now).run();
	}

	try {
		const sent = await issueOtp(env, email, "signup");
		if (!sent.ok) return badRequest(`Please wait ${sent.retryIn}s before requesting another code.`, 429);
	} catch (e) {
		return badRequest("Couldn't send the verification email. Please try again.", 502);
	}

	return reply({ ok: true, requiresOtp: true, email }, { status: 201 });
}
