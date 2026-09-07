/**
 * POST /api/cron/suggest - send "listen to this" nudges.
 *
 * Pages Functions cannot be scheduled, so this is a plain endpoint that a small
 * Worker with a cron trigger calls (see cron/). It is protected by the
 * CRON_SECRET shared secret, not a user session.
 *
 * Rules, all deliberate - these notifications are unsolicited, and a user who
 * gets annoyed and turns notifications off would also lose the sign-in approval
 * alerts, which are a security feature:
 *   - never outside 09:00-22:00 in the device's own local time
 *   - at most MAX_PER_DAY per account per day
 *   - at least MIN_GAP_HOURS between two nudges
 *   - never to an account that has opted out
 *   - only to accounts that actually have a registered device
 *
 * ?dry=1 reports who would be picked without sending anything.
 */
import { reply, badRequest } from "../../_lib/auth.js";
import { buildSuggestion, localNow } from "../../_lib/suggest.js";
import { suggestToUser } from "../../_lib/push.js";

const MAX_PER_DAY = 2;
const MIN_GAP_HOURS = 5;
const QUIET_BEFORE = 9;         // local hour before which we stay silent
const QUIET_AFTER = 22;         // local hour after which we stay silent
const BATCH = 25;               // accounts considered per run

function today(tz) {
	try {
		return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date());
	} catch (e) {
		return new Date().toISOString().slice(0, 10);
	}
}

export async function onRequestPost({ request, env }) {
	const secret = env.CRON_SECRET;
	if (!secret) return badRequest("Suggestions are not configured on this deployment.", 503);
	const given = request.headers.get("X-Cron-Secret") || "";
	// Length-independent compare is unnecessary here (the secret is not derived
	// from user input), but a plain mismatch must not leak which part differed.
	if (given !== secret) return badRequest("Not authorised.", 401);

	const dry = new URL(request.url).searchParams.get("dry") === "1";
	const now = Math.floor(Date.now() / 1000);
	const origin = new URL(request.url).origin;

	// Accounts with at least one reachable device, newest activity first, plus
	// the location/timezone of their most recent session.
	let rows = [];
	try {
		const res = await env.DB.prepare(
			`SELECT u.id AS user_id,
			        s.lat AS lat, s.lon AS lon, s.tz AS tz,
			        st.last_at AS last_at, st.sent_today AS sent_today,
			        st.day AS day, st.optout AS optout, st.last_song AS last_song
			   FROM users u
			   JOIN (
			      SELECT user_id, MAX(last_seen_at) AS seen
			        FROM sessions WHERE revoked_at = 0 AND expires_at > ?
			       GROUP BY user_id
			   ) live ON live.user_id = u.id
			   LEFT JOIN sessions s ON s.user_id = u.id AND s.last_seen_at = live.seen
			   LEFT JOIN suggest_state st ON st.user_id = u.id
			  WHERE EXISTS (SELECT 1 FROM fcm_tokens f WHERE f.user_id = u.id)
			     OR EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)
			  ORDER BY live.seen DESC
			  LIMIT ?`,
		).bind(now, BATCH).all();
		rows = (res && res.results) || [];
	} catch (e) {
		return badRequest("Suggestion tables are not migrated yet.", 503);
	}

	const picked = [];
	const skipped = [];

	for (const row of rows) {
		if (row.optout) { skipped.push({ user: row.user_id, why: "opted out" }); continue; }

		const tz = row.tz || "UTC";
		const { hour } = localNow(tz);
		if (hour < QUIET_BEFORE || hour >= QUIET_AFTER) {
			skipped.push({ user: row.user_id, why: `quiet hours (local ${hour}:00)` });
			continue;
		}

		const day = today(tz);
		const sentToday = row.day === day ? (row.sent_today || 0) : 0;
		if (sentToday >= MAX_PER_DAY) { skipped.push({ user: row.user_id, why: "daily cap" }); continue; }
		if (row.last_at && now - row.last_at < MIN_GAP_HOURS * 3600) {
			skipped.push({ user: row.user_id, why: "too soon" });
			continue;
		}
		picked.push({ row, tz, day, sentToday });
	}

	if (dry) {
		return reply({ ok: true, dry: true, considered: rows.length, picked: picked.map((p) => p.row.user_id), skipped });
	}

	let sent = 0;
	const results = [];
	for (const p of picked) {
		const suggestion = await buildSuggestion({
			origin,
			lat: typeof p.row.lat === "number" ? p.row.lat : null,
			lon: typeof p.row.lon === "number" ? p.row.lon : null,
			tz: p.tz,
			avoidId: p.row.last_song || "",
		});
		const out = await suggestToUser(env, p.row.user_id, suggestion);
		if (out.sent > 0) {
			sent++;
			try {
				await env.DB.prepare(
					`INSERT INTO suggest_state (user_id, last_at, sent_today, day, optout, last_song)
					 VALUES (?, ?, ?, ?, 0, ?)
					 ON CONFLICT(user_id) DO UPDATE SET
					   last_at = excluded.last_at,
					   sent_today = excluded.sent_today,
					   day = excluded.day,
					   last_song = excluded.last_song`,
				).bind(p.row.user_id, now, p.sentToday + 1, p.day,
					(suggestion.song && suggestion.song.id) || "").run();
			} catch (e) { /* the send already happened; state is best-effort */ }
		}
		results.push({ user: p.row.user_id, title: suggestion.title, devices: out.sent });
	}

	return reply({ ok: true, considered: rows.length, sent, results, skipped });
}
