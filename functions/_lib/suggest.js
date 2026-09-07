/**
 * "Listen to this" nudges.
 *
 * Builds the occasional notification that suggests something to play - varied by
 * the local hour, the day of the week, and the actual weather where the device
 * is, so it reads like a person noticing the moment rather than a broadcast.
 *
 * Two deliberate constraints, because these are unsolicited:
 *   - They are rate-limited and never sent during local night hours (see
 *     functions/api/cron/suggest.js).
 *   - On Android they use their own notification channel, so muting suggestions
 *     never silences the sign-in approval alerts, which are a security feature.
 *
 * Weather comes from Open-Meteo, which needs no API key. Coordinates are the
 * ones Cloudflare recorded on the device's session. No coordinates, or a failed
 * lookup, simply means the message falls back to time/day flavour.
 */

/* ---------- weather ---------- */

/**
 * Current conditions for a point, or null. Bucketed into the handful of moods
 * we actually write copy for rather than exposing raw codes.
 *
 * WMO weather codes: 0 clear, 1-3 mainly clear/cloudy, 45/48 fog,
 * 51-67 drizzle/rain, 71-77 snow, 80-82 showers, 95-99 thunderstorm.
 */
export async function getWeather(lat, lon) {
	if (typeof lat !== "number" || typeof lon !== "number" || !isFinite(lat) || !isFinite(lon)) return null;
	const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(3) +
		"&longitude=" + lon.toFixed(3) + "&current=temperature_2m,weather_code";
	try {
		const res = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } });
		if (!res.ok) return null;
		const d = await res.json();
		const cur = d && d.current;
		if (!cur) return null;
		const code = Number(cur.weather_code);
		const temp = Number(cur.temperature_2m);
		return { code, temp, kind: weatherKind(code, temp) };
	} catch (e) {
		return null;
	}
}

function weatherKind(code, temp) {
	if (code >= 95) return "storm";
	if (code >= 71 && code <= 77) return "snow";
	if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
	if (code === 45 || code === 48) return "fog";
	if (code <= 1) {
		if (isFinite(temp) && temp >= 33) return "hot";
		if (isFinite(temp) && temp <= 8) return "cold";
		return "clear";
	}
	if (isFinite(temp) && temp <= 8) return "cold";
	return "cloudy";
}

/* ---------- local time ---------- */

/** The device's local hour and weekday, using the timezone on its session. */
export function localNow(tz) {
	const now = new Date();
	try {
		if (tz) {
			const parts = new Intl.DateTimeFormat("en-GB", {
				timeZone: tz, hour: "numeric", weekday: "short", hour12: false,
			}).formatToParts(now);
			const hour = Number((parts.find((p) => p.type === "hour") || {}).value);
			const weekday = (parts.find((p) => p.type === "weekday") || {}).value || "";
			if (isFinite(hour)) return { hour, weekday };
		}
	} catch (e) { /* bad tz: fall through to UTC */ }
	return { hour: now.getUTCHours(), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getUTCDay()] };
}

function partOfDay(hour) {
	if (hour < 5) return "latenight";
	if (hour < 12) return "morning";
	if (hour < 17) return "afternoon";
	if (hour < 21) return "evening";
	return "night";
}

/* ---------- copy ----------
 * Each entry is a title plus the search term used to pick a real track, so the
 * words and the music agree. `mood` is what the player is asked to find. */

const WEATHER_LINES = {
	clear: [
		{ title: "Weather's lovely \u2600\ufe0f", body: "Perfect afternoon for this one.", mood: "feel good hits" },
		{ title: "Nice out there today", body: "Here's something to match it.", mood: "happy songs" },
	],
	rain: [
		{ title: "It's raining where you are \u2601\ufe0f", body: "Rainy day songs, sorted.", mood: "rainy day songs" },
		{ title: "Rain outside?", body: "This suits it perfectly.", mood: "lofi chill" },
	],
	storm: [
		{ title: "Wild weather out there \u26a1", body: "Stay in and turn this up.", mood: "chill acoustic" },
	],
	snow: [
		{ title: "Snowy out \u2744\ufe0f", body: "Something warm for it.", mood: "acoustic covers" },
	],
	fog: [
		{ title: "Foggy morning", body: "Easing into the day with this.", mood: "soft instrumental" },
	],
	hot: [
		{ title: "It's a hot one \u2600\ufe0f", body: "Cool down with this.", mood: "chill summer songs" },
	],
	cold: [
		{ title: "Chilly out there", body: "Something to warm up to.", mood: "soulful songs" },
	],
	cloudy: [
		{ title: "Grey skies today", body: "This lifts it a bit.", mood: "feel good songs" },
	],
};

const TIME_LINES = {
	morning: [
		{ title: "Good morning \u2615", body: "Start the day with this.", mood: "morning songs" },
		{ title: "Morning pick", body: "Ease in gently.", mood: "soft morning acoustic" },
	],
	afternoon: [
		{ title: "Afternoon slump?", body: "This should help.", mood: "upbeat songs" },
		{ title: "Something for right now", body: "Give this a listen.", mood: "trending songs" },
	],
	evening: [
		{ title: "Evening wind-down", body: "Press play on this.", mood: "evening chill songs" },
		{ title: "Made for this hour", body: "Have a listen.", mood: "romantic songs" },
	],
	night: [
		{ title: "Late one tonight?", body: "Something easy for it.", mood: "love songs" },
		{ title: "Night mood \u{1f319}", body: "This fits.", mood: "slow romantic songs" },
	],
	latenight: [
		{ title: "Still up? \u{1f319}", body: "Something quiet for the hour.", mood: "slow songs" },
	],
};

const DAY_LINES = {
	Fri: [{ title: "It's Friday \u{1f389}", body: "Start the weekend properly.", mood: "party songs" }],
	Sat: [{ title: "Weekend mode", body: "Turn this up.", mood: "party hits" }],
	Sun: [{ title: "Slow Sunday", body: "Something gentle.", mood: "sunday chill songs" }],
	Mon: [{ title: "Monday needs this", body: "A lift for the week.", mood: "motivational songs" }],
};

/** Sometimes just a love song, regardless of context. */
const LOVE_LINES = [
	{ title: "Feeling romantic? \u2764\ufe0f", body: "This one's lovely.", mood: "love songs" },
	{ title: "A love song for you", body: "Give it a listen.", mood: "romantic hits" },
];

/* ---------- occasions ----------
 * Fixed-date entries only, so they are correct every year without maintenance.
 * Movable feasts (Diwali, Holi, Eid, Easter) shift with the lunar calendar, so
 * they live in MOVABLE below keyed by exact date - add the years you want
 * rather than having the code guess and get it wrong.
 */
const FIXED_EVENTS = {
	"01-01": { key: "newyear", title: "Happy New Year \u{1f389}", body: "Start it with something good.", mood: "party hits" },
	"02-14": { key: "valentines", title: "Happy Valentine's \u2764\ufe0f", body: "A love song for the day.", mood: "romantic love songs" },
	"06-21": { key: "musicday", title: "It's World Music Day \u{1f3b5}", body: "Celebrate with this.", mood: "greatest hits" },
	"08-15": { key: "independence", title: "Happy Independence Day \u{1f1ee}\u{1f1f3}", body: "Something patriotic.", mood: "patriotic songs" },
	"10-02": { key: "gandhi", title: "Gandhi Jayanti", body: "Something peaceful for today.", mood: "devotional songs" },
	"12-25": { key: "christmas", title: "Merry Christmas \u{1f384}", body: "Christmas songs, ready.", mood: "christmas songs" },
	"12-31": { key: "nye", title: "New Year's Eve \u{1f38a}", body: "See the year out with this.", mood: "party songs" },
};

/**
 * Movable occasions, by exact date. Left empty on purpose: lunar dates differ
 * every year and a wrong guess is worse than no message. Fill in as needed, e.g.
 *   "2026-11-08": { key: "diwali", title: "Happy Diwali \u{1fa94}", ... }
 */
const MOVABLE_EVENTS = {};

/** The occasion for the device's local date, or null. */
export function eventToday(tz) {
	let iso;
	try {
		iso = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date());
	} catch (e) {
		iso = new Date().toISOString().slice(0, 10);
	}
	if (MOVABLE_EVENTS[iso]) return { ...MOVABLE_EVENTS[iso], date: iso };
	const md = iso.slice(5);
	if (FIXED_EVENTS[md]) return { ...FIXED_EVENTS[md], date: iso };
	return null;
}

/* ---------- weather changes ----------
 * Only some transitions are worth interrupting someone for. Rain starting is;
 * "cloudy" drifting to "clear" is not. */
const NOTABLE_CHANGES = new Set(["rain", "storm", "snow", "clear", "hot"]);

/**
 * Is this a weather turn worth a message? True when the bucket has changed and
 * the new one is something a person would actually remark on.
 */
export function weatherWorthMentioning(previous, current) {
	if (!current || !current.kind) return false;
	if (previous === current.kind) return false;      // nothing changed
	if (!NOTABLE_CHANGES.has(current.kind)) return false;
	// "clear" only counts as news if it follows bad weather, not on a first run.
	if (current.kind === "clear" && !["rain", "storm", "snow", "fog"].includes(previous || "")) return false;
	return true;
}

function pick(list) {
	return list[Math.floor(Math.random() * list.length)];
}

/**
 * Choose the line for this moment.
 *
 * When the nudge was *triggered* by something - an occasion, or the weather just
 * turning - that thing is the message; there is no point being reminded it is
 * raining via a line about Tuesday afternoon. Otherwise it is the usual blend of
 * weather, day and hour, with a slice reserved for plain love songs.
 */
export function chooseLine({ weather, hour, weekday, event, reason }) {
	const part = partOfDay(hour);

	// Never send party copy at 2am; late hours get quiet copy whatever the cause.
	if (part === "latenight") return pick(TIME_LINES.latenight);

	if (reason === "event" && event) {
		return { title: event.title, body: event.body, mood: event.mood };
	}
	if (reason === "weather" && weather && WEATHER_LINES[weather.kind]) {
		return pick(WEATHER_LINES[weather.kind]);
	}

	const roll = Math.random();
	if (roll < 0.18) return pick(LOVE_LINES);
	if (weather && WEATHER_LINES[weather.kind] && roll < 0.62) {
		return pick(WEATHER_LINES[weather.kind]);
	}
	if (DAY_LINES[weekday] && roll < 0.8) return pick(DAY_LINES[weekday]);
	return pick(TIME_LINES[part] || TIME_LINES.afternoon);
}

/**
 * Find a real track for a mood, using the site's own search so the suggestion
 * points at something that actually exists.
 * Returns { name, artist, id, image } or null.
 */
export async function pickTrack(origin, mood, avoidId) {
	try {
		const url = origin + "/result/?query=" + encodeURIComponent(mood);
		const res = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } });
		if (!res.ok) return null;
		const data = await res.json();
		const list = Array.isArray(data) ? data : (data && (data.songs || data.results || data.data)) || [];
		const usable = list.filter((s) => s && (s.song || s.title || s.name));
		if (!usable.length) return null;
		// Prefer something other than whatever we suggested last time.
		const fresh = usable.filter((s) => String(s.id || "") !== String(avoidId || ""));
		const chosen = pick(fresh.length ? fresh : usable);
		return {
			id: String(chosen.id || ""),
			name: String(chosen.song || chosen.title || chosen.name || "").trim(),
			artist: String(chosen.primary_artists || chosen.singers || chosen.artist || "").trim(),
			image: bigArt(chosen.image || ""),
		};
	} catch (e) {
		return null;
	}
}

/**
 * JioSaavn hands back whatever size the search felt like - often 150x150, which
 * looks poor blown up in a notification. The CDN serves the same file at other
 * sizes, so ask for 500x500. Must stay https: FCM refuses plain http images.
 */
function bigArt(url) {
	const s = String(url || "").trim();
	if (!/^https:\/\//i.test(s)) return "";
	return s.replace(/(\d{2,3})x\1(?=\.[a-z]+$)/i, "500x500");
}

/**
 * Assemble the finished notification for one device context.
 *
 * `weather` and `event` are passed in because the caller has already had to work
 * them out in order to decide whether to send at all; re-fetching here would
 * double the API calls. Returns { title, body, mood, song } - `song` may be
 * null, in which case the copy still works and tapping just opens the player.
 */
export async function buildSuggestion({ origin, tz, avoidId, weather = null, event = null, reason = "schedule" }) {
	const { hour, weekday } = localNow(tz);
	const line = chooseLine({ weather, hour, weekday, event, reason });
	const song = await pickTrack(origin, line.mood, avoidId);

	let body = line.body;
	if (song && song.name) {
		body = song.artist ? `${song.name} \u2014 ${song.artist}` : song.name;
	}
	return { title: line.title, body, mood: line.mood, song, hour, reason };
}

export { partOfDay };
