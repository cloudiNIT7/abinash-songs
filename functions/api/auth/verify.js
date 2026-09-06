/* POST /api/auth/verify  {email, code}
   Confirms an emailed code, marks the account verified and starts a session. */
import {
	checkOtp, createSessionCookie, publicUser, reply, badRequest, readJson, normaliseEmail,
} from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	const code = String(body.code || "").trim();
	if (!email || !code) return badRequest("Email and code are required.");

	const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
	if (!user) return badRequest("No pending signup for that email.", 404);

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
