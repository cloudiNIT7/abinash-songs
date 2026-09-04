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
	return String(url || "").replace("150x150", "500x500");
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

/* ---------- response helpers ---------- */

export function json(body, { status = 200, maxAge = 60 } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			// Same-origin app, so no CORS header: nothing else needs this API.
			"Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
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
