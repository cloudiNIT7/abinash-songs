/* POST /api/auth/profile  {display_name, avatar_color, bio} - finishes setup */
import { currentUser, publicUser, reply, badRequest, readJson } from "../../_lib/auth.js";

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

export async function onRequestPost({ request, env }) {
	const user = await currentUser(request, env);
	if (!user) return badRequest("You are not signed in.", 401);

	const body = await readJson(request);
	const displayName = String(body.display_name || "").trim();
	const bio = String(body.bio || "").trim();
	const colour = String(body.avatar_color || "").trim();

	if (displayName.length < 2 || displayName.length > 40) {
		return badRequest("Display name must be between 2 and 40 characters.");
	}
	if (bio.length > 300) return badRequest("Bio must be 300 characters or fewer.");
	if (colour && !HEX_COLOUR.test(colour)) return badRequest("Pick a valid colour.");

	await env.DB.prepare(
		`UPDATE users SET display_name = ?, bio = ?, avatar_color = ?, profile_complete = 1,
		 updated_at = ? WHERE id = ?`,
	).bind(displayName, bio, colour || "#1DB954", new Date().toISOString(), user.id).run();

	const updated = await env.DB.prepare(
		"SELECT id, email, username, display_name, bio, avatar_color, avatar_url, pref_lang, profile_complete, created_at FROM users WHERE id = ?",
	).bind(user.id).first();

	return reply({ ok: true, user: publicUser(updated) });
}
