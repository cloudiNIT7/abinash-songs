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
import { buildSuggestion, localNow, getWeather, eventToday, weatherWorthMentioning } from "../../_lib/suggest.js";
import { suggestToUser } from "../../_lib/push.js";

const MAX_PER_DAY = 4;
// The gap has to fit the cap inside the waking window. With the hourly cron and
// a four-hour spacing, the four nudges land around 09:00 / 13:00 / 17:00 /
// 21:00 local - morning through night, rather than all before tea time.
const MIN_GAP_HOURS = 4;
// An occasion or a weather turn may jump that spacing, but never within this
// many minutes of the last message - otherwise two triggers land together.
const TRIGGER_FLOOR_MINUTES = 75;
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
			        st.day AS day, st.optout AS optout, st.last_song AS last_song,
			        st.last_weather AS last_weather, st.event_day AS event_day
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
		// Quiet hours are absolute: no occasion or downpour justifies 3am.
		if (hour < QUIET_BEFORE || hour >= QUIET_AFTER) {
			skipped.push({ user: row.user_id, why: `quiet hours (local ${hour}:00)` });
			continue;
		}

		const day = today(tz);
		const sentToday = row.day === day ? (row.sent_today || 0) : 0;
		// The daily cap is also absolute - triggers change *when* and *what*, not
		// how much, so a stormy Valentine's Day cannot turn into a pile-on.
		if (sentToday >= MAX_PER_DAY) { skipped.push({ user: row.user_id, why: "daily cap" }); continue; }

		// What might justify a message right now?
		const lat = typeof row.lat === "number" ? row.lat : null;
		const lon = typeof row.lon === "number" ? row.lon : null;
		const weather = await getWeather(lat, lon);
		const event = eventToday(tz);

		const isEvent = !!event && row.event_day !== day;            // once per occasion
		const isWeatherTurn = weatherWorthMentioning(row.last_weather, weather);
		const dueBySchedule = !row.last_at || (now - row.last_at >= MIN_GAP_HOURS * 3600);

		// An occasion or a genuine change in the weather is allowed to jump the
		// spacing rule, because "it just started raining" is only interesting now.
		// A short floor still applies so two triggers cannot fire back to back.
		const recentlyMessaged = row.last_at && (now - row.last_at < TRIGGER_FLOOR_MINUTES * 60);

		let reason = null;
		if (isEvent && !recentlyMessaged) reason = "event";
		else if (isWeatherTurn && !recentlyMessaged) reason = "weather";
		else if (dueBySchedule) reason = "schedule";

		if (!reason) {
			skipped.push({
				user: row.user_id,
				why: recentlyMessaged ? "just messaged" : "too soon",
			});
			// Still record the weather, so the *next* run compares against now
			// rather than treating an old reading as the change.
			if (weather) await rememberWeather(env, row.user_id, weather.kind);
			continue;
		}
		picked.push({ row, tz, day, sentToday, weather, event, reason });
	}

	if (dry) {
		return reply({
			ok: true, dry: true, considered: rows.length,
			picked: picked.map((p) => ({ user: p.row.user_id, reason: p.reason, weather: p.weather && p.weather.kind, event: p.event && p.event.key })),
			skipped,
		});
	}

	let sent = 0;
	const results = [];
	for (const p of picked) {
		const suggestion = await buildSuggestion({
			origin,
			tz: p.tz,
			avoidId: p.row.last_song || "",
			weather: p.weather,
			event: p.event,
			reason: p.reason,
		});
		const out = await suggestToUser(env, p.row.user_id, suggestion);
		if (out.sent > 0) {
			sent++;
			try {
				await env.DB.prepare(
					`INSERT INTO suggest_state (user_id, last_at, sent_today, day, optout, last_song, last_weather, event_day)
					 VALUES (?, ?, ?, ?, 0, ?, ?, ?)
					 ON CONFLICT(user_id) DO UPDATE SET
					   last_at = excluded.last_at,
					   sent_today = excluded.sent_today,
					   day = excluded.day,
					   last_song = excluded.last_song,
					   last_weather = excluded.last_weather,
					   event_day = excluded.event_day`,
				).bind(p.row.user_id, now, p.sentToday + 1, p.day,
					(suggestion.song && suggestion.song.id) || "",
					(p.weather && p.weather.kind) || null,
					p.reason === "event" ? p.day : (p.row.event_day || null)).run();
			} catch (e) { /* the send already happened; state is best-effort */ }
		}
		results.push({ user: p.row.user_id, reason: p.reason, title: suggestion.title, devices: out.sent });
	}

	return reply({ ok: true, considered: rows.length, sent, results, skipped });
}

/** Keep the stored condition current even when we do not send, so a change is
 *  measured against the last reading rather than a stale one. */
async function rememberWeather(env, userId, kind) {
	try {
		await env.DB.prepare(
			`INSERT INTO suggest_state (user_id, last_weather) VALUES (?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET last_weather = excluded.last_weather`,
		).bind(userId, kind).run();
	} catch (e) { /* non-fatal */ }
}
