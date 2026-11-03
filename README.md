# Rive Local

A standalone browser viewer for inspecting `.riv` files from designers. Files are processed locally: no uploads, accounts or backend are required.

## Features

- Artboard, animation and state machine playback.
- Live property inspection and editing, saved instances, and unique file View Models.
- Artboard-to-View-Model relationships, property search, pinned values and reset.
- Local JSON/Markdown handoff reports and comparison with an earlier export.
- Browser-based GPU texture optimization and optimized-package preview.

## Deploy at `/rive-viewer/`

1. Copy `public/rive-viewer/` to your site's public document root, or use `public/` as the static publish directory.
2. Serve `/rive-viewer/index.html` at `/rive-viewer/` and redirect `/rive-viewer` to `/rive-viewer/`.
3. Apply the HTTP response headers in [hosting/headers.txt](hosting/headers.txt) to the viewer and every asset beneath it, including workers. That file is a reference; configure your host to send the headers.
4. Serve JavaScript and CSS with their correct MIME types, and Wasm as `application/wasm`. Missing assets must return 404 rather than an SPA fallback page.
5. Use HTTPS. No build step, Node server, database or environment variables are needed.

The package is configured for the `/rive-viewer/` path. To host at another path, update `<base href="/rive-viewer/">` in `public/rive-viewer/index.html` and configure the corresponding routing and headers.

## Local preview

```sh
cd public
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://127.0.0.1:8080/rive-viewer/>. This preview server does not install the production HTTP headers. Do not open the page with `file://`.

## Download

Download `rive-viewer-standalone.zip` from this repository's Releases page. It contains the static viewer, hosting notes, licenses and file checksums.

## Provenance and licenses

This standalone distribution was prepared on 2026-11-03 from the reviewed production viewer at source commit `20eff9b03d3dc94f3724dcffb55dbd31df7564f4`. The portable HTML changes its base path, removes the original site's canonical/OG URL, and uses an absolute attribution link. Runtime and application JavaScript are unchanged.

Third-party notices are retained under `public/rive-viewer/vendor/`. The vendor manifest records paths in the original source repository. `SHA256SUMS.txt` verifies the extracted ZIP files; `README.md` and `.gitignore` are additional repository documentation.

See [README.txt](README.txt) for the complete package and deployment notes.
