/* POST /api/auth/login  {email, password} */
import {
	verifyPassword, createSessionCookie, publicUser, reply, badRequest, readJson,
	normaliseEmail, checkThrottle, recordFailure, clearFailures, clientKey, issueOtp,
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

	// No account for this email: tell the user to sign up. (This does reveal
	// whether an email is registered - an intentional UX choice here.)
	if (!user) {
		await recordFailure(env, key);
		return reply(
			{ ok: false, noAccount: true, error: "No account found for this email. Please create an account first." },
			{ status: 404 },
		);
	}

	if (!(await verifyPassword(password, user))) {
		await recordFailure(env, key);
		return badRequest("Incorrect password. Please try again.", 401);
	}

	await clearFailures(env, key);

	// An account that never confirmed its email: send a fresh code and send
	// the client to the verify screen instead of signing in.
	if (!user.verified) {
		try {
			await issueOtp(env, email, "login");
		} catch (e) { /* still route to verify; they can hit "resend" */ }
		return reply({ ok: false, requiresOtp: true, email }, { status: 200 });
	}

	return reply(
		{ ok: true, user: publicUser(user) },
		{ cookie: await createSessionCookie(env, user.id) },
	);
}
