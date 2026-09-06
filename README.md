# Cloud Songs

A music streaming web app: a static frontend plus a JioSaavn API that runs as
Cloudflare Pages Functions, so the whole thing deploys as one Pages project
with no separate backend.

Live: https://abinash-songs.pages.dev

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `premium.html`, `help.html`, `download.html` | Marketing pages |
| `login.html`, `verify-otp.html`, `profile.html` | Account flow (browser-only, see note) |
| `Spotify-songs/songs.html` | The web player: search, playlists, queue, lyrics, now-playing |
| `functions/` | The API: `/song/`, `/song/get/`, `/playlist/`, `/album/`, `/artist/`, `/lyrics/`, `/result/` |
| `functions/_lib/cache.js` | Response cache for those endpoints: KV when a `CACHE` namespace is bound, otherwise `caches.default`; TTL + stale-while-revalidate, and a last-good-copy fallback when JioSaavn fails |
| `functions/_lib/des.js` | DES-ECB decrypt for JioSaavn's `encrypted_media_url` (WebCrypto has no DES) |
| `functions/api/auth/` | Signup, login, logout, session and profile endpoints |
| `functions/_lib/auth.js` | PBKDF2 hashing, signed session cookies, login throttling |
| `schema.sql` | D1 schema for `users`, `sessions`, `login_approvals` and `login_attempts` |
| `js/catalogue.js` | Per-language playlist catalogue used by the player |
| `_routes.json`, `_headers`, `.assetsignore` | Pages routing, headers and upload rules |

## Develop

```sh
npm install
npm run dev      # http://127.0.0.1:8788 - static site + Functions
```

## Deploy

Pushing to `main` deploys to production through the Cloudflare Pages Git
integration; other branches get preview URLs. There is no manual step.

See [DEPLOY.md](DEPLOY.md) for details and post-deploy checks.

## Accounts

Real server-side accounts: `/api/auth/*` Functions on top of a D1 database.
Passwords are hashed with PBKDF2-SHA256 and the browser only holds an HttpOnly,
signed session cookie, so accounts work across devices and cannot be forged
client-side. Login is throttled per email+IP.

`js/auth.js` is the client for those endpoints. Because the session is fetched
from the server, wait for it before reading the state:

```js
authReady().then(() => { if (!isLoggedIn()) location.href = "./login.html"; });
```

Every sign-in also writes a row to `sessions`, so the account menu's **Devices**
entry can show where the account is logged in (browser, OS, city, last active)
and sign any of them out. A signed-out device stops being able to call the API
at once, and the page it left open notices within about 20 seconds - or as soon
as the tab is focused - and returns to the login screen. A password reset ends
every session the same way.

While an account has a recently-used session, a new sign-in with the right
password is parked in `login_approvals` until one of those devices approves it -
raised there as a pop-up and as an Approve/Deny notification. Denying keeps the
new device out; nothing answers within 5 minutes and it expires. An emailed code
is offered as a fallback for when no device is reachable.
