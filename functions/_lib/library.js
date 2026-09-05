/**
 * Per-account library stored in D1: recently played, play counts, likes and
 * recent searches. Everything is keyed by user_id, so each account has its own
 * history that follows it across devices and never mixes with another account.
 */

const RECENT_LIMIT = 50;
const TOP_LIMIT = 20;
const LIKES_LIMIT = 200;
const SEARCH_LIMIT = 20;

/** Keep only the fields the UI needs to render and play a track. */
export function slimTrack(t) {
	if (!t || !t.id) return null;
	return {
		id: String(t.id),
		url: t.url || "",
		art: t.art || "",
		name: t.name || "Untitled",
		artist: t.artist || "",
		album: t.album || "",
		year: t.year || "",
		duration: t.duration || "",
	};
}

export async function recordPlay(env, userId, track) {
	const slim = slimTrack(track);
	if (!slim) return;
	const now = Date.now();
	// Upsert: bump the count and refresh the stored copy + timestamp, without
	// disturbing the like state.
	await env.DB.prepare(
		`INSERT INTO user_tracks (user_id, track_id, track_json, play_count, last_played_at, liked, liked_at)
		 VALUES (?, ?, ?, 1, ?, 0, NULL)
		 ON CONFLICT(user_id, track_id) DO UPDATE SET
		   play_count = play_count + 1,
		   last_played_at = excluded.last_played_at,
		   track_json = excluded.track_json`,
	).bind(userId, slim.id, JSON.stringify(slim), now).run();
}

export async function setLike(env, userId, track, liked) {
	const slim = slimTrack(track);
	if (!slim) return;
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO user_tracks (user_id, track_id, track_json, play_count, last_played_at, liked, liked_at)
		 VALUES (?, ?, ?, 0, NULL, ?, ?)
		 ON CONFLICT(user_id, track_id) DO UPDATE SET
		   liked = ?,
		   liked_at = ?,
		   track_json = excluded.track_json`,
	).bind(userId, slim.id, JSON.stringify(slim), liked ? 1 : 0, liked ? now : null, liked ? 1 : 0, liked ? now : null).run();
}

export async function recordSearch(env, userId, term) {
	const t = String(term || "").trim();
	if (!t || /^https?:\/\//i.test(t)) return;
	await env.DB.prepare(
		`INSERT INTO user_searches (user_id, term, at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id, term) DO UPDATE SET at = excluded.at`,
	).bind(userId, t, Date.now()).run();
	// Trim to the most recent N so the table can't grow without bound.
	await env.DB.prepare(
		`DELETE FROM user_searches WHERE user_id = ? AND term NOT IN (
		   SELECT term FROM user_searches WHERE user_id = ? ORDER BY at DESC LIMIT ?
		 )`,
	).bind(userId, userId, SEARCH_LIMIT).run();
}

function parseTracks(rows) {
	const out = [];
	for (const r of rows || []) {
		try { out.push(JSON.parse(r.track_json)); } catch (e) { /* skip corrupt row */ }
	}
	return out;
}

export async function getLibrary(env, userId) {
	const [recent, top, likes, searches] = await Promise.all([
		env.DB.prepare(
			`SELECT track_json FROM user_tracks WHERE user_id = ? AND last_played_at IS NOT NULL
			 ORDER BY last_played_at DESC LIMIT ?`,
		).bind(userId, RECENT_LIMIT).all(),
		env.DB.prepare(
			`SELECT track_json FROM user_tracks WHERE user_id = ? AND play_count > 0
			 ORDER BY play_count DESC, last_played_at DESC LIMIT ?`,
		).bind(userId, TOP_LIMIT).all(),
		env.DB.prepare(
			`SELECT track_json FROM user_tracks WHERE user_id = ? AND liked = 1
			 ORDER BY liked_at DESC LIMIT ?`,
		).bind(userId, LIKES_LIMIT).all(),
		env.DB.prepare(
			`SELECT term FROM user_searches WHERE user_id = ? ORDER BY at DESC LIMIT ?`,
		).bind(userId, SEARCH_LIMIT).all(),
	]);
	return {
		recent: parseTracks(recent.results),
		top: parseTracks(top.results),
		likes: parseTracks(likes.results),
		searches: (searches.results || []).map((r) => r.term),
	};
}

/** The set of liked track ids, for quickly marking hearts in any list. */
export async function likedIds(env, userId) {
	const rows = await env.DB.prepare(
		"SELECT track_id FROM user_tracks WHERE user_id = ? AND liked = 1",
	).bind(userId).all();
	return (rows.results || []).map((r) => r.track_id);
}
