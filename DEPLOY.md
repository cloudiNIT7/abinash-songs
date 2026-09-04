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

- Accounts are browser-only (`js/auth.js` uses localStorage). That is a demo
  gate, not authentication — anyone can bypass it from devtools. Real accounts
  need a server that owns hashing and sessions.
- Upstream responses are edge-cached briefly (5 min for searches and playlists,
  1 h for lyrics). `/song/get/` is never cached because media URLs expire.
- Pages Functions on the free plan allow 100,000 invocations/day.
