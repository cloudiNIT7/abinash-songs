# Cloud Songs

A music streaming web app: a static frontend plus a JioSaavn API that runs as
Cloudflare Pages Functions, so the whole thing deploys as one Pages project
with no separate backend.

Live: https://abinash-songs.pages.dev

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `premium.html`, `help.html`, `download.html` | Marketing pages |
| `login.html`, `verify-otp.html`, `profile-setup.html` | Account flow (browser-only, see note) |
| `Spotify-songs/songs.html` | The web player: search, playlists, queue, lyrics, now-playing |
| `functions/` | The API: `/song/`, `/song/get/`, `/playlist/`, `/album/`, `/lyrics/`, `/result/` |
| `functions/_lib/des.js` | DES-ECB decrypt for JioSaavn's `encrypted_media_url` (WebCrypto has no DES) |
| `functions/api/auth/` | Signup, login, logout, session and profile endpoints |
| `functions/_lib/auth.js` | PBKDF2 hashing, signed session cookies, login throttling |
| `schema.sql` | D1 schema for `users` and `login_attempts` |
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
