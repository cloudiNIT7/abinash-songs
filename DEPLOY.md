# Deploying Cloud Songs to Cloudflare Pages

The whole app runs on Pages: the pages/CSS/JS are static assets, and the
JioSaavn API that used to be a Flask service (`JioSaavnAPI/`) is now Pages
Functions under `functions/`. The frontend still calls `/song/`, `/song/get/`,
`/playlist/`, `/album/`, `/lyrics/` and `/result/` on its own origin, so no
frontend code changed and there is no CORS to configure.

## One-time setup

```sh
cd Spotify-jiosaavn
npm install          # installs wrangler locally
npx wrangler login   # opens a browser to authorise your Cloudflare account
```

## Deploy

```sh
npm run deploy       # wrangler pages deploy . --project-name cloud-songs
```

The first run asks to create the project and pick a production branch. After it
finishes you get a `https://cloud-songs.pages.dev` URL. Add a custom domain in
the dashboard under **Workers & Pages → cloud-songs → Custom domains**.

## Local development

```sh
npm run dev          # http://127.0.0.1:8788, static site + Functions
```

`python app.py` in `JioSaavnAPI/` is no longer needed, though it still works if
you prefer the Flask backend locally.

## Verify a deployment

```sh
curl -s "https://<your-domain>/song/?query=kesariya&songdata=false" | head -c 120
curl -o /dev/null -w "%{http_code}\n" "https://<your-domain>/functions/_lib/saavn.js"   # must be 404
```

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

- Accounts are still browser-only (`js/auth.js` uses localStorage). That is a
  demo gate, not authentication — anyone can bypass it from devtools. Real
  accounts need a server that owns hashing and sessions.
- Upstream responses are edge-cached briefly (5 min for searches and
  playlists, 1 h for lyrics). `/song/get/` is never cached because media URLs
  expire.
- Pages Functions on the free plan allow 100,000 invocations/day.
