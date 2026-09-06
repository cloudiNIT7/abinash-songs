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
