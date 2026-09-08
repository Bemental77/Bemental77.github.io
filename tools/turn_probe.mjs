#!/usr/bin/env node
// WHICH ICE SERVERS ACTUALLY HAND BACK A RELAY CANDIDATE?
//
// An entry in an iceServers array proves nothing. This counts the candidate
// TYPES a real RTCPeerConnection gathers, so a 'relay' line is the only thing
// that counts as a working TURN server. Written after I nearly shipped
// peerjs's own TURN servers as a fix for a NAT-traversal failure and only then
// measured them: they do not resolve at all.
//
// USAGE  npm run web && node tools/turn_probe.mjs
//        (edit CANDIDATES to test a relay you are considering)
import puppeteer from 'puppeteer';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
try { (await import('./browser_leak_guard.js')).default.guard(b, 'turn_probe'); } catch (_e) {}
const p = await b.newPage();
await p.goto('http://localhost:8080/contact.html', { waitUntil: 'domcontentloaded' });

const CANDIDATES = [
  ['openrelay 80 tcp',   [{ urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }]],
  ['standard.relay 80',  [{ urls: 'turn:standard.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }]],
  ['turns global 443',   [{ urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }]],
  ['numb viagenie',      [{ urls: 'turn:numb.viagenie.ca', username: 'webrtc@live.com', credential: 'muazkh' }]],
  ['anyfirewall',        [{ urls: 'turn:turn.anyfirewall.com:443?transport=tcp', username: 'webrtc', credential: 'webrtc' }]],
  ['freeturn',           [{ urls: 'turn:freeturn.net:3478', username: 'free', credential: 'free' }]],
  ['freeturn tcp',       [{ urls: 'turn:freeturn.tel:3478', username: 'free', credential: 'free' }]],
];

for (const [name, servers] of CANDIDATES) {
  const r = await p.evaluate(async (servers) => {
    const pc = new RTCPeerConnection({ iceServers: servers, iceCandidatePoolSize: 0 });
    const seen = [], errs = [];
    pc.onicecandidate = (e) => { if (e.candidate) seen.push(e.candidate.candidate); };
    pc.onicecandidateerror = (e) => errs.push(`${e.errorCode} ${e.errorText} url=${e.url}`);
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((res) => {
      const t = setTimeout(res, 9000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } };
    });
    const types = {};
    seen.forEach((c) => { const m = /\btyp (\w+)/.exec(c); if (m) types[m[1]] = (types[m[1]] || 0) + 1; });
    pc.close();
    return { types, errs: errs.slice(0, 3), n: seen.length };
  }, servers);
  const relay = r.types.relay || 0;
  console.log(`${relay ? 'RELAY-OK ' : 'no-relay '} ${name.padEnd(20)} candidates=${JSON.stringify(r.types)}  errors=${JSON.stringify(r.errs)}`);
}
await b.close();
