/* POST /api/auth/verify  {email, code}
   Confirms an emailed code, marks the account verified and starts a session. */
import {
	checkOtp, createSessionCookie, publicUser, reply, badRequest, readJson, normaliseEmail,
	recentlyDenied,
} from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	const code = String(body.code || "").trim();
	if (!email || !code) return badRequest("Email and code are required.");

	const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
	if (!user) return badRequest("No pending signup for that email.", 404);

	/* A denial has to be final.
	 *
	 * The login page offers "Email me a code instead" for when no device answers
	 * an approval request. Without this check that fallback also worked after an
	 * explicit *deny*, so a refused sign-in could walk straight in through the
	 * emailed code and the Deny button meant nothing. Checked before the code is
	 * even looked at, so a correct code cannot buy anything. */
	if (user.verified) {
		const denied = await recentlyDenied(env, user.id);
		if (denied) {
			return badRequest(
				`This sign-in was denied from another device. Try again in ${Math.ceil(denied.retryIn / 60)} minute(s), ` +
				`or change your password if it wasn't you.`,
				403,
			);
		}
	}

	const result = await checkOtp(env, email, code);
	if (!result.ok) return badRequest(result.error, 401);

	if (!user.verified) {
		await env.DB.prepare("UPDATE users SET verified = 1, updated_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), user.id).run();
		user.verified = 1;
	}

	return reply(
		{ ok: true, user: publicUser(user) },
		{ cookie: await createSessionCookie(env, user.id, request) },
	);
}
