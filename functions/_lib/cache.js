/**
 * Edge cache for this project's own API responses.
 *
 * Pages Functions responses are not stored in Cloudflare's cache by themselves,
 * so without this every hit - even the same search from a thousand people -
 * costs a Function invocation plus the decrypt/format work, and (once the
 * upstream subrequest cache expires) another round trip to JioSaavn. Storing our
 * finished JSON in `caches.default` collapses that into one miss per colo per
 * TTL.
 *
 * Freshness comes from the response's own `Cache-Control`, which the handlers
 * already set through `json({ maxAge, swr })`:
 *   - `max-age`                 how long the entry is served as fresh
 *   - `stale-while-revalidate`  how long past that it may be served while a
 *                               refresh runs behind the request
 * So `fail()` (max-age=0) is never cached, and a handler that must stay live
 * (media urls) simply asks for no stale window.
 *
 * The stale window is what stops a traffic spike from becoming a thundering herd
 * on JioSaavn every time a popular entry expires.
 */

const STAMP = "X-Cached-At";          // unix seconds, written when stored
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

/**
 * Wrap a Pages Function GET handler so its response is served from, and stored
 * in, the edge cache. Handlers stay unaware of any of this.
 */
export function withEdgeCache(handler) {
	return async function onRequestGetCached(context) {
		const { request } = context;
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

		const cache = caches.default;
		const keyRequest = new Request(cacheKeyUrl(url), { method: "GET" });

		let hit = null;
		try {
			hit = await cache.match(keyRequest);
		} catch (e) {
			hit = null;                    // no cache in this environment: just serve
		}

		let age = 0;
		if (hit) {
			age = Math.max(0, Math.floor(Date.now() / 1000) - Number(hit.headers.get(STAMP) || 0));
			const fresh = directive(hit, "max-age");
			const swr = directive(hit, "stale-while-revalidate");
			if (age <= fresh) {
				return withHeaders(hit, { "X-Cache": "HIT", Age: String(age) });
			}
			if (swr > 0 && age <= fresh + swr) {
				// Serve now, refresh behind the request.
				if (context.waitUntil) {
					context.waitUntil(store(cache, keyRequest, handler(context)).catch(() => {}));
				}
				return withHeaders(hit, { "X-Cache": "STALE", Age: String(age) });
			}
		}

		const response = await handler(context);

		// Upstream is down and we still hold an expired copy: serving yesterday's
		// answer beats showing an error to everyone at once. This is the
		// difference between JioSaavn having a bad minute and the app being down.
		if (hit) {
			const text = await response.clone().text();
			if (response.status !== 200 || FAILURE.test(text)) {
				return withHeaders(hit, { "X-Cache": "STALE-ERROR", Age: String(age) });
			}
		}

		if (context.waitUntil) {
			context.waitUntil(store(cache, keyRequest, response.clone()).catch(() => {}));
		}
		return withHeaders(response, { "X-Cache": "MISS" });
	};
}

/** Handlers report upstream problems as 200 + {status:false}. */
const FAILURE = /^\s*\{\s*"status"\s*:\s*false/;

/** Store a response if it is worth storing (a real, cacheable success). */
async function store(cache, keyRequest, responsePromise) {
	const response = await responsePromise;
	if (!response || response.status !== 200) return;
	const ttl = directive(response, "max-age");
	if (ttl <= 0) return;                              // fail() and volatile answers

	const body = await response.clone().text();
	// Caching an error would pin it in place for the whole TTL.
	if (FAILURE.test(body)) return;

	const headers = new Headers(response.headers);
	headers.set(STAMP, String(Math.floor(Date.now() / 1000)));
	// Keep the entry in cache storage well past its freshness window: this code
	// decides what is fresh from the stamp above, and an expired copy is still
	// worth having when upstream fails.
	const swr = directive(response, "stale-while-revalidate");
	headers.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl + swr + ERROR_FALLBACK}` +
		(swr > 0 ? `, stale-while-revalidate=${swr}` : ""));
	await cache.put(keyRequest, new Response(body, { status: 200, headers }));
}
