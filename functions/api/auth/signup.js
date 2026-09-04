/* POST /api/auth/signup  {username, email, password} */
import {
	hashPassword, createSessionCookie, publicUser, reply, badRequest, readJson,
	normaliseEmail, validateCredentials, randomHex, PBKDF2_ITERATIONS,
} from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	const username = String(body.username || "").trim();
	const password = String(body.password || "");

	const problem = validateCredentials({ email, password, username });
	if (problem) return badRequest(problem);

	const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
	if (existing) return badRequest("An account with that email already exists.", 409);

	const salt = randomHex(16);
	const now = new Date().toISOString();
	const user = {
		id: randomHex(16),
		email,
		username,
		display_name: username,
		bio: "",
		avatar_color: "#1DB954",
		password_hash: await hashPassword(password, salt),
		password_salt: salt,
		iterations: PBKDF2_ITERATIONS,
		profile_complete: 0,
		created_at: now,
		updated_at: now,
	};

	try {
		await env.DB.prepare(
			`INSERT INTO users (id, email, username, display_name, bio, avatar_color,
			                    password_hash, password_salt, iterations, profile_complete,
			                    created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			user.id, user.email, user.username, user.display_name, user.bio, user.avatar_color,
			user.password_hash, user.password_salt, user.iterations, user.profile_complete,
			user.created_at, user.updated_at,
		).run();
	} catch (e) {
		// The unique index is the authority, in case two signups race.
		if (String(e.message || "").includes("UNIQUE")) {
			return badRequest("An account with that email already exists.", 409);
		}
		throw e;
	}

	return reply(
		{ ok: true, user: publicUser(user) },
		{ status: 201, cookie: await createSessionCookie(env, user.id) },
	);
}
