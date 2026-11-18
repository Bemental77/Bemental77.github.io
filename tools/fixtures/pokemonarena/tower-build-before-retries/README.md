# The Tower build before retries (a test fixture: do not edit)

The five Tower modules exactly as they stood at commit `d4466048`, the last one in which a lost floor ended the run:
`tower_record.js`, `tower.js`, `tower_session.js`, `tower_fight.js`, `achievements.js`.

`tools/pokemonarena_tower_test.mjs` (group **O**) copies the current `pokemonarena/js` into a temporary folder, puts these five files over it, and loads the result as **the old build**: a page that still holds the old code for one cache lifetime, or a tab left open across the deploy. It then shows that build records written by the current one (a climb with retries, a record with the retry keys) and checks exactly what it does with them, and that nothing is lost when the current build opens the profile again. `pokemonarena/TOWER.md` section 11 states the result.

They are frozen on purpose. A change here would make the test describe a build that never shipped.
