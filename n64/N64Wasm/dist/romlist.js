// GENERATED 2026-08-29 from the live list in n64/index.html — do not hand-edit.
// WHY: this file had drifted from reality and was silently wrong for tooling.
//   - listed marioo64.z64, which is NOT on disk
//   - duplicated newTetris.z64
//   - omitted superMarioStarRoad.z64 and marioo.z64, both present and both served
// The SITE page does not read it — n64/index.html:896-898 sets window.ROMLIST = []
// and owns its own list — so only the vendored dist page (dist/n64.html:1010) and
// anything that treats this as the ROM inventory consume it. Regenerate from
// n64/index.html whenever the served list changes.
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
//
// KNOWN ASYMMETRY, stated rather than hidden: reverting the site to '' in
// lib/asset_base.js does NOT reach the vendored dist/n64.html, which sets no
// constant and would keep using the default below. That page is not linked from
// the site (n64/index.html owns its own list and sets window.ROMLIST = []), so
// the default is chosen to be right for PRODUCTION. Editing the vendored page to
// load /lib/asset_base.js would close the gap, at the cost of a hand-edit to a
// generated file that a re-vendor would silently drop.
// ⚠ typeof, NOT `||`: '' is FALSY, so `window.ASSET_BASE || '/gamedata'` would
// yield '/gamedata' for the REVERTED value and the revert would silently do
// nothing — the worst failure mode for a switch whose job is to be revertible.
var ROM_BASE = (typeof window !== 'undefined' && typeof window.ASSET_BASE === 'string'
                  ? window.ASSET_BASE : '/gamedata') + '/n64/N64Wasm/roms/';
var ROMLIST = [
  {url:ROM_BASE+"sm64.z64",title:"Super Mario 64"},
  {url:ROM_BASE+"mariokart.z64",title:"Mario Kart 64"},
  {url:ROM_BASE+"oot.z64",title:"Zelda: Ocarina of Time"},
  {url:ROM_BASE+"papermario.z64",title:"Paper Mario"},
  {url:ROM_BASE+"starfox.z64",title:"Star Fox 64"},
  {url:ROM_BASE+"pkmnsnap.z64",title:"Pok\u00e9mon Snap"},
  {url:ROM_BASE+"dk64.z64",title:"Donkey Kong 64"},
  {url:ROM_BASE+"banjo-tooie.z64",title:"Banjo-Tooie"},
  {url:ROM_BASE+"conker.z64",title:"Conker's Bad Fur Day"},
  {url:ROM_BASE+"diddyKongRacing.z64",title:"Diddy Kong Racing"},
  {url:ROM_BASE+"podracer.z64",title:"Star Wars Episode I: Racer"},
  {url:ROM_BASE+"crusin.z64",title:"Cruis'n USA"},
  {url:ROM_BASE+"blitz2001.z64",title:"NFL Blitz 2001"},
  {url:ROM_BASE+"newTetris.z64",title:"The New Tetris"},
  {url:ROM_BASE+"gauntletLegends.z64",title:"Gauntlet Legends"},
  {url:ROM_BASE+"clayFighter.z64",title:"ClayFighter 63\u2153"},
  {url:ROM_BASE+"flyingDragon.z64",title:"Flying Dragon"},
  {url:ROM_BASE+"thewheel.z64",title:"Wheel of Fortune"},
  {url:ROM_BASE+"mariopartynew.z64",title:"Mario Party"},
  {url:ROM_BASE+"dinosaurplanet.z64",title:"Dinosaur Planet"},
  {url:ROM_BASE+"superMarioStarRoad.z64",title:"Super Mario 64: Star Road"},
  {url:ROM_BASE+"zeldaMasterOfTime.z64",title:"Zelda: The Missing Link"},
  {url:ROM_BASE+"bk-jiggiesoftime.z64",title:"Banjo-Kazooie: Jiggies of Time"},
  {url:ROM_BASE+"Banjo-Dreamie.z64",title:"Banjo-Dreamie"},
  {url:ROM_BASE+"banjoChristmas.z64",title:"Banjo-Kazooie: Christmas Edition"},
  {url:ROM_BASE+"starfoxsurvival.z64",title:"Star Fox: Survival"},
  {url:ROM_BASE+"marioo.z64",title:"Super Mario Odyssey 64 (hack)"},
];
