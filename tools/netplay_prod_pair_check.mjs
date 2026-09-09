#!/usr/bin/env node
// ============================================================================
// netplay_prod_pair_check.mjs — THE PRODUCTION PAGE, THE REAL CONTROLS, TWO
//                               ISOLATED PROFILES, AND THE DIRECT PATH BROKEN
// ============================================================================
//
// WHAT THIS IS FOR. Two real devices — a PC and a phone on different networks —
// deadlocked on https://caseybement.com: both rosters showed the other seat
// open, no approval prompt, no error. The cause was that signalling itself rode
// WebRTC (a peerjs DataConnection IS a WebRTC connection), so pairing needed
// NAT traversal before the game connection was ever attempted. The fix carries
// the handshake over ordinary WSS instead.
//
// ⚠ HOW THE CANDIDATE BUILD GETS ONTO A PAGE THIS RIG DOES NOT DEPLOY, STATED
// PLAINLY BECAUSE IT IS THE ONE THING THAT COULD MAKE THIS RIG A LIE. The fix
// is committed but NOT PUSHED, so https://caseybement.com is still serving the
// old lib/netplay.js. This rig loads the REAL production page — real origin,
// real HTTPS, real coi-serviceworker, real cross-origin isolation, real
// controls — and then re-evaluates the LOCAL lib/netplay.js in it, which
// overwrites window.Netplay before any session is created. Everything else on
// the page is production. The substitution is PROVEN, not assumed: the rig
// refuses to continue unless Netplay.signalPlan exists, which only the
// candidate build has.
//
//   * `--url=` may name localhost instead, in which case nothing is
//     substituted and the page's own file is what runs.
//   * Once this is pushed, run with --no-inject to measure the deployed file.
//
// ⚠ AND THE ARM THAT CARRIES THE ARGUMENT. Two profiles on one box SHARE A
// NAT, which is exactly why every rig here said the broken code worked. So the
// second pass forces iceTransportPolicy:'relay' with no relay configured on
// BOTH pages — the trick tools/netplay_relay_check.mjs uses — which makes it
// impossible for any RTCPeerConnection on either page to find a path. A
// handshake that still completes under that is not relying on the two networks
// reaching each other. It is a simulation of a hostile network, not a second
// network; only two real devices close that gap.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime          # mandatory gate
//   node tools/netplay_prod_pair_check.mjs
//   node tools/netplay_prod_pair_check.mjs --url=http://localhost:8080/dreamcast.html
//   node tools/netplay_prod_pair_check.mjs --no-inject       # after deploying
// ============================================================================
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const flag = (n) => {
  const hit = argv.find((a) => a === '--' + n || a.startsWith('--' + n + '='));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};
const PAGE_URL = flag('url') || 'https://caseybement.com/dreamcast.html';
const INJECT = !flag('no-inject') && !/localhost|127\.0\.0\.1/.test(PAGE_URL);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRATCH = process.env.SCRATCH || '/private/tmp/claude-501/prodpair';
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOCAL_NETPLAY = fs.readFileSync(path.join(REPO, 'lib/netplay.js'), 'utf8');
const APPROVE_MS = parseInt(process.env.APPROVE_MS || '60000', 10);

const rec = [];
const ok = (n, d) => { rec.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { rec.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browsers = [];
async function launch(tag) {
  const dir = path.join(SCRATCH, `${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', userDataDir: dir,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required'],
  });
  try { (await import('./browser_leak_guard.js')).default.guard(b, 'prod_pair'); } catch (_e) {}
  browsers.push({ b, dir });
  return b;
}

// ⚠ SEPARATE PROFILES ARE NOT OPTIONAL. BroadcastChannel cannot cross a
// profile, so ?net=local is unavailable even by accident and only a real
// transport can pair the two sides. Cross-origin isolation is also origin-
// scoped AND PERSISTS, so a shared profile hides a first-visit fault — the
// state a second real machine is always in.
async function openSide(tag, breakDirect) {
  const b = await launch(tag);
  const page = (await b.pages())[0] || await b.newPage();
  const log = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/\[net\]|netplay|signal|relay|broker|\bice\b|peer/i.test(t)) { log.push(t.slice(0, 240)); console.log(`  [${tag}] ${t.slice(0, 180)}`); }
  });
  page.on('pageerror', (e) => { const t = String((e && e.message) || e); log.push('ERROR ' + t.slice(0, 240)); console.log(`  [${tag}!] ${t.slice(0, 180)}`); });
  if (breakDirect) {
    await page.evaluateOnNewDocument(() => {
      const Real = window.RTCPeerConnection;
      window.__iceCfg = null;
      function Broken(cfg) {
        const c = Object.assign({}, cfg, { iceTransportPolicy: 'relay' });
        window.__iceCfg = c;
        return new Real(c);
      }
      Broken.prototype = Real.prototype;
      window.RTCPeerConnection = Broken;
    });
  }
  // coi-serviceworker installs on the FIRST visit and reloads the page; land on
  // the already-isolated document rather than racing it.
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2500);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 60000 });
  if (INJECT) await page.evaluate(LOCAL_NETPLAY);
  return { b, page, log };
}

async function until(page, body, ms, everyMs = 400) {
  const fn = new Function(body);
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(everyMs);
  }
}
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return 'MISSING'; e.click(); return 'ok'; }, sel);

// ---------------------------------------------------------------------------
// ONE PASS: real controls, host -> code -> guest joins -> a human allows.
async function pass(label, breakDirect) {
  console.log(`\n== ${label} ==`);
  const H = await openSide(label + '-host', breakDirect);
  const G = await openSide(label + '-guest', breakDirect);

  // The substitution has to be PROVEN or the whole pass is measuring the
  // deployed file and silently reporting it as the fix.
  const build = await H.page.evaluate(() => ({
    hasPlan: typeof (window.Netplay || {}).signalPlan === 'function',
    plan: (window.Netplay && window.Netplay.signalPlan) ? window.Netplay.signalPlan('peerjs') : null,
    coi: !!self.crossOriginIsolated,
    origin: location.origin,
  }));
  if (INJECT && !build.hasPlan) {
    bad(label + '/candidate-build-is-live', 'window.Netplay has no signalPlan — the injection did not take, everything below would be VOID');
    return { H, G, dead: true };
  }
  ok(label + '/candidate-build-is-live',
     `${build.origin} coi=${build.coi} · signalPlan("peerjs")=${JSON.stringify(build.plan)}${INJECT ? ' (local file evaluated into the production page)' : ' (as deployed)'}`);

  if (breakDirect) {
    // ARM-DIFFERENCE PROOF. A flag that did not take makes every cell below a
    // placebo, so it is checked before any verdict is printed.
    await H.page.evaluate(() => { try { new RTCPeerConnection({}); } catch (e) {} });
    await G.page.evaluate(() => { try { new RTCPeerConnection({}); } catch (e) {} });
    const hp = await H.page.evaluate(() => window.__iceCfg && window.__iceCfg.iceTransportPolicy);
    const gp = await G.page.evaluate(() => window.__iceCfg && window.__iceCfg.iceTransportPolicy);
    if (hp !== 'relay' || gp !== 'relay') {
      bad(label + '/arm-difference-proof', `host=${hp} guest=${gp} — the broken-path arm did not apply, the cells below are VOID`);
      return { H, G, dead: true };
    }
    ok(label + '/arm-difference-proof', 'every RTCPeerConnection on both pages is relay-only with NO relay configured');
  }

  // ---- the real controls ---------------------------------------------------
  info('open-panel', await click(H.page, '#btnNet'));
  await sleep(400);
  info('host-btn', await click(H.page, '#netHostBtn'));
  const code = await until(H.page,
    "const t=(document.getElementById('netCode')||{}).textContent||''; const c=t.trim(); return /^[A-HJ-NP-Z2-9]{5}$/.test(c)?c:null;", 30000);
  code ? ok(label + '/host-shows-a-code', code) : bad(label + '/host-shows-a-code', 'no code appeared on the host panel');
  if (!code) return { H, G, dead: true };

  await click(G.page, '#btnNet');
  await sleep(400);
  await click(G.page, '#netJoinBtn');
  await sleep(400);
  try {
    await G.page.click('#netCodeIn');
    await G.page.type('#netCodeIn', code, { delay: 25 });
  } catch (e) { info('typing', String(e).slice(0, 120)); }
  await click(G.page, '#netGo');

  // THE THING THAT NEVER HAPPENED ON THE TWO REAL DEVICES.
  const t0 = Date.now();
  const prompt = await until(H.page, "return document.getElementById('npApproveAllow') ? true : null;", APPROVE_MS, 400);
  const askedMs = Date.now() - t0;
  const sig = await H.page.evaluate(() => {
    const s = (window.Netplay.sessions || []).filter((x) => x.isHost).pop();
    return s ? { kind: s._sig && s._sig.kind, url: s._sig && s._sig.url, state: s.state, err: s.lastError } : null;
  });
  prompt
    ? ok(label + '/HOST-WAS-ASKED-TO-ADMIT-THE-JOINER', `the Allow prompt appeared ${askedMs} ms after the guest pressed join, over ${sig && sig.kind} (${sig && sig.url})`)
    : bad(label + '/HOST-WAS-ASKED-TO-ADMIT-THE-JOINER', `no prompt in ${askedMs} ms — this is the reported deadlock. host=${JSON.stringify(sig)}`);

  if (prompt) {
    // A HUMAN SAYS YES. The rig clicks the real dialog rather than calling
    // approve(), because the dialog is what a person actually has.
    const sas = await H.page.evaluate(() => {
      const el = document.getElementById('npApprove');
      return el ? (el.textContent.match(/[A-HJ-NP-Z2-9]{4}/) || [])[0] || null : null;
    });
    info('confirmation-code', String(sas) + '  (both sides derive it; a host reads it out)');
    await H.page.evaluate(() => document.getElementById('npApproveAllow').click());
    const both = await until(H.page, "const s=(window.Netplay.sessions||[]).filter(x=>x.isHost).pop(); return s && s.state==='connected' ? true : null;", 45000, 500);
    if (breakDirect) {
      // The GAME link genuinely cannot open here, and must not pretend to.
      const gs = await G.page.evaluate(() => { const s = (window.Netplay.sessions || []).pop(); return s ? { state: s.state, err: s.lastError } : null; });
      !both
        ? ok(label + '/game-link-correctly-cannot-open', `pairing is independent of the media path, as designed — guest=${JSON.stringify(gs)}`)
        : bad(label + '/game-link-correctly-cannot-open', 'the game link connected with relay-only ICE and no relay, so this arm is not doing what it claims');
    } else {
      both ? ok(label + '/game-link-opened', 'host reached connected after the human allowed it')
           : bad(label + '/game-link-opened', 'approved, but the data channel never opened');
    }
  }
  return { H, G };
}

// ---------------------------------------------------------------------------
console.log(`page      ${PAGE_URL}`);
console.log(`inject    ${INJECT ? 'YES — local lib/netplay.js evaluated into the production page (not yet pushed)' : 'no — measuring the file the page serves'}`);

const a = await pass('direct-allowed', false);
const b = await pass('DIRECT-PATH-BROKEN', true);

for (const { b: br, dir } of browsers) {
  try { await br.close(); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}
void a; void b;
const pass_ = rec.filter((r) => r.ok).length;
console.log(`\n${pass_}/${rec.length} passed`);
process.exit(pass_ === rec.length ? 0 : 1);
