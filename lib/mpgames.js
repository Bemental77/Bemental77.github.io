// lib/mpgames.js — WHICH GAMES CAN BE PLAYED WITH MORE THAN ONE PERSON.
//
// A party is only offered for a game whose own cartridge/disc has a
// multiplayer mode. Lockstep netplay mirrors controller ports into ONE emulated
// console, so a title that never reads controller 2 gives player 2 nothing to
// do: they would sit in a room watching someone else play. Those titles are
// listed here, keyed exactly as each page names them (the same key the lobby
// sends as &game= and lib/netplay.js compares).
//
// Read by multiplayer.html (filters the game picker, refuses a solo title in a
// ?sys=&game= hand-off) and by each emulator page's Party button (disabled
// while a solo title is selected). tools/multiplayer_page_test.mjs FAILS if a
// key here is not on that console's page, so a rename cannot silently re-open
// a solo game.
//
// Player counts are from each game's retail packaging / manual; the ROM hacks
// listed are single-player campaigns built on single-player bases.
(function (root) {
  'use strict';
  var SOLO = {
    n64: [
      'Super Mario 64', 'Zelda: Ocarina of Time', 'Paper Mario', 'Pokémon Snap',
      'Dinosaur Planet',
      'Super Mario 64: Star Road', 'Zelda: The Missing Link',
      'Banjo-Kazooie: Jiggies of Time', 'Banjo-Dreamie',
      'Banjo-Kazooie: Christmas Edition', 'Star Fox: Survival',
      'Super Mario Odyssey 64 (hack)',
    ],
    snes: ['SimCity'],
    ps1: [
      'Metal Gear Solid (Disc 1)', 'Metal Gear Solid (Disc 2)',
      "Harry Potter & the Sorcerer's Stone",
      'Legend of Dragoon (Disc 1)', 'Legend of Dragoon (Disc 2)',
      'Legend of Dragoon (Disc 3)', 'Legend of Dragoon (Disc 4)',
    ],
  };

  function isSolo(sys, key) {
    var l = SOLO[sys];
    return !!l && l.indexOf(key) >= 0;
  }

  // Disable a page's Party control(s) while a single-player game is selected.
  //   sys      console key ('n64', 'snes', 'ps1', ...)
  //   buttons  element ids of the Party control(s)
  //   selects  element ids of the game <select>(s)
  //   keyOf    optional (select) -> game key; default: the selected option's
  //            text, which is the ROMS[] label on every page that uses this
  // Inside a room (?np= on the URL) the game is already fixed by the room, so
  // nothing is gated there.
  function gateParty(sys, buttons, selects, keyOf) {
    if (/[?&]np=/.test(location.search)) return;
    function apply(sel) {
      var key = null;
      try {
        key = keyOf ? keyOf(sel) : (sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : null);
      } catch (e) {}
      var solo = key != null && isSolo(sys, key);
      buttons.forEach(function (id) {
        var b = document.getElementById(id); if (!b) return;
        b.disabled = solo;
        b.title = solo ? key + ' is a single-player game — pick a multiplayer game to open a party.' : '';
      });
    }
    // Delegated: this runs from <head>, before the selects exist.
    document.addEventListener('change', function (e) {
      if (e.target && selects.indexOf(e.target.id) >= 0) { last = e.target.value; apply(e.target); }
    }, true);
    // Pages fill the select late and restore a remembered game with
    // `sel.value = …`, which fires no 'change' — so also follow the value.
    var last = null;
    function watch() {
      var s = null;
      for (var i = 0; i < selects.length && !s; i++) {
        var c = document.getElementById(selects[i]);
        if (c && c.options.length && c.offsetParent !== null) s = c;
      }
      if (!s) { var s0 = document.getElementById(selects[0]); if (s0 && s0.options.length) s = s0; }
      if (s && s.value !== last) { last = s.value; apply(s); }
    }
    setInterval(watch, 500);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
  }

  root.MPGames = { SOLO: SOLO, isSolo: isSolo, gateParty: gateParty };
})(typeof window !== 'undefined' ? window : globalThis);
