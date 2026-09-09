// ── ROM FILES ARE SERVED FROM A SEPARATE REPO, SAME ORIGIN ──────────────────
// Bemental77/gamedata is a GitHub Pages project site under this site's own apex
// domain, so /gamedata/... is the SAME ORIGIN: no CORS, and cross-origin
// isolation (SharedArrayBuffer) is unaffected. Split out because every push
// re-uploaded ~9 GB of library and a deploy took 960 s, so pushes cancelled each
// other and fixes never published. See deploy.exclude, the OFFSITE-BEGIN block.
//
// SELF-CONTAINED ON PURPOSE: this file is also loaded by the vendored legacy
// page, which sets no window.ASSET_BASE, so it must not depend on one. It still
// PREFERS the page's value when there is one, so a page override stays effective.
// ⚠ typeof, NOT `||`: '' is FALSY, so `window.ASSET_BASE || '/gamedata'` would
// yield '/gamedata' for the REVERTED value and the revert would silently do
// nothing — the worst failure mode for a switch whose job is to be revertible.
var ROM_BASE = (typeof window !== 'undefined' && typeof window.ASSET_BASE === 'string'
                  ? window.ASSET_BASE : '/gamedata') + '/gba/gbaWasm/roms/';
var ROMLIST = [
  {url:ROM_BASE+"Pokemon SoulGold (v1.1.1).gba",title:"Pokemon SoulGold"},
  {url:ROM_BASE+"pokemonUltraViolet.gba",title:"PKMN Ultra Violet"},
  {url:ROM_BASE+"Sim City 2000 (U).gba",title:"Sim City 2000"},
  {url:ROM_BASE+"Sonic Advance 3 (U).gba",title:"Sonic Advance 3"},
  {url:ROM_BASE+"Super Bust-A-Move (U).gba",title:"Super Bust-A-Move"},
  {url:ROM_BASE+"Kirby - Nightmare in Dream Land (U).gba",title:"Kirby Nightmare in Dreamland"},
  {url:ROM_BASE+"Monster Rancher Advance 2 (U).gba",title:"Monster Rancher Advance 2"}
];
