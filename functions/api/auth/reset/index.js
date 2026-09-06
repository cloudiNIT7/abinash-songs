/* POST /api/auth/reset  {email, token, password}
   Sets a new password, using the token issued by /api/auth/reset/verify, then
   signs the user in. */
import {
	verifyResetToken, hashPassword, createSessionCookie, publicUser,
	reply, badRequest, readJson, normaliseEmail, validateCredentials, randomHex,
	revokeOtherSessions, PBKDF2_ITERATIONS,
} from "../../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	const token = String(body.token || "");
	const password = String(body.password || "");

	const problem = validateCredentials({ email, password });
	if (problem) return badRequest(problem);

	const tokenInfo = await verifyResetToken(env, token);
	if (!tokenInfo || tokenInfo.email !== email) {
		return badRequest("This reset session has expired. Please start again.", 401);
	}

	const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
	if (!user) return badRequest("No account found for that email.", 404);
	// The token is bound to the password it was issued against; once the
	// password changes the binding no longer matches, so it can't be replayed.
	if (tokenInfo.bind !== user.password_salt) {
		return badRequest("This reset link has already been used. Please start again.", 401);
	}

	const salt = randomHex(16);
	const passwordHash = await hashPassword(password, salt);
	await env.DB.prepare(
		`UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?,
		 verified = 1, updated_at = ? WHERE id = ?`,
	).bind(passwordHash, salt, PBKDF2_ITERATIONS, new Date().toISOString(), user.id).run();

	// A password change ends every existing session: whoever was signed in on
	// the old password (including an attacker) is logged out everywhere.
	try { await revokeOtherSessions(env, user.id, ""); } catch (e) { /* non-fatal */ }

	// Signed in on the new password.
	return reply(
		{ ok: true, user: publicUser({ ...user, verified: 1 }) },
		{ cookie: await createSessionCookie(env, user.id, request) },
	);
}
