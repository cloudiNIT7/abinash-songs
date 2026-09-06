# Deploying Cloud Songs

The whole app runs on Cloudflare Pages: the pages/CSS/JS are static assets, and
the JioSaavn API that used to be a Flask service (`JioSaavnAPI/`) is now Pages
Functions under `functions/`. The frontend still calls `/song/`, `/song/get/`,
`/playlist/`, `/album/`, `/lyrics/` and `/result/` on its own origin, so there
is no CORS to configure and no separate backend to host.

- **Project:** `abinash-songs` — https://abinash-songs.pages.dev
- **Repo:** https://github.com/cloudiNIT7/abinash-songs (production branch `main`)

## Deploy

Push to `main`. That is the whole deploy process:

```sh
git add -A
git commit -m "what changed"
git push
```

Cloudflare clones the repo, bundles `functions/`, uploads the static files and
publishes - about a minute end to end. Any other branch gets its own preview
URL instead of touching production.

Watch a build in the dashboard: **Workers & Pages → abinash-songs → Deployments**.

## Local development

```sh
npm install
npm run dev      # http://127.0.0.1:8788 - static site + Functions
```

`python app.py` in `JioSaavnAPI/` is no longer needed, though it still works if
you prefer the Flask backend locally.

## Verify a deployment

```sh
curl -s "https://abinash-songs.pages.dev/song/?query=kesariya&songdata=false" | head -c 120
curl -s "https://abinash-songs.pages.dev/artist/?query=arijit+singh" | head -c 120
curl -o /dev/null -w "%{http_code}\n" "https://abinash-songs.pages.dev/functions/_lib/saavn.js"   # must be 404
```

## Accounts

Accounts are server-side: Pages Functions under `/api/auth/*` backed by the D1
database `cloud-songs-auth` (schema in `schema.sql`). Passwords are hashed with
PBKDF2-SHA256 (210k iterations) and the browser only receives an HttpOnly,
`Secure`, `SameSite=Lax` cookie signed with `SESSION_SECRET`, so a session
cannot be forged from devtools the way the old localStorage gate could.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/signup` | Create an account and sign in |
| `POST /api/auth/login` | Sign in (throttled: 8 tries per email+IP, then a 15 min lockout) |
| `POST /api/auth/logout` | Clear the session cookie |
| `GET /api/auth/me` | Current user; every page calls this once via `authReady()` |
| `POST /api/auth/profile` | Save display name, colour and bio |
| `GET /api/me/devices` | Devices this account is signed in on |
| `POST /api/me/devices` | `{id}` signs one device out, `{all:true}` signs out every other device |

Bindings on the Pages project (production and preview):

- `DB` → D1 database `cloud-songs-auth`
- `SESSION_SECRET` → secret text

To apply a schema change:

```sh
npx wrangler d1 execute cloud-songs-auth --remote --file schema.sql
```

Migrations are numbered files under `migrations/`, applied the same way:

```sh
npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0005_sessions.sql
```

`0005_sessions.sql` backs the Devices list. Until it is applied the list simply
reports that device history isn't available yet; nothing else breaks.

There is no email provider, so there is no verification code: signing up logs
you straight in and `verify-otp.html` just forwards you on.

## High traffic

The API is read-heavy and the same handful of searches, playlists and artists
account for most of it, so the work is done once per colo instead of once per
request.

`functions/_lib/cache.js` wraps every read endpoint (`/song/`, `/playlist/`,
`/album/`, `/artist/`, `/lyrics/`, `/browse/`, `/result/`) and caches the
finished JSON. Pages Functions responses are not cached by Cloudflare on their
own, so without this every hit costs a Function invocation plus the
decrypt/format work.

Where entries live depends on the bindings:

| Store | When | Reach |
| --- | --- | --- |
| KV namespace bound as `CACHE` | preferred | shared by every machine and colo: one miss warms the answer globally |
| `caches.default` | fallback, no binding needed | only the machine that stored it, so a patchy hit ratio until traffic is high |

A namespace already exists for this - `CACHE`, id
`6b3a76872b414a1f87ae744452003d99`. To switch the cache over to it, add the
binding once: **Pages project → Settings → Functions → KV namespace bindings →
Add**, variable name `CACHE`. Nothing else changes; `X-Cache-Store: kv` on a miss
confirms it took effect. (Do not move these bindings into a `wrangler.toml`: for
Pages, that file becomes the source of truth and the dashboard's `DB` and
`SESSION_SECRET` bindings would be dropped.)

Freshness comes from each response's own `Cache-Control`, set through
`json({ maxAge, swr })`:

- `fail()` uses `max-age=0` and is never stored, and neither is a `200` whose
  body is `{status:false}` - caching an upstream error would pin it in place.
- Past `max-age`, an entry inside its `stale-while-revalidate` window is served
  immediately while one request refreshes it behind the scenes, so a popular
  entry expiring does not send a herd upstream.
- If JioSaavn is failing, an expired copy is served instead of an error
  (`X-Cache: STALE-ERROR`). Entries are kept a day beyond their stale window
  purely for that.
- Cache keys use only the meaningful params, sorted, with search terms trimmed
  and lower-cased, so `?query=Kesariya`, `?query=kesariya%20` and
  `?query=kesariya&fbclid=…` are one entry. Link-valued queries keep their case,
  because JioSaavn permalink tokens are case-sensitive.
- Searches longer than 200 characters are refused with 414 before any subrequest.

Every response carries `X-Cache: HIT | STALE | STALE-ERROR | MISS | OFF`, which
is the quickest way to see whether traffic is being absorbed:

```sh
curl -s -o /dev/null -D - "https://abinash-songs.pages.dev/artist/?query=arijit+singh" | grep -i x-cache
```

On the authenticated side, `currentUser()` resolves the account and its session
in a single D1 query, and the session's "last active" write is handed to
`waitUntil` so it never sits on the response path. The player's session poll
follows what the tab is doing: every 20s while it is playing, every 60s when it
is idle, plus an immediate check on focus, tab switch and reconnect.

Still worth doing, but not possible while the site is only on `pages.dev` with no
zone: WAF rate limiting rules (per-IP, on `/song/*`, `/artist/*` and
`/api/auth/login` first), Cache Rules, and tiered caching. Adding a custom domain
unlocks all three. Note also that concurrent misses for the same cold key are not
collapsed - each one runs the handler - so a brand-new viral entry still costs one
upstream call per concurrent request until the first store lands.

## Manual upload (fallback only)

If Git is unavailable, `npm run deploy:manual` uploads the working directory
straight to the same project. Prefer `git push`, so that what is live always
matches a commit.

## What is where

| Path | Purpose |
| --- | --- |
| `functions/_lib/saavn.js` | JioSaavn client: search, song, playlist, album, lyrics |
| `functions/_lib/des.js` | DES-ECB decryption of `encrypted_media_url` (WebCrypto has no DES) |
| `functions/_middleware.js` | 404s the project's own plumbing (`/functions/*`, `node_modules`, …) |
| `_routes.json` | Only API paths invoke Functions; static requests stay free |
| `_headers` | Security headers, long cache for assets, `no-cache` for HTML |
| `.assetsignore` | Keeps tooling files out of the uploaded assets |

## Notes

- Sessions last 30 days. Rotating `SESSION_SECRET` signs every existing
  session out.
- Upstream responses are edge-cached briefly (5 min for searches and playlists,
  1 h for lyrics). `/song/get/` is never cached because media URLs expire.
- Pages Functions on the free plan allow 100,000 invocations/day.
