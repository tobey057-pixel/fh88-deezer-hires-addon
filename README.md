# FH88 Deezer Hi-Res — BitChord addon

A self-hosted BitChord addon built specifically for the requested workflow:

1. Search Deezer's public catalogue.
2. Prefer FLAC (or another lossless file) only from Internet Archive items carrying a recognized permissive Creative Commons/Public Domain license.
3. Fall back to Deezer's official preview when no rights-filtered alternative is found.
4. Report actual codec/container; never relabel MP3 as FLAC or invent sample rate/bit depth.

## Important truth about Hi-Res

This addon cannot unlock Deezer Premium/HiFi full-track streams. Deezer's public API supplies catalogue metadata and short previews, not unrestricted full-length Hi-Res files. FLAC files from Internet Archive are not automatically Hi-Res: this addon does not claim 24-bit/96 kHz unless the source can substantiate those properties. This implementation deliberately does not scrape paid services, bypass DRM, or expose unauthorized streams.

## BitChord compatibility

Uses BitChord's documented JSON addon contract:
- `GET /manifest.json`
- `GET /search?q=...&quality=...`
- `GET /stream/{id}?quality=...`

The manifest intentionally omits the BitChord 1.9.1-only `bitchordAuth` requirement so clients from 1.8.1 can call it. Future compatibility depends on BitChord retaining the documented HTTP/JSON contract. This is a protocol target, not a claim that every historical/future APK has been device-tested.

## Run locally

Requires Docker, or Node.js 20+.

```bash
docker compose up --build
```

Then check:
- `http://localhost:8080/manifest.json`
- `http://localhost:8080/health`
- `http://localhost:8080/search?q=public%20domain%20jazz`

Without Docker:

```bash
npm install
npm start
```

## Deploy for BitChord installation

BitChord requires a publicly reachable HTTPS URL. Deploy this folder to a Node-capable host (for example a service that supports Docker), attach an HTTPS domain, then paste the service root URL into BitChord → Settings → Sources → Add an addon.

The ZIP is the complete addon project, not a hosted public URL. A public URL cannot be honestly supplied until the project is deployed to a hosting account/domain.

## Optional protection

Set `ADDON_API_KEY` in the environment and send the same value as `X-Addon-Key` on API calls. Do not enable this unless your BitChord client/proxy can send the header; the standard addon flow may not provide custom headers. For public deployment, use host-level rate limiting if available.

## License filter

Only Internet Archive items with license URLs matching CC0/Public Domain, CC BY, or CC BY-SA are considered. This is a conservative automated filter, not a legal determination. Verify the specific item rights before commercial or public redistribution. Other licenses are skipped.

## Routes

- `/manifest.json` — addon metadata and quality picker
- `/health` — provider health/configuration
- `/search` — Deezer catalogue + rights-filtered Archive candidates
- `/stream/:id` — authorized direct audio URL or Deezer preview
