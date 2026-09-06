/**
 * Response cache for this project's own API.
 *
 * Pages Functions responses are not cached by Cloudflare on their own, so
 * without this every hit - even the same search from a thousand people - costs a
 * Function invocation plus the decrypt/format work, and (once the upstream
 * subrequest cache expires) another round trip to JioSaavn.
 *
 * Entries go to a KV namespace when one is bound as `CACHE`, which is shared by
 * every machine and every colo, so one miss warms the answer globally. Without
 * that binding it falls back to `caches.default`, which works but only on the
 * machine that stored it - fine, just a patchier hit ratio at low traffic.
 *
 * Freshness comes from the response's own `Cache-Control`, which the handlers
 * set through `json({ maxAge, swr })`:
 *   - `max-age`                 how long the entry is served as fresh
 *   - `stale-while-revalidate`  how long past that it may be served while a
 *                               refresh runs behind the request
 * So `fail()` (max-age=0) is never cached, and a handler that must stay live
 * simply asks for no stale window.
 *
 * The stale window is what stops a traffic spike from becoming a thundering herd
 * on JioSaavn every time a popular entry expires; the error fallback is what
 * stops a bad minute upstream from becoming a bad minute for everyone.
 */

const STAMP = "X-Cached-At";          // unix seconds, written when stored
const POLICY = "X-Cache-Policy";      // the answer's own Cache-Control, kept
                                      // separate from the retention TTL
const ERROR_FALLBACK = 86400;         // extra seconds an entry is kept purely as
                                      // a fallback for when upstream is failing

/** Params that may vary a response. Anything else is dropped from the key, so
 *  tracking junk (?fbclid=…) cannot shard the cache. */
const KEY_PARAMS = ["query", "id", "songdata", "lyrics", "p", "n"];
const MAX_QUERY = 200;                // characters; longer is abuse, not a search

/**
 * Build a stable cache key: only meaningful params, sorted, with search terms
 * normalised so "Kesariya", "kesariya " and "kesariya" are one entry. Values
 * that look like links keep their exact case - JioSaavn permalink tokens are
 * case-sensitive.
 */
function cacheKeyUrl(url) {
	const key = new URL(url.origin + url.pathname);
	const params = [];
	for (const name of KEY_PARAMS) {
		const raw = url.searchParams.get(name);
		if (raw === null) continue;
		let value = raw.trim();
		if (!/^https?:/i.test(value)) value = value.replace(/\s+/g, " ").toLowerCase();
		params.push([name, value]);
	}
	params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	for (const [name, value] of params) key.searchParams.set(name, value);
	return key.toString();
}

function directive(response, name) {
	const match = new RegExp(name + "=(\\d+)").exec(response.headers.get("Cache-Control") || "");
	return match ? Number(match[1]) : 0;
}

/** Copy a response with extra headers (Response headers are immutable). */
function withHeaders(response, extra) {
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries(extra)) headers.set(k, v);
	return new Response(response.body, { status: response.status, headers });
}

/* ---------- where cached entries live ----------
 * Two stores, same semantics:
 *
 *   KV (env.CACHE)  - shared across every machine and every colo, so one miss
 *                     warms the entry for the whole world. Preferred.
 *   caches.default  - always available, but the entry only exists on the
 *                     machine that stored it, so at low traffic the hit ratio
 *                     is patchy. Used when no KV namespace is bound.
 *
 * An entry is { body, contentType, cacheControl, storedAt }. Freshness is
 * decided here from storedAt, not by the store, so both behave identically.
 */

function parseDirective(cacheControl, name) {
	const match = new RegExp(name + "=(\\d+)").exec(cacheControl || "");
	return match ? Number(match[1]) : 0;
}

function kvStore(kv) {
	return {
		name: "kv",
		async read(key) {
			const hit = await kv.getWithMetadata(key, { type: "text", cacheTtl: 60 });
			if (!hit || hit.value === null) return null;
			const meta = hit.metadata || {};
			return {
				body: hit.value,
				contentType: meta.ct || "application/json; charset=utf-8",
				cacheControl: meta.cc || "",
				storedAt: Number(meta.at) || 0,
			};
		},
		async write(key, entry, ttl) {
			await kv.put(key, entry.body, {
				expirationTtl: Math.max(60, ttl),
				metadata: { ct: entry.contentType, cc: entry.cacheControl, at: entry.storedAt },
			});
		},
	};
}

function edgeCacheStore() {
	const cache = caches.default;
	return {
		name: "edge",
		async read(key) {
			const hit = await cache.match(new Request(key, { method: "GET" }));
			if (!hit) return null;
			return {
				body: await hit.text(),
				contentType: hit.headers.get("Content-Type") || "application/json; charset=utf-8",
				// The stored `Cache-Control` is the retention TTL, which is
				// deliberately much longer than the answer's freshness; the
				// policy this module reasons about is kept beside it.
				cacheControl: hit.headers.get(POLICY) || hit.headers.get("Cache-Control") || "",
				storedAt: Number(hit.headers.get(STAMP)) || 0,
			};
		},
		async write(key, entry, ttl) {
			await cache.put(new Request(key, { method: "GET" }), new Response(entry.body, {
				status: 200,
				headers: {
					"Content-Type": entry.contentType,
					// How long Cloudflare keeps the entry: past its freshness
					// window, because an expired copy is still worth having when
					// upstream fails.
					"Cache-Control": `public, max-age=${Math.max(60, ttl)}`,
					[POLICY]: entry.cacheControl,
					[STAMP]: String(entry.storedAt),
					"X-Content-Type-Options": "nosniff",
				},
			}));
		},
	};
}

function pickStore(env) {
	try {
		if (env && env.CACHE && typeof env.CACHE.getWithMetadata === "function") return kvStore(env.CACHE);
	} catch (e) { /* fall through */ }
	try {
		if (typeof caches !== "undefined" && caches.default) return edgeCacheStore();
	} catch (e) { /* no cache available */ }
	return null;
}

function entryResponse(entry, state) {
	const age = Math.max(0, Math.floor(Date.now() / 1000) - entry.storedAt);
	return new Response(entry.body, {
		status: 200,
		headers: {
			"Content-Type": entry.contentType,
			"Cache-Control": entry.cacheControl,
			"X-Content-Type-Options": "nosniff",
			"X-Cache": state,
			Age: String(age),
		},
	});
}

/**
 * Wrap a Pages Function GET handler so its response is served from, and stored
 * in, the cache. Handlers stay unaware of any of this.
 */
export function withEdgeCache(handler) {
	return async function onRequestGetCached(context) {
		const { request, env } = context;
		if (request.method !== "GET") return handler(context);

		const url = new URL(request.url);

		// A search term far longer than any real one is not worth a subrequest.
		const query = url.searchParams.get("query") || "";
		if (query.length > MAX_QUERY && !/^https?:/i.test(query.trim())) {
			return new Response(JSON.stringify({ status: false, error: "That search is too long." }), {
				status: 414,
				headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
			});
		}

		const store = pickStore(env);
		if (!store) return withHeaders(await handler(context), { "X-Cache": "OFF" });

		const key = cacheKeyUrl(url);
		let entry = null;
		try {
			entry = await store.read(key);
		} catch (e) {
			entry = null;                  // a cache problem must never fail a request
		}

		if (entry) {
			const age = Math.max(0, Math.floor(Date.now() / 1000) - entry.storedAt);
			const fresh = parseDirective(entry.cacheControl, "max-age");
			const swr = parseDirective(entry.cacheControl, "stale-while-revalidate");
			if (age <= fresh) return entryResponse(entry, "HIT");
			if (swr > 0 && age <= fresh + swr) {
				// Serve now, refresh behind the request.
				if (context.waitUntil) {
					context.waitUntil(save(store, key, handler(context)).catch(() => {}));
				}
				return entryResponse(entry, "STALE");
			}
		}

		const response = await handler(context);

		// Upstream is failing and we still hold an expired copy: serving
		// yesterday's answer beats showing an error to everyone at once.
		if (entry) {
			const text = await response.clone().text();
			if (response.status !== 200 || FAILURE.test(text)) {
				return entryResponse(entry, "STALE-ERROR");
			}
		}

		if (context.waitUntil) {
			context.waitUntil(save(store, key, response.clone()).catch(() => {}));
		}
		return withHeaders(response, { "X-Cache": "MISS", "X-Cache-Store": store.name });
	};
}

/** Handlers report upstream problems as 200 + {status:false}. */
const FAILURE = /^\s*\{\s*"status"\s*:\s*false/;

/** Store a response if it is worth storing (a real, cacheable success). */
async function save(store, key, responsePromise) {
	const response = await responsePromise;
	if (!response || response.status !== 200) return;
	const cacheControl = response.headers.get("Cache-Control") || "";
	const ttl = parseDirective(cacheControl, "max-age");
	if (ttl <= 0) return;                              // fail() and volatile answers

	const body = await response.clone().text();
	// Caching an error would pin it in place for the whole TTL.
	if (FAILURE.test(body)) return;

	const swr = parseDirective(cacheControl, "stale-while-revalidate");
	await store.write(key, {
		body,
		contentType: response.headers.get("Content-Type") || "application/json; charset=utf-8",
		cacheControl,
		storedAt: Math.floor(Date.now() / 1000),
	}, ttl + swr + ERROR_FALLBACK);
}
