// Unit test for the SM64 daily generator (n64/daily/daily.js generate()).
//
//   node n64/tools/sm64_daily_test.mjs [route.json]
//
// Proves, for 365 consecutive days against the real route file:
//  - the same date always yields the same challenge (everyone gets one puzzle);
//  - every checkpoint lies on ONE explorer proof chain, in chain order, ending
//    at the target — so following that chain clears the challenge;
//  - the chain's time (bot par) fits inside 2:00;
//  - days differ.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const routePath = process.argv[2] || path.join(ROOT, 'n64/daily/routes/castle_grounds.json');
const ctx = { window: {}, Math, Date, String, JSON };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'n64/daily/daily.js'), 'utf8'), ctx);
const { generate, dateKey } = ctx.window.SM64Daily;
const route = JSON.parse(fs.readFileSync(routePath, 'utf8'));
const byId = Object.fromEntries(route.nodes.map(n => [n.id, n]));
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

let fail = 0, null_ = 0; const seen = new Set();
const ck = (c, msg) => { if (!c) { fail++; if (fail < 20) console.log('FAIL', msg); } };
const d = new Date('2026-10-23T12:00:00');
for (let i = 0; i < 365; i++, d.setDate(d.getDate() + 1)) {
  const key = dateKey(d), ch = generate(route, key);
  if (!ch) { null_++; continue; }
  ck(JSON.stringify(generate(route, key)) === JSON.stringify(ch), `${key} not deterministic`);
  ck(ch.checkpoints.length >= 1 && ch.checkpoints.length <= 6, `${key} has ${ch.checkpoints.length} checkpoints`);
  ck(ch.parVi <= 120 * ch.viHz, `${key} par ${ch.parVi} exceeds 2:00`);
  // Rebuild the target's chain and require the checkpoints to be an ordered subsequence ending at it.
  const target = route.nodes.find(n => same(n, ch.checkpoints.at(-1)) && n.t === ch.parVi);
  ck(!!target, `${key} target is not a route node`);
  if (target) {
    const chain = []; for (let n = target; n && n.parent; n = byId[n.parent]) chain.unshift(n);
    let j = 0; for (const n of chain) if (j < ch.checkpoints.length && same(n, ch.checkpoints[j])) j++;
    ck(j === ch.checkpoints.length, `${key} checkpoints are not in chain order`);
    ck(ch.checkpoints.every((c, k) => k === 0 || c.t >= ch.checkpoints[k - 1].t), `${key} checkpoint times not monotone`);
  }
  seen.add(JSON.stringify(ch.checkpoints));
}
console.log(JSON.stringify({ route: path.basename(routePath), nodes: route.nodes.length, days: 365, noChallenge: null_, distinct: seen.size, fail }));
process.exit(fail || null_ ? 1 : 0);
