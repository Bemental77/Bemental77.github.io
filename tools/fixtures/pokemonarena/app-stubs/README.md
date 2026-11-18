# The placeholder apps (test fixtures of `tools/pokemonarena_apps_test.mjs`)

Nine files: the three small apps the hub's app host was written and reviewed against (PLAY ONLINE, the Center, the Team Builder as they
stood at commit b03a5f7e, 2026-11-17). They are NOT part of the game. The apps suite lays them over the game's own `online_*`, `center_*`
and `builder_*` files in every tree it loads in Node or serves to a browser, so that the suite says what the SHELL does (the registry, the
trail, the dialog layer, the text entry, an app that throws, a ctl that cannot load) whatever those three apps have become.

Do not edit them to follow the product apps. Change one only together with the shell contract it exercises (`pokemonarena/INAPP.md`,
"The app interface") and the checks of the suite that read it.
