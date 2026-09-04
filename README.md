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
| `js/catalogue.js` | Per-language playlist catalogue used by the player |
| `_routes.json`, `_headers`, `.assetsignore` | Pages routing, headers and upload rules |

## Develop

```sh
npm install
npm run dev      # http://127.0.0.1:8788 - static site + Functions
```

## Deploy

Pushing to `main` deploys automatically via the Cloudflare Pages Git
integration. To deploy from your machine instead:

```sh
npm run deploy
```

See [DEPLOY.md](DEPLOY.md) for details and post-deploy checks.

## Note on accounts

`js/auth.js` stores accounts in `localStorage`. It is a convenience gate for a
demo, **not authentication** — anyone can bypass it from devtools, and accounts
do not travel between devices. Real accounts need a server that owns password
hashing and issues sessions.
