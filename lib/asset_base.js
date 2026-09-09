// ── WHERE THE GAME LIBRARY IS SERVED FROM — ONE CONSTANT, WHOLE SITE ────────
//
// THIS FILE IS THE SWITCH. Flip the one value below and every page follows;
// there is no second copy anywhere. Set it to '' to serve the library out of
// this repo again, exactly as the site did before the split.
//
//     window.ASSET_BASE = '';           // library ships inside this repo
//     window.ASSET_BASE = '/gamedata';  // library served from Bemental77/gamedata
//
// ⚠ THE FALLBACK MUST BE typeof-GUARDED, NEVER `||`. '' IS FALSY, so
// `window.ASSET_BASE || '/gamedata'` yields '/gamedata' for the reverted value
// and the revert silently does nothing — the single worst failure mode for a
// switch whose entire job is to be revertible under pressure. Every consumer
// uses `typeof window.ASSET_BASE === 'string' ? window.ASSET_BASE : <default>`.
//
// WHY THE SPLIT EXISTS. Bemental77/gamedata is a GitHub Pages *project* site
// published under this site's own apex domain, so /gamedata/... is the SAME
// ORIGIN as the page requesting it. That is the whole reason it is not a CDN:
// no CORS, and cross-origin isolation is untouched — these pages need
// SharedArrayBuffer, and coi-serviceworker.js (scope '/') rewrites no URLs, it
// only re-stamps COEP/CORP/COOP onto what it proxies. A third-party host would
// have needed Cross-Origin-Resource-Policy on every ROM; this needs none.
//
// Measured on run 34290489234, the last deploy that actually published:
//   checkout 345 s · stage 48 s · upload 341 s · deploy 223 s = 960 s
// 909 s of that was moving the library, on EVERY push, including one-line HTML
// edits. Deploys ran slower than pushes arrived, so each push cancelled the
// pending deploy and fixes never reached production at all — four Dreamcast
// games sat broken live with their fix committed and pushed. Dropping the five
// library paths takes the artifact from 2,052 files / 9.07 GiB to
// 1,841 files / 0.227 GiB.
//
// ⚠ ORDERING, IF THIS IS EVER CHANGED AGAIN. Production must never point at a
// path that does not resolve. Publish and VERIFY the asset origin first — with
// a real ranged GET, not `curl -I`, because Pages answers HEAD 200 even where
// it honours Range only on GET — and only then flip this value. Verify with:
//   node tools/verify_live_catalogs.mjs
// which resolves every URL the catalogs NAME against the live origin.
//
// See also: deploy.exclude (the OFFSITE-BEGIN block), which keeps these paths
// out of the deploy artifact and is what the CI sparse-checkout is derived from.
window.ASSET_BASE = '/gamedata';
