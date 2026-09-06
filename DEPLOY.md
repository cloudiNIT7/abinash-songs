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
`/album/`, `/artist/`, `/lyrics/`, `/browse/`, `/result/`) and stores the
finished JSON in `caches.default`. Pages Functions responses are not cached by
Cloudflare on their own, so without this every hit costs a Function invocation
plus the decrypt/format work.

- Freshness comes from each response's own `Cache-Control`, set through
  `json({ maxAge, swr })`. `fail()` uses `max-age=0` and is never stored.
- Past `max-age`, an entry inside its `stale-while-revalidate` window is served
  immediately while one request refreshes it behind the scenes - so a popular
  entry expiring does not send a herd upstream.
- If JioSaavn is failing, an expired copy is served rather than an error
  (`X-Cache: STALE-ERROR`). Entries are kept for a day beyond their stale window
  purely for that.
- Cache keys use only the meaningful params, sorted, with search terms trimmed
  and lower-cased, so `?query=Kesariya`, `?query=kesariya%20` and
  `?query=kesariya&fbclid=…` are one entry. Link-valued queries keep their case,
  because JioSaavn permalink tokens are case-sensitive.
- Searches longer than 200 characters are refused with 414 before any subrequest.

Every response carries `X-Cache: HIT | STALE | STALE-ERROR | MISS`, which is the
quickest way to see whether traffic is actually being absorbed:

```sh
curl -sI "https://abinash-songs.pages.dev/artist/?query=arijit+singh" | grep -i x-cache
```

On the authenticated side, `currentUser()` resolves the account and its session
in a single D1 query, and the session's "last active" write is handed to
`waitUntil` so it never sits on the response path. The player's session poll
follows what the tab is doing: every 20s while it is playing, every 60s when it
is idle, plus an immediate check on focus, tab switch and reconnect.

Not available on this project yet, because it is served from `pages.dev` with no
custom domain and therefore no zone: WAF rate limiting rules, Cache Rules, and
tiered-cache configuration. Adding a custom domain unlocks all three, and a
per-IP rate limiting rule on `/song/*`, `/artist/*` and `/api/auth/login` would
be the first thing worth adding. Note also that concurrent misses for the same
cold key are not collapsed - each one runs the handler - so a brand-new viral
entry still costs one upstream call per concurrent request until the first store
lands.

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
