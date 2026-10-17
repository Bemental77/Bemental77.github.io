/* lib/volume.js — one master volume slider for every emulator page.
 *
 * Every page builds its own audio graph (AudioWorklet, ScriptProcessor, SDL,
 * cart_audio.js) and each ends in `node.connect(ctx.destination)`. Rather than
 * touch each graph, this wraps AudioNode.prototype.connect/disconnect so anything
 * aimed at a context's destination lands on a per-context master GainNode first.
 * It MUST load before the page's own scripts create their audio graph.
 *
 * Default is 100% so loudness is unchanged until the visitor moves the slider.
 * The slider is inserted after #btnMute (and #mMute in the mobile menu); pages
 * with neither get a small fixed control. The value persists in localStorage.
 */
(function () {
  'use strict';
  if (window.__bemVolume) return;
  var KEY = 'bem.volume';
  var level = 1;
  try { var s = parseFloat(localStorage.getItem(KEY)); if (s >= 0 && s <= 1) level = s; } catch (e) {}

  var masters = new WeakMap();   // BaseAudioContext -> GainNode
  var ctxs = [];                 // strong refs only to contexts we've seen (few)
  function gainFor(v) { return v * v; } // perceptual curve

  function apply(ctx, g) {
    try { g.gain.setTargetAtTime(gainFor(level), ctx.currentTime, 0.01); }
    catch (e) { try { g.gain.value = gainFor(level); } catch (e2) {} }
  }
  function masterFor(ctx, realConnect) {
    var m = masters.get(ctx);
    if (m) return m;
    m = ctx.createGain();
    m.gain.value = gainFor(level);
    realConnect.call(m, ctx.destination);
    masters.set(ctx, m);
    ctxs.push(ctx);
    return m;
  }

  var AN = window.AudioNode && AudioNode.prototype;
  if (AN && window.AudioDestinationNode) {
    var rc = AN.connect, rd = AN.disconnect;
    AN.connect = function (dest) {
      if (dest instanceof AudioDestinationNode) {
        try { arguments[0] = masterFor(dest.context, rc); } catch (e) {}
      }
      return rc.apply(this, arguments);
    };
    AN.disconnect = function (dest) {
      if (dest instanceof AudioDestinationNode) {
        var m = masters.get(dest.context);
        if (m) arguments[0] = m;
      }
      return rd.apply(this, arguments);
    };
  }

  function setLevel(v) {
    level = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(KEY, String(level)); } catch (e) {}
    for (var i = 0; i < ctxs.length; i++) { var g = masters.get(ctxs[i]); if (g) apply(ctxs[i], g); }
    sliders.forEach(function (el) { if (+el.value !== Math.round(level * 100)) el.value = Math.round(level * 100); });
  }

  var sliders = [];
  function makeSlider(extraClass) {
    var wrap = document.createElement('label');
    wrap.className = 'bem-volume ' + (extraClass || '');
    wrap.title = 'Volume';
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:0 6px;font:inherit;color:inherit;vertical-align:middle;';
    var ic = document.createElement('span'); ic.textContent = '🔉'; ic.setAttribute('aria-hidden', 'true');
    var r = document.createElement('input');
    r.type = 'range'; r.min = 0; r.max = 100; r.step = 1; r.value = Math.round(level * 100);
    r.setAttribute('aria-label', 'Volume');
    r.style.cssText = 'width:96px;min-width:60px;cursor:pointer;';
    r.addEventListener('input', function () { setLevel(r.value / 100); });
    wrap.appendChild(ic); wrap.appendChild(r);
    sliders.push(r);
    return wrap;
  }

  function mount() {
    var placed = false;
    ['btnMute', 'mMute'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b && b.parentNode && !b.nextElementSibling?.classList?.contains('bem-volume')) {
        b.parentNode.insertBefore(makeSlider(id === 'mMute' ? 'bem-volume-m' : ''), b.nextSibling);
        placed = true;
      }
    });
    if (!placed) {
      var f = makeSlider('bem-volume-float');
      f.style.cssText += 'position:fixed;left:12px;bottom:12px;z-index:2147483000;padding:6px 10px;border-radius:8px;background:rgba(20,20,24,.85);color:#fff;';
      document.body.appendChild(f);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.__bemVolume = { get: function () { return level; }, set: setLevel };
})();
