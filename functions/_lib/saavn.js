/**
 * JioSaavn data layer for Cloudflare Pages Functions.
 *
 * This is a direct port of the Python service (JioSaavnAPI: app.py, jiosaavn.py,
 * helper.py) so the existing frontend keeps working unchanged - it still calls
 * /song/, /song/get/, /playlist/, /album/, /lyrics/ and /result/ on its own
 * origin, only now those are Functions instead of Flask routes.
 */

import { decryptMediaUrl } from "./des.js";

const API = "https://www.jiosaavn.com/api.php";
const COMMON = "&_format=json&cc=in&_marker=0%3F_marker%3D0";

export const ENDPOINTS = {
	search: `${API}?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=`,
	songDetails: `${API}?__call=song.getDetails${COMMON}&pids=`,
	albumDetails: `${API}?__call=content.getAlbumDetails${COMMON}&albumid=`,
	playlistDetails: `${API}?__call=playlist.getDetails${COMMON}&listid=`,
	lyrics: `${API}?__call=lyrics.getLyrics&ctx=web6dot0&api_version=4&_format=json&_marker=0%3F_marker%3D0&lyrics_id=`,
	// Artist search is its own call: autocomplete.get mixes in collaboration
	// entries ("Pritam & Arijit Singh") and placeholder art.
	artistSearch: `${API}?__call=search.getArtistResults&_format=json&_marker=0&ctx=web6dot0&api_version=4&p=1&n=12&q=`,
	artistDetails: `${API}?__call=artist.getArtistPageDetails&_format=json&_marker=0&ctx=web6dot0&api_version=4&n_song=50&n_album=20&artistId=`,
};

// JioSaavn rejects some requests without a browser-ish User-Agent.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Upstream GET with Cloudflare edge caching (cf options are ignored in dev). */
async function upstream(url, ttl = 60) {
	const res = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "*/*" },
		cf: { cacheTtl: ttl, cacheEverything: true },
	});
	if (!res.ok) throw new Error(`Upstream request failed (HTTP ${res.status}).`);
	return res;
}

async function upstreamJson(url, ttl = 60) {
	const text = await (await upstream(url, ttl)).text();
	try {
		return JSON.parse(text);
	} catch (e) {
		// JioSaavn occasionally emits invalid JSON (stray control chars).
		return JSON.parse(text.replace(/[\u0000-\u001F]+/g, " "));
	}
}

async function upstreamText(url, ttl = 1800) {
	return (await upstream(url, ttl)).text();
}

/* ---------- helpers ported from helper.py ---------- */

function unescapeEntities(value) {
	return String(value == null ? "" : value)
		.replace(/&quot;/g, "'")
		.replace(/&#039;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function bigImage(url) {
	return String(url || "").replace("150x150", "500x500").replace("50x50", "500x500");
}

/** JioSaavn serves its "no artist photo" placeholders with a 403, so drop them
 *  and let the client fall back to its own art. */
function artistImage(url) {
	const big = bigImage(url);
	return /_i\/3\.0\/[^/]*default/i.test(big) ? "" : big;
}

/** Fill in media_url / media_preview_url and tidy the text fields. */
export async function formatSong(song, lyrics) {
	const data = { ...song };

	try {
		if (!data.encrypted_media_url) throw new Error("no encrypted url");
		data.media_url = decryptMediaUrl(data.encrypted_media_url);
		if (data["320kbps"] !== "true") {
			data.media_url = data.media_url.replace("_320.mp4", "_160.mp4");
		}
		data.media_preview_url = data.media_url
			.replace("_320.mp4", "_96_p.mp4")
			.replace("_160.mp4", "_96_p.mp4")
			.replace("//aac.", "//preview.");
	} catch (e) {
		// Same fallback the Python version used: derive the CDN url from the
		// preview url when there is nothing to decrypt.
		let url = data.media_preview_url || "";
		url = url.replace("preview", "aac");
		url = data["320kbps"] === "true"
			? url.replace("_96_p.mp4", "_320.mp4")
			: url.replace("_96_p.mp4", "_160.mp4");
		data.media_url = url || null;
	}

	for (const field of ["song", "music", "singers", "starring", "album", "primary_artists"]) {
		if (field in data) data[field] = unescapeEntities(data[field]);
	}
	data.image = bigImage(data.image);

	if (lyrics) {
		data.lyrics = data.has_lyrics === "true" ? await getLyrics(data.id).catch(() => null) : null;
	}
	if (typeof data.copyright_text === "string") {
		data.copyright_text = data.copyright_text.replace(/&copy;/g, "\u00a9");
	}
	return data;
}

async function formatSongs(songs, lyrics) {
	return Promise.all((songs || []).map((s) => formatSong(s, lyrics)));
}

/* ---------- ported from jiosaavn.py ---------- */

export async function getSong(id, lyrics) {
	try {
		const res = await upstreamJson(ENDPOINTS.songDetails + encodeURIComponent(id), 60);
		const song = res && res[id];
		return song ? await formatSong(song, lyrics) : null;
	} catch (e) {
		return null;
	}
}

export async function getSongId(url) {
	const html = await upstreamText(url);
	const byPid = html.split('"pid":"')[1];
	if (byPid) return byPid.split('","')[0];
	const chunk = html.split('"song":{"type":"')[1];
	if (!chunk) throw new Error("Could not find a song id in that link.");
	const head = chunk.split('","image":')[0].split('"id":"');
	return head[head.length - 1];
}

export async function searchForSong(query, lyrics, songdata) {
	if (/^https?:/i.test(query) && query.includes("saavn.com")) {
		return getSong(await getSongId(query), lyrics);
	}
	const res = await upstreamJson(ENDPOINTS.search + encodeURIComponent(query), 300);
	const hits = (res && res.songs && res.songs.data) || [];
	if (!songdata) return hits;

	// Python fetched these one by one; at the edge they can go out together.
	const songs = await Promise.all(hits.map((s) => getSong(s.id, lyrics)));
	return songs.filter(Boolean);
}

export async function getPlaylistId(url) {
	const html = await upstreamText(url);
	const byType = html.split('"type":"playlist","id":"')[1];
	if (byType) return byType.split('"')[0];
	const byPage = html.split('"page_id","')[1];
	if (!byPage) throw new Error("Could not find a playlist id in that link.");
	return byPage.split('","')[0];
}

export async function getPlaylist(listId, lyrics) {
	const data = await upstreamJson(ENDPOINTS.playlistDetails + encodeURIComponent(listId), 300);
	if (!data) return null;
	return {
		...data,
		firstname: unescapeEntities(data.firstname),
		listname: unescapeEntities(data.listname),
		songs: await formatSongs(data.songs, lyrics),
	};
}

export async function getAlbumId(url) {
	const html = await upstreamText(url);
	const byAlbum = html.split('"album_id":"')[1];
	if (byAlbum) return byAlbum.split('"')[0];
	const byPage = html.split('"page_id","')[1];
	if (!byPage) throw new Error("Could not find an album id in that link.");
	return byPage.split('","')[0];
}

export async function getAlbum(albumId, lyrics) {
	const data = await upstreamJson(ENDPOINTS.albumDetails + encodeURIComponent(albumId), 300);
	if (!data) return null;
	return {
		...data,
		image: bigImage(data.image),
		name: unescapeEntities(data.name),
		title: unescapeEntities(data.title),
		primary_artists: unescapeEntities(data.primary_artists),
		songs: await formatSongs(data.songs, lyrics),
	};
}

export async function getLyrics(id) {
	const data = await upstreamJson(ENDPOINTS.lyrics + encodeURIComponent(id), 3600);
	return data ? data.lyrics : null;
}

/**
 * Browse by a mood/genre/artist term. Prefers a matching editorial playlist
 * (rich ~50-song result); falls back to the individual songs the autocomplete
 * returns. Used by mood chips and artist chips on the home view.
 */
export async function browseTracks(query, lyrics) {
	const res = await upstreamJson(ENDPOINTS.search + encodeURIComponent(query), 300);
	const playlists = (res && res.playlists && res.playlists.data) || [];
	for (let i = 0; i < playlists.length; i++) {
		const id = playlists[i].id || playlists[i].playlistid;
		if (!id) continue;
		try {
			const full = await getPlaylist(id, lyrics);
			if (full && Array.isArray(full.songs) && full.songs.length) {
				return { label: playlists[i].title || query, songs: full.songs };
			}
		} catch (e) { /* try songs fallback */ }
		break;   // only the top playlist match
	}
	const hits = (res && res.songs && res.songs.data) || [];
	const songs = await Promise.all(hits.map((s) => getSong(s.id, lyrics)));
	return { label: query, songs: songs.filter(Boolean) };
}

/* ---------- artists ---------- */

/**
 * Artist search for the type-ahead. `ctr` is JioSaavn's popularity counter, so
 * sorting by it floats the real artist above near-name collaborations; entries
 * that are really a list of artists ("Vishal & Shekhar Feat. Shreya Ghoshal…")
 * are pushed to the back rather than dropped, in case they are all there is.
 */
export async function searchArtists(query, limit = 6) {
	const combined = /[|;]|,[^,]*,| feat\.? /i;
	const res = await upstreamJson(ENDPOINTS.artistSearch + encodeURIComponent(query), 300);
	const rows = ((res && res.results) || []).filter((a) => a && a.id && a.name);
	return rows
		.map((a, i) => ({ a, i, listy: combined.test(a.name) ? 1 : 0 }))
		.sort((x, y) => x.listy - y.listy || (Number(y.a.ctr) || 0) - (Number(x.a.ctr) || 0) || x.i - y.i)
		.slice(0, limit)
		.map(({ a }) => ({
			id: String(a.id),
			name: unescapeEntities(a.name),
			role: a.role || "Artist",
			image: artistImage(a.image),
			url: a.perma_url || "",
			listeners: Number(a.ctr) || 0,
		}));
}

/** The artist page ships songs with their encrypted urls, in the newer
 *  webapi shape. Flatten one onto the song.getDetails shape the rest of the
 *  app (and formatSong) already speaks, so nothing downstream has to change. */
function flattenWebapiSong(entry) {
	const mi = entry.more_info || {};
	const map = mi.artistMap || {};
	const names = (list) => (Array.isArray(list) ? list.map((a) => a && a.name).filter(Boolean).join(", ") : "");
	const primary = names(map.primary_artists) || names(map.artists) || entry.subtitle || "";
	return {
		id: entry.id,
		song: entry.title,
		album: mi.album || "",
		year: entry.year || "",
		music: names(map.music) || mi.music || "",
		primary_artists: primary,
		singers: names(map.singers) || primary,
		starring: "",
		image: entry.image,
		duration: mi.duration || "",
		language: entry.language || "",
		album_id: mi.album_id || "",
		album_url: mi.album_url || "",
		perma_url: entry.perma_url || "",
		label: mi.label || "",
		copyright_text: mi.copyright_text || "",
		has_lyrics: mi.has_lyrics || "false",
		explicit_content: entry.explicit_content || "0",
		play_count: entry.play_count || "",
		encrypted_media_url: mi.encrypted_media_url || "",
		"320kbps": mi["320kbps"] || "false",
	};
}

/** `bio` arrives as a JSON string of {title, text} sections, with HTML inside. */
function artistBio(raw) {
	if (!raw) return "";
	let sections;
	try {
		sections = JSON.parse(raw);
	} catch (e) {
		sections = null;
	}
	const text = Array.isArray(sections)
		? sections.map((s) => (s && s.text) || "").filter(Boolean).join("\n\n")
		: String(raw);
	return unescapeEntities(text.replace(/<[^>]*>/g, " ")).replace(/[ \t]+/g, " ").trim();
}

function albumCard(entry) {
	return {
		id: String(entry.id || ""),
		title: unescapeEntities(entry.title || ""),
		subtitle: unescapeEntities(entry.subtitle || ""),
		year: entry.year || "",
		image: bigImage(entry.image),
		url: entry.perma_url || "",
	};
}

/**
 * One artist's page: identity, bio, popular songs (playable) and albums.
 * Songs come back already formatted, so the response drops straight into the
 * player and works with the same `{name, songs}` shape as a playlist.
 */
export async function getArtist(artistId, lyrics) {
	const data = await upstreamJson(ENDPOINTS.artistDetails + encodeURIComponent(artistId), 600);
	if (!data || !data.name) return null;

	const topSongs = Object.values(data.topSongs || {}).filter((s) => s && s.id);
	const songs = (await Promise.all(topSongs.map((s) => formatSong(flattenWebapiSong(s), lyrics))))
		.filter((s) => s && s.media_url);

	return {
		status: true,
		id: String(data.artistId || artistId),
		name: unescapeEntities(data.name),
		image: artistImage(data.image),
		role: data.dominantType || "Artist",
		subtitle: unescapeEntities(data.subtitle || ""),
		verified: !!data.isVerified,
		followers: Number(data.follower_count) || 0,
		listeners: Number(data.fan_count) || 0,
		language: data.dominantLanguage || "",
		url: (data.urls && data.urls.overview) || "",
		bio: artistBio(data.bio),
		songs,
		albums: Object.values(data.topAlbums || {}).filter((a) => a && a.id).map(albumCard),
		singles: Object.values(data.singles || {}).filter((a) => a && a.id).map(albumCard),
	};
}

/* ---------- response helpers ---------- */

/**
 * JSON response helper.
 *
 * `maxAge` is how long the answer stays fresh; `swr` (stale-while-revalidate) is
 * how long past that the edge cache in `_lib/cache.js` may still serve it while
 * refreshing behind the request. Answers that must not go stale - anything
 * carrying a media url that might be re-signed upstream - leave `swr` at 0.
 */
export function json(body, { status = 200, maxAge = 60, swr = 0 } = {}) {
	const cacheControl = maxAge > 0
		? `public, max-age=${maxAge}, s-maxage=${maxAge + swr}` +
		  (swr > 0 ? `, stale-while-revalidate=${swr}` : "")
		: "public, max-age=0";
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			// Same-origin app, so no CORS header: nothing else needs this API.
			"Cache-Control": cacheControl,
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export function fail(message, status = 200) {
	// The frontend looks for {status:false, error}, matching the Flask service.
	return json({ status: false, error: message }, { status, maxAge: 0 });
}

/** `?lyrics=` / `?songdata=` parsing, copied from app.py's semantics. */
export function flags(url) {
	const lyricsParam = url.searchParams.get("lyrics");
	const songdataParam = url.searchParams.get("songdata");
	return {
		lyrics: !!lyricsParam && lyricsParam.toLowerCase() !== "false",
		songdata: !(songdataParam && songdataParam.toLowerCase() !== "true"),
	};
}
