Rive Local - standalone viewer
Packaged 2026-11-03 from production source commit 20eff9b03d3dc94f3724dcffb55dbd31df7564f4.

DEPLOY
1. Copy public/rive-viewer/ into the new site's public document root, so the URL
   is https://YOUR-DOMAIN/rive-viewer/. Keep all files and vendor subdirectories.
   If your static host asks for a publish directory, select public/.
2. Serve index.html at /rive-viewer/. Redirect /rive-viewer to /rive-viewer/.
3. Apply hosting/headers.txt in your web server or hosting configuration to ALL
   /rive-viewer/ responses, including workers. The HTML meta CSP does not replace
   these HTTP headers. headers.txt is a reference, not an automatic host config.
4. Serve .js with a JavaScript MIME type, .css as text/css and .wasm as
   application/wasm. Missing asset URLs must return 404, not an SPA HTML fallback.
5. Use HTTPS. No Next.js, Node server, database, API keys or environment variables
   are needed. No build or npm install is required. All processing stays local.
6. Add canonical and og:url metadata for the final URL if desired. They were
   removed from this portable copy because the new domain is not yet known.

PORTABLE COPY CHANGES
- Base URL changed to /rive-viewer/.
- Original-site canonical and og:url metadata removed.
- PhanithNY footer attribution now links to https://phanithny.com/.
- Application code and bundled runtime/encoder are unchanged from the commit.
- Original third-party licenses and vendor provenance manifest are included.
  Vendor manifest paths refer to the original source repository; SHA256SUMS.txt
  describes the actual files in this standalone package.

LOCAL PREVIEW (not a substitute for checking deployed HTTP headers)
From public/: python3 -m http.server 8080 --bind 127.0.0.1
Open http://127.0.0.1:8080/rive-viewer/ . Do not open index.html using file://.
The Python preview server does not install the production response headers.

VERIFY AFTER UPLOAD
Open a local .riv file; check playback, artboard/View Model/property inspection,
property editing/reset, report download and GPU Optimize. Confirm workers and
Wasm load successfully and check the response headers in browser dev tools.

The package contains only the viewer and hosting notes, no backend or secrets.
Do not upload README.txt, hosting/ or SHA256SUMS.txt as part of the site's content.
