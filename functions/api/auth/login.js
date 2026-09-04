/* POST /api/auth/login  {email, password} */
import {
	verifyPassword, createSessionCookie, publicUser, reply, badRequest, readJson,
	normaliseEmail, checkThrottle, recordFailure, clearFailures, clientKey,
} from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	const password = String(body.password || "");
	if (!email || !password) return badRequest("Email and password are required.");

	const key = clientKey(request, email);
	const throttle = await checkThrottle(env, key);
	if (!throttle.allowed) {
		return badRequest(
			`Too many attempts. Try again in ${Math.ceil(throttle.retryIn / 60)} minute(s).`,
			429,
		);
	}

	const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
	// Same message either way, so the response cannot be used to discover which
	// emails have accounts.
	const ok = user ? await verifyPassword(password, user) : false;
	if (!ok) {
		await recordFailure(env, key);
		return badRequest("Incorrect email or password.", 401);
	}

	await clearFailures(env, key);
	return reply(
		{ ok: true, user: publicUser(user) },
		{ cookie: await createSessionCookie(env, user.id) },
	);
}
