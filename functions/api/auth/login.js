/* POST /api/auth/login  {email, password} */
import {
	verifyPassword, createSessionCookie, publicUser, reply, badRequest, readJson,
	normaliseEmail, checkThrottle, recordFailure, clearFailures, clientKey, issueOtp,
	countApprovers, createApproval, recentlyDenied,
} from "../../_lib/auth.js";
import { pushToUser } from "../../_lib/push.js";

export async function onRequestPost(context) {
	const { request, env } = context;
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

	/* A recent denial shuts the account for a few minutes.
	 *
	 * Checked after the password so it cannot be used to probe which emails
	 * exist, but before an approval is raised - otherwise a refused attempt
	 * could just try again and again, and every retry would buzz the owner's
	 * phone. The right password is not enough once someone has said no. */
	try {
		const denied = await recentlyDenied(env, user.id);
		if (denied) {
			return reply({
				ok: false,
				denied: true,
				retryIn: denied.retryIn,
				error: `A sign-in was denied from one of your devices. Try again in ${Math.ceil(denied.retryIn / 60)} minute(s).`,
			}, { status: 403 });
		}
	} catch (e) { /* cannot check: fall through to the normal flow */ }

	// An account that never confirmed its email: send a fresh code and send
	// the client to the verify screen instead of signing in.
	if (!user.verified) {
		try {
			await issueOtp(env, email, "login");
		} catch (e) { /* still route to verify; they can hit "resend" */ }
		return reply({ ok: false, requiresOtp: true, email }, { status: 200 });
	}

	// The account is already signed in somewhere: that device decides whether
	// this one gets in. The password alone is no longer enough.
	try {
		if (await countApprovers(env, user.id) > 0) {
			const approval = await createApproval(env, user.id, request);
			// Wake the account's other devices, even if the app is closed there.
			// Best-effort and off the response path: an unreachable phone must
			// not slow this reply down.
			if (context.waitUntil) {
				context.waitUntil(
					pushToUser(env, user.id, { topic: "cs-approval" }).catch(() => {}),
				);
			}
			return reply({
				ok: false,
				requiresApproval: true,
				approvalId: approval.id,
				expiresIn: approval.expiresIn,
				email,
				device: [approval.client.browser, "on", approval.client.os].filter(Boolean).join(" "),
			}, { status: 200 });
		}
	} catch (e) {
		// Approvals not migrated yet, or D1 unavailable: sign in as before
		// rather than locking the account out of its own login.
	}

	return reply(
		{ ok: true, user: publicUser(user) },
		{ cookie: await createSessionCookie(env, user.id, request) },
	);
}
