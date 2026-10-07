#!/usr/bin/env node
// ============================================================================
// netplay_firewall.mjs — PUT ONE BROWSER BEHIND A REAL "HTTPS ONLY" FIREWALL.
// ============================================================================
//
// WHY. A strict network (school, office, hotel, a console behind a filtering
// router) lets out TCP 443 and nothing else: no UDP, no other TCP port. Two
// things in a room break there — the signalling brokers on 8084/8081/8884,
// and WebRTC, which is UDP. lib/netplay.js now handles both (brokers on 443
// lead the signal plan; a direct path that cannot open goes to the relay). This
// is the rig that makes "handles both" a measurement instead of a claim.
//
// ⚠ IT IS A KERNEL FIREWALL, NOT A BROWSER FLAG. Two cheaper simulations were
// tried first and rejected:
//   * `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` is NOT a
//     switch this Chromium honours: a page still gathered `host/udp`
//     (measured, chromium-1194). The profile PREFERENCE webrtc.ip_handling_policy
//     does work — 0 candidates, gathering complete in ~130 ms — but that is a
//     browser POLICY, and the network a player is actually on is different: the
//     browser gathers its host candidates as usual and the packets die on the
//     wire. Only the second shape exercises ICE failing the way it fails in the
//     field.
//   * forcing iceTransportPolicy:'relay' in the page (tools/
//     netplay_device_matrix.mjs arm drelay) proves relay mode carries a room,
//     but it is the page breaking itself; nothing about the network changes and
//     the signalling still uses whatever port it likes.
// So: the firewalled browser runs as its own uid (FW_UID, via setpriv, which
// execs — the PID puppeteer and tools/browser_leak_guard.js track stays the
// browser's), and iptables/ip6tables OUTPUT rules owner-matched on that uid
// let out exactly:
//     TCP to loopback port <webPort>      the page itself (in the field: GitHub
//                                         Pages, which is 443 — loopback is
//                                         only where this rig serves it)
//     TCP to any address, port 443
// and REJECT every other TCP connection and DROP every UDP datagram, loopback
// included (two browsers on one box would otherwise find each other over it).
// Nothing else on the box is affected: the rules match one uid that nothing
// else runs as, and they are removed on exit, on a signal, and — if a previous
// run was SIGKILLed — at the start of the next one.
//
// THE BROKER. The rig's broker (tools/mqtt_ws_broker.mjs) is plain ws on an
// ephemeral port. startBrokerFronts() puts TLS fronts in front of it on a
// loopback address of its own (FRONT_IP, 127.0.0.3) at 443 AND at 8084, and
// both browsers resolve `relay443.fw.test` / `relay8084.fw.test` there
// (--host-resolver-rules). The firewalled browser can reach the first and not
// the second — which is the shipped broker list in miniature: one entry on
// 443, one on a port a strict network refuses.
//
// ARM-DIFFERENCE PROOF: counters() reads the packet counts of every rule. A
// firewall arm in which no UDP was dropped, no TCP was refused, or nothing
// went out on 443 did not test what it claims, and the matrix prints no
// verdict for it.
//
// USAGE (self-test; root; no browser):
//   node tools/netplay_firewall.mjs selftest
// As a module: see tools/netplay_device_matrix.mjs arm `fw`.
// ============================================================================
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export const FW_UID = +(process.env.NPFW_UID || 4747);
export const FRONT_IP = process.env.NPFW_FRONT_IP || '127.0.0.3';
export const HOSTS = { p443: 'relay443.fw.test', p8084: 'relay8084.fw.test' };
const CHAIN = 'NPFW';

function ipt(bin, args, quiet) {
  try { return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
  catch (e) { if (!quiet) throw new Error(bin + ' ' + args.join(' ') + ': ' + String(e.stderr || e.message).trim()); return null; }
}
function teardown() {
  for (const bin of ['iptables', 'ip6tables']) {
    // every copy of the jump, then the chain
    for (let i = 0; i < 8; i++) if (ipt(bin, ['-D', 'OUTPUT', '-m', 'owner', '--uid-owner', String(FW_UID), '-j', CHAIN], true) == null) break;
    ipt(bin, ['-F', CHAIN], true);
    ipt(bin, ['-X', CHAIN], true);
  }
}

// Install the rules. Returns { wrapper, home, counters(), close() }.
export function startFirewall({ webPort, chrome }) {
  if (process.getuid && process.getuid() !== 0) throw new Error('the firewall arm needs root (iptables + setpriv)');
  teardown();   // a SIGKILLed previous run
  for (const [bin, lo] of [['iptables', '127.0.0.1'], ['ip6tables', '::1']]) {
    ipt(bin, ['-N', CHAIN]);
    ipt(bin, ['-A', CHAIN, '-p', 'tcp', '-d', lo, '--dport', String(webPort), '-j', 'ACCEPT', '-m', 'comment', '--comment', 'page']);
    ipt(bin, ['-A', CHAIN, '-p', 'tcp', '--dport', '443', '-j', 'ACCEPT', '-m', 'comment', '--comment', 'tcp443']);
    ipt(bin, ['-A', CHAIN, '-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset', '-m', 'comment', '--comment', 'tcp-other']);
    ipt(bin, ['-A', CHAIN, '-p', 'udp', '-j', 'DROP', '-m', 'comment', '--comment', 'udp']);
    ipt(bin, ['-A', CHAIN, '-j', 'DROP', '-m', 'comment', '--comment', 'rest']);
    ipt(bin, ['-I', 'OUTPUT', '1', '-m', 'owner', '--uid-owner', String(FW_UID), '-j', CHAIN]);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'npfw-home-'));
  fs.chownSync(home, FW_UID, FW_UID);
  const wrapper = path.join(home, 'chrome-fw.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec setpriv --reuid=${FW_UID} --regid=${FW_UID} --clear-groups env HOME=${home} ${chrome} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    teardown();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
  };
  process.on('exit', close);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { close(); process.exit(130); });
  return { wrapper, home, counters, close, uid: FW_UID };
}

// Packet counts per rule (v4 + v6 summed), by comment.
export function counters() {
  const out = {};
  for (const bin of ['iptables', 'ip6tables']) {
    const t = ipt(bin, ['-L', CHAIN, '-v', '-x', '-n'], true);
    if (!t) continue;
    for (const line of t.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+.*\/\*\s*(\S+)\s*\*\//);
      if (m) { const k = m[3]; out[k] = out[k] || { pkts: 0, bytes: 0 }; out[k].pkts += +m[1]; out[k].bytes += +m[2]; }
    }
  }
  return out;
}

// A profile directory the firewalled uid can write.
export function fwProfileDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chownSync(d, FW_UID, FW_UID);
  return d;
}

// Self-signed cert for *.fw.test (the browsers run with --ignore-certificate-errors
// in this arm only; the cert's job is to make the socket TLS, as a public broker's is).
function mkCert(dir) {
  const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${key} -out ${crt} -days 2 -subj /CN=fw.test ` +
           `-addext "subjectAltName=DNS:*.fw.test" 2>/dev/null`);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

// TLS on FRONT_IP:443 and FRONT_IP:8084, each piping to the plain broker.
export async function startBrokerFronts(brokerPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npfw-cert-'));
  const { key, cert } = mkCert(dir);
  const stats = { p443: 0, p8084: 0 };
  const servers = [];
  for (const [port, k] of [[443, 'p443'], [8084, 'p8084']]) {
    const s = tls.createServer({ key, cert }, (c) => {
      stats[k]++;
      const up = net.connect(brokerPort, '127.0.0.1');
      c.pipe(up); up.pipe(c);
      const kill = () => { try { c.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
      c.on('error', kill); up.on('error', kill); c.on('close', kill); up.on('close', kill);
    });
    await new Promise((res, rej) => { s.once('error', rej); s.listen(port, FRONT_IP, res); });
    servers.push(s);
  }
  return {
    stats,
    urls: { p443: `wss://${HOSTS.p443}/mqtt`, p8084: `wss://${HOSTS.p8084}:8084/mqtt` },
    resolverRule: `MAP ${HOSTS.p443} ${FRONT_IP},MAP ${HOSTS.p8084} ${FRONT_IP}`,
    close: async () => { for (const s of servers) await new Promise((r) => s.close(() => r())); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} },
  };
}

// ---- self-test: the rules do what they say, without a browser -------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && process.argv[2] === 'selftest') {
  const fw = startFirewall({ webPort: 8080, chrome: '/bin/true' });
  const fronts = await startBrokerFronts(1);
  const probe = (args) => { try { execSync(`setpriv --reuid=${FW_UID} --regid=${FW_UID} --clear-groups ${args}`, { stdio: 'pipe', timeout: 5000 }); return 'ok'; } catch (e) { return 'blocked'; } };
  const node = process.execPath;
  const tcp = (h, p) => probe(`${node} -e "const s=require('net').connect(${p},'${h}');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),3000)"`);
  const udp = (h, p) => { const r = probe(`${node} -e "const s=require('dgram').createSocket('udp4');s.send('x',${p},'${h}',(e)=>process.exit(e?1:0))"`); return r; };
  const res = {
    tcp443_front: tcp(FRONT_IP, 443),
    tcp8084_front: tcp(FRONT_IP, 8084),
    udp_loopback_send: udp('127.0.0.1', 9999),
  };
  const c = counters();
  console.log(JSON.stringify({ res, counters: c }, null, 1));
  await fronts.close(); fw.close();
  const pass = res.tcp443_front === 'ok' && res.tcp8084_front === 'blocked' && c.udp && c.udp.pkts > 0;
  console.log(pass ? 'SELFTEST PASS — 443 out, 8084 refused, UDP dropped' : 'SELFTEST FAIL');
  process.exit(pass ? 0 : 1);
}
