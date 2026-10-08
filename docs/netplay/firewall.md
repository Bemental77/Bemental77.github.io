# Netplay behind a firewall that allows only HTTPS (TCP 443)

Living record of what is MEASURED about a room where one player's network lets out TCP 443
and nothing else (no UDP, no other TCP port) — a school, office or hotel network, or a console
behind a filtering router. Every number names its rig. Anything not listed is unverified.

## What broke, and what the fix is

A room needs two things from the network, and a strict firewall removes both:

1. **Signalling** (pairing, approval, the WebRTC offer). It ran over public MQTT-over-WSS
   brokers on ports 8084/8081/8884 (`lib/netplay.js` `WS_BROKERS`). On a 443-only network
   none of them answer, so the room never pairs.
2. **The game path** is WebRTC, i.e. UDP. With UDP blocked ICE cannot open, and there is no
   working free TURN server to fall back to (the ICE block in `lib/netplay.js` lists every one
   tried: 701/400). No paid TURN credentials were supplied, so TURN is not the fix.

The fix, all in `lib/netplay.js`:

- **Brokers on 443 lead the signal plan**, and every broker in the list is dialled AT ONCE. A
  session keeps every broker that comes up and publishes to all of them; a copy of a message
  that arrives over two brokers has the same IV and is delivered once. (With "first that
  connects wins", a host on an open network would sit on an 8084 broker while a firewalled
  joiner sat on a 443 one, and the two would never meet.) A guest drops the brokers its host
  is not on 8 s after first hearing it. A host keeps them all, because the next joiner may only
  reach a different one. The entry format is `url|username|password`, like `?turn=`.
- **Server relay mode** carries the room's game messages over the broker. Relay mode already
  existed, but it only started after a 25 s ICE timer, and a relayed *rollback* room could not
  run (see below). Now:
  - a link whose ICE goes `failed` before it ever opened goes to the relay; it used to be
    unseated even though the relay was available;
  - a link that gathers **zero** ICE candidates goes to the relay 1.5 s after gathering
    completes. This is what a browser with UDP disabled by policy does: it gathers in ~130 ms
    and has nothing to offer;
  - the other side **adopts** the relay on the first relayed frame that decrypts under the
    per-link key, instead of dropping frames until its own timer fires.
- **The room is marked "relay"** on screen on every page: a `#npRelay` chip ("Relay room ·
  ~N ms round trip · Df", owned by `lib/netplay.js`, `pointer-events:none`, follows
  fullscreen). The Party button also gets "· relay" (`lib/netplay-ui.js`). In the debug report
  (`lib/debugreport.js`), `roomInfo().relay` / `relayInfo()` carries `mode:'relay'`, the
  brokers, why the direct path failed, the measured one-way time and its p90, the delay it
  forces, and the publish rate and bytes/s.

## Brokers on 443 — verified from this sandbox

This sandbox's egress is itself the firewall in question: CONNECT to any port but 443 is cut by
the egress proxy. All three original brokers FAIL from here (`ECONNRESET`).
`tools/netplay_broker_check.mjs` reads the list out of `lib/netplay.js`. When `HTTPS_PROXY` is
set it tunnels through it, does a real CONNECT/SUBSCRIBE/PUBLISH with two clients, and with
`--rate/--secs/--bytes` runs a rate test.

| broker | port | auth | relay | one-way* |
|---|---|---|---|---|
| `wss://public.cloud.shiftr.io:443` | 443 | public / public | PASS | 126-164 ms |
| `wss://demo.tbmq.io:443/mqtt` | 443 | demo / (none) | PASS | 149-344 ms |
| `wss://broker.emqx.io:8084/mqtt` | 8084 | — | FAIL here (port) | — |
| `wss://test.mosquitto.org:8081/mqtt` | 8081 | — | FAIL here (port) | — |
| `wss://broker.hivemq.com:8884/mqtt` | 8884 | — | FAIL here (port) | — |

\* through this sandbox's egress proxy, so these are upper bounds.

Probed and not usable: `mqtt.eclipseprojects.io:443` (connection reset);
`broker.emqx.io`, `broker.hivemq.com` and `test.mosquitto.org` on 443 (a web site that answers
301 with no MQTT); `public.mqtthq.com` and `broker.mqttgo.io` (refused by egress);
`mqtt.flespi.io` (needs a token, CONNACK 4); `broker.shiftr.io` (refused); `wss://nos.lol`
(a Nostr relay; it opens, but it is not MQTT).

**Rate limits (soak with two clients, 10 s bins, scratch `soak.mjs`):**

| rate x size | duration | shiftr | tbmq |
|---|---|---|---|
| 12/s x 550 B | 180 s | 0 lost | 0 lost |
| 20/s x 550 B | 180 s | 0 lost | 0 lost |
| 30/s x 600 B | 120 s | 2 lost of 3600 | 0 lost |
| **17/s x 600 B** | **600 s** | **1 lost of ~10,200** (p50 168, p95 275 ms) | **0 lost** (p50 142, p95 186 ms) |
| 30/s x 600 B | 300 s | **85% lost** | **82% lost** |

The last row is unexplained (one run). It could be a quota that only shows after ~45 s at that
rate. So the relay is held well under it: a relayed console publishes **~16-17 times a second**.

## The relay, as measured

The relay used to lose room state. A relayed room published every non-input message ONCE into
a QoS-0 broker, and re-encoded every input into its own window. That window dropped what
rides on a rollback room's inputs: frame advantage, host acks, drop epoch, mode switch and
lead. It also dropped NAK answers. A PS1 rollback room on the relay deadlocked every time:
`mode -> delay at frame 503` on one side, unheard on the other, then "no input from player 1
(the host) for 30s". Fixed:

- **Non-input relay traffic is reliable.** It is numbered per link (`_r`) and acked
  cumulatively (`a`, carried on every batch). It is re-sent after 1.5 measured round trips and
  delivered once, in order. A peer that predates this (no `rv`) gets each message exactly once,
  as before.
- **What rides on the newest input is kept** (`w.m`). The redundancy frames inside an `ls` go
  into the window. A NAK answer (`rel`) travels whole on the reliable path.
- **Crypto is pipelined:** decrypts start on arrival and only delivery is ordered (both the
  transport seal and the per-link seal).
- **Batching is leading-edge at 66 ms:** an input goes at once if nothing went out for 66 ms,
  so a publish leaves at most every 66 ms.
- **The window carries only what the peer has not confirmed** (`wa`). Ciphertext is base64 to
  capable peers (`d6`; hex was 2x).
- **The relay's input delay** is p90 one-way + two batches + 1 frame (capped at 30). A ping
  burst at engagement gives the start delay a tail to size from. While running, that need is
  the floor the delay may be given back to.

### Integrity

- Rooms use random codes. The broker never sees the code: the topic is 128 bits of HMAC under
  a PBKDF2 room key, and every payload is AES-GCM sealed under a key expanded from it. A
  different room cannot decrypt, so it cannot forge or inject, and anything that does not
  authenticate is dropped unparsed. A replayed IV is ignored.
- Relayed game frames are sealed again under a **per-link** key: HMAC(room key,
  'relay|' + joiner nonce + '|' + pairing challenge). That key is derived from material
  exchanged at join, which is the per-room HMAC key the task asked to consider. An unapproved
  caller that knows the code still never gets the challenge, so it cannot produce a frame that
  opens. A sequence number per batch rejects replays and reordering.
- The existing hash/desync checks are unchanged: fingerprints are compared over the relay
  exactly as over a DataChannel (counts below).

## The firewall rig

`tools/netplay_firewall.mjs` puts one browser behind a **kernel** firewall. The browser runs
as its own uid (4747, via `setpriv`, which keeps the PID). iptables and ip6tables OUTPUT rules,
owner-matched to that uid, let out TCP to the page's loopback port and TCP 443. They REJECT
every other TCP connection and DROP every UDP datagram, loopback included. Self-test:
`node tools/netplay_firewall.mjs selftest` (443 out, 8084 refused, UDP dropped).

Rejected simulations:
- `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` is not honoured by
  chromium-1194: `host/udp` was still gathered.
- The `webrtc.ip_handling_policy` profile preference works (0 candidates), but it is a browser
  policy, not a network.
- Forcing `iceTransportPolicy:'relay'` in the page (arm `drelay`) changes nothing about the
  network.

The rig's broker (`tools/mqtt_ws_broker.mjs`) runs behind TLS fronts at `127.0.0.3:443` and
`:8084`. Both browsers resolve `relay443.fw.test` / `relay8084.fw.test` there. The hand-off
lists the **8084 one first**, so the firewalled side has to find the 443 one by itself.

The arm-difference proof is the per-rule packet counters: a firewall arm with no dropped UDP,
no refused TCP, or nothing on 443 prints no verdict.

> Chromium in this sandbox cannot reach the public brokers itself: the egress proxy does not
> carry WebSocket upgrades from Chrome (its README lists them as unsupported, and a direct
> handshake answers 200/400). So browser runs use the rig's broker, impaired with the measured
> shape (one-way delay + loss), and the public brokers are verified from Node.

### Netplay alone: `tools/netplay_firewall_room_test.mjs`

Two Chrome processes; the joiner is behind the firewall. The real `lib/netplay.js` uses the
default `'peerjs'` plan (ws + peerjs). The core is deterministic by construction (a hash of
every pad image, like `tools/netplay_lockstep_pair_test.mjs`), paced to 60/s, with an 8-byte
pad that changes every 12 frames. No emulator, so the rate is the netplay's.

| broker | rate host / joiner (fastest 5 s) | stalls h / j | delay | RTT (relay ping) | fingerprints | publishes/s | relay B/s out | MQTT payload / conn |
|---|---|---|---|---|---|---|---|---|
| 150 ms + 1% loss | **1.000x / 1.000x** (1.0005 / 1.0009) | 0 / 0 | 20 (333 ms) | ~324-351 ms | 240/240 agreed | 16.6-17.1 | 4.9-5.1 KB/s | ~10 KB/s |
| 300 ms + 1% loss | **1.000x / 1.000x** | 0 / 0 | 29 (483 ms) | ~650-656 ms | 240/240 agreed | 16.5-16.9 | 6.0-6.2 KB/s | ~11.7 KB/s |

120 s each, load 0.4-2.2, netplay.js `61bcf988`. Both runs passed every check: paired on the
relay ~17 s after the joiner opened; joiner on the 443 broker only; firewall proof (1690 UDP
datagrams dropped, the 8084 SYN refused, 4000+ packets on 443); chip on screen on both.

### Emulator rooms: `tools/netplay_device_matrix.mjs` arms `fw`, `fw300`, `fw0`

These are real console pages: the shipped hand-off, the shipped lobby and Allow, and a
capacity-gated rollback room. They are judged against a direct-link control (`a`) on the same
box. The table is filled from the final runs below.

Final runs 2026-10-07 22:06-22:18, netplay.js `61bcf988`, 60 s measured per cell. Broker:
150 ms one way + 1% loss (`fw`) or 300 ms (`fw300`), out of process. Rates are engine
frames / wall / console Hz. Every relay cell carried the firewall proof: ~2000-2200 UDP
datagrams dropped, the 8084 SYN refused, 1950-2810 packets on 443, and the joiner on the 443
broker only. Every cell had **0 desyncs**.

| console | arm | host x / joiner x | modes (gate) | stalls h / j | RTT (relay ping) | relay publishes/s, B/s out | fingerprints | load |
|---|---|---|---|---|---|---|---|---|
| Genesis (Sonic 3) | `a` direct control | 0.9996 / 0.9996 | rollback 61 s | 0 / 0 | — | — | 62 | 3.0-4.7 |
| Genesis | `fw` 150 ms | 0.9427 / 0.9463 | rb 34 s @0.94 -> delay 27 s @0.94-0.95 | 21 (1.2 s) / 155 (10.5 s) | 372-375 ms | 16.2, 4.0 KB/s | 59 | ~4-7 |
| Genesis | `fw300` 300 ms | 0.8218 / 0.8278 | rb 29 s @0.65 -> delay 32 s @**0.978-0.985** | 180 / 213 | 634-663 ms | 16.0, 4.1 KB/s | 52 | ~7 |
| PS1 (Monster Rancher 2) | `a` direct control | 0.9879 / 0.9879 | rb 23 s -> delay 36 s @0.98 | 68 / 276 | — | — | 52 | 10.9 |
| PS1 | `fw` 150 ms | **0.9789 / 0.9859** | rb 8 s @0.88 -> delay 52 s @**0.9946 / 1.0008** | 8 (0.3 s) / 3 (0.3 s) | 335-342 ms | 15.0, 3.5 KB/s | 52 | 7.5-10.9 |
| GameCube (Mario Party 4) | `a` direct control | 1.0061 / 1.0055 (witness 1.008 / 0.993) | rollback 60 s, window 30 | 2 / 4 | — | — | 60 | 3.9-5.5 |
| GameCube | `fw` 150 ms | engine 0.930 / 0.954, **witness 0.852 / 0.849** | rollback 61 s, window 30 (cap), rttFrames 27 | 184 (15.5 s) / 284 (33.6 s) | 414-448 ms | 8.4-9.3, 4.2-6.5 KB/s | 50-51 | ~5 |
| N64 (MK64, `&worker=0`) | `a` direct control | 0.7105 / 0.7315 | box-limited | 102 / 87 | — | — | 37 | 7.5 |
| N64 | `fw` 150 ms | 0.7003 / 0.5974 | delay 59-68 s | 195 / 236 | 393-874 ms | 10.9-11.7, 3.3-4.1 KB/s | 36 | 7.5 |

How to read it:
- **PS1 on the relay matches its direct control.** The capacity gate moves the room to delay
  lockstep at 24-30 frames, where it runs 0.995-1.001x. The whole-window figure carries the
  rollback seconds before the gate moved it.
- **Genesis is the honest gap.** Direct it is 1.000x. On the relay its rollback window cannot
  cover a ~370 ms RTT on this box's CPU, so the gate moves it to delay. There it runs
  0.94-0.98x: the relay's jitter still stalls it a few times a minute, even at 22-30 frames of
  delay. A 300 ms broker costs it 0.82x overall, most of it in the 29 s before the gate moved
  it (rollback at 0.65x).
- **GameCube stays in rollback, and the relay outruns its window.** The room's window is
  capped at 30 frames, but the relay's RTT is 27 frames plus jitter. So it window-stalls
  (184 / 284 stalls), and the page's catch-up after a stall shows engine 5 s windows of
  1.43x / 1.73x (the page's own witness: 1.034x / 1.056x; the direct control also reads 1.05x
  windows). The guest clock is the witness: 0.85x. It played with 0 desyncs, but it is not
  1.000x. Unlike PS1 and Genesis, this room is never moved to delay lockstep.
- **N64 is box-limited.** The direct control is 0.71x on this 4-core box with two main-thread
  N64s (`&worker=0`; the default worker room keeps its engine in the worker, where the matrix
  cannot see it). It says nothing about the relay.
- The PS1 and N64 cells ran at load 7.5-10.9 while sibling agents' probes ran (CLAUDE.md:
  ±25% matched-pair noise at load 11-23). The Genesis cells ran at load 3-7.

Relay rollback depth before the gate moved it (from the earlier `fw0` cell, unimpaired broker,
48 ms one way): window 27-30, max depth 11-13 frames, mean 8.5-10, rttFrames 7.1-8.7, against
the direct control's window 11-17, max depth 2-9 and rttFrames 1.8-3.0.

## Cross-console suites after the change

These ran 2026-10-07 22:18-22:40, under `tools/probe_lock.sh`, on netplay.js `61bcf988`, and
then `f1c13bf4` (`f1c13bf4` = `61bcf988` + a null guard for test stand-ins):

| suite | result |
|---|---|
| `tools/netplay_rollback_test.mjs` | 28/28 (both versions) |
| `tools/netplay_rb_capacity_test.mjs` | 26/26 (both) |
| `tools/netplay_lockstep_test.mjs` | **crashed on `61bcf988`** (`_relayWindow` read `this._links` on a stand-in); 152/152 on `f1c13bf4` |
| `tools/delay_stepdown_test.mjs` | 26/26 (both) |
| `tools/snes_rollback_probe.mjs` | 19/19 (both) |
| `tools/ps1_netplay_test.mjs` | 27/27; host 1.0042x, guest 1.0047x (`61bcf988`) |
| `tools/gc_rollback_det_test.mjs` | 7/7 (`61bcf988`) |
| `tools/gc_netplay_room_test.mjs` (RUN_MS=120000) | 20/20 (`f1c13bf4`) |
| `n64/tools/lockstep_probe.mjs` | GATE PASS (solo/bridge/pair 2/2 each) |
| `dreamcast/tools/room_desync_soak.mjs --game pso2 --soak 60` | IN SYNC over 32 RAM checkpoints and 32 engine fingerprints |

## A relayed room is a delay room (2026-10-08, netplay.js `8c9e6f80`)

### Root cause, from the 2026-10-07 cells above

- **Rollback is where relay rooms lost their time.** Genesis `fw`: 134 of the joiner's 159
  stalls came in the 34 s before the capacity gate moved it to delay; `fw300`: 211 of 218.
  GameCube never left rollback: the window sat at `ROLLBACK_MAX` (30), `rttFrames` 27.2,
  `lateP99` 30 (the samples are clipped at the window), 184/284 window stalls. The gate's
  memory switch (`_capWinShort`) only fires for a console's declared ring (`rbMaxWindow`),
  and GameCube declares none, so a path that outran the engine's own 30-frame cap was
  never a reason to switch. The capacity need read 0.052, so the time switch never fired
  either.
- **In delay lockstep the residue was the page, not the link.** Genesis host at 0.9427 ran
  its whole delay stretch with zero stalls of its own and ~20 rAF/s; its joiner's stalls
  were waits on it. A delay room had no catch-up outside a rejoin, so a tick the page lost
  was lost for the whole room.

### The changes (`lib/netplay.js`)

1. **`RELAY_RB_NEED_MAX` = 12 frames.** The Session gives the engine the relay's current
   need (`ls.relayNeed`, set in `_relayHeard`: p90 one-way + two batches + 1). Above 12
   frames, a capacity-gated room:
   - **starts in delay** at `max(delay, need)` when the need is known before the barrier
     (`lsgo` carries `csr: 1` so the guest's note says "relay");
   - **switches to delay at once** from rollback (`_capDecide`), with no warm-up and no hot
     streak, at the relay's need (or the wire floor if that is higher). It does not use
     `_capDelay`, because rollback lateness on the relay is clipped at the window;
   - **never returns to rollback** while the relay needs more than 12 frames.
   The mode note is `kind: 'relay'`: "this room is on a relay; using input delay (N
   frames) ... zero-lag mode cannot cover the relay's round trip".
2. **A running delay room that moves to the relay** gets its delay raised to the relay's
   need at an agreed frame (`_scheduleDelay`), instead of waiting for stalls to raise it.
3. **Delay-lockstep catch-up (`_lsCatchUp`).** A console that is behind the slowest other
   console (`_rbAtBy`, the `q` frame on its inputs) by 2 or more frames runs ONE hidden
   frame a tick, up to one short of that console. This applies only while a hidden frame
   costs at most half a frame of its measured step. It is still bounded by its own wall
   clock (`rbCatchUp`'s `_ocAllow`), so it never runs ahead of real time. It is the same
   rule rollback's catch-up (A. EXACT) follows. Rejoin keeps its own faster catch-up.

### Before / after (same rig: `tools/netplay_device_matrix.mjs`, 60 s per cell)

Rates are host / joiner. GameCube is quoted by its guest-clock witness, the others by
engine frames. "Load" is the cell's max 1-min load on this 4-core box. Every cell had
0 desyncs and the firewall proof.

| console · arm | before (`61bcf988`, 10-07) | relay → delay (`b76759f1`) | + delay catch-up (`8c9e6f80`) | load (after) |
|---|---|---|---|---|
| Genesis `fw` 150 ms | 0.9427 / 0.9463 · stalls 21 / 155 | 0.9865 / 0.9887 · 0 / 16 | **0.9955 / 0.9966 · 0 / 0** (delay 22) | 9.7 |
| Genesis `fw300` | 0.8218 / 0.8278 · 180 / 213 | 0.9529 / 0.9562 · 6 / 44 | **0.9769 / 0.9788 · 2 / 25** (delay 30) | 10.5 |
| PS1 `fw` 150 ms | 0.9789 / 0.9859 · 8 / 3 | 0.9878 / 0.9953 · 0 / 47 | **0.9997 / 1.0001 · 1 / 0 — PASS** (delay 27) | 7.4 |
| PS1 `fw300` | (not run) | 0.987 / 0.9868 · 61 / 67 | **1.0007 / 1.0001 · 62 / 0 — PASS** (delay 30) | 4.0 |
| GameCube `fw` 150 ms | 0.852 / 0.849 · 184 / 284 (rollback, never left) | 0.9437 / 0.9396 · 26 / 26 | 0.9373 / 0.9415 · 37 / 38 (delay 30) | 14.5 |
| GameCube `fw300` | (not run) | 0.8968 / 0.9146 · 73 / 56 | 0.9022 / 0.8702 · 89 / 95 (delay 30) | 17.3 |

Runs: `/tmp/npdm/rl-all-2` (middle column) and `/tmp/npdm/rl-all-4` (right), both under
`tools/probe_lock.sh`, with `NPDM_MIN_FREE_GB` lowered to 2-2.5 because the box had
3.6-3.8 GB free. The 10-07 column is the table above. No relay cell fast-forwarded: the
fastest 5-s window was at most 1.0133x (GameCube `fw` engine), and Genesis/PS1 stayed
at or under 1.0086x.

### What is still short, and why

- **GameCube is limited by this box in delay lockstep, not by the relay.** The direct
  control in delay lockstep (`--arms a --query '&rb=0'`, `/tmp/npdm/gc-a-rb0`, load 12.9)
  ran at **0.9718 / 0.963 with 95 / 598 stalls** on a 4-frame delay. The direct rollback
  control reads ~1.006 because prediction hides the two instances' thread hiccups. Delay
  lockstep cannot hide a stop longer than its slack: the measured mean lead is 9-15 frames
  of the 30, and stalls run up to 484-586 ms. At 30 frames the relay is at its ceiling
  (`RELAY_MAX_DELAY`), so more delay is not available. A GameCube relay room at 1.000x on
  this box needs a cheaper GameCube frame, or a box that is not running both players.
- **Genesis `fw300` 0.977x**: a relay that needs more than 30 frames (one-way ~330 ms +
  batches) runs at the 30-frame ceiling and still stalls on the tail.
- **Genesis audio dropouts** (13.8 / 43 per minute on the host) remain on the relay arms.
  They were 90 / 149 per minute before. They are not judged here.

### Suites on `8c9e6f80` (2026-10-08 02:04-02:19, under `tools/probe_lock.sh`, load 2.6-10.2)

Node: `netplay_rollback_test` 28/28, `netplay_rb_capacity_test` 29/29 (adds three cells:
`relay-mid-room` switches at t=4.0 s to delay 23, `relay-at-start` starts in delay 23
and runs no rollback frame, `relay-shallow` keeps rollback when the need is 10 frames;
`away-across-the-switch` now compares switches only up to the frame the slowest console
reached, because a return to rollback named 2 frames past a console's last frame is
still in flight, not missed), `netplay_lockstep_test` 152/152, `delay_stepdown_test` 26/26,
`netplay_rb_pace_sim` 15/15, `netplay_pace_sim` 18/18, `netplay_pace_sim_n` 6/6.
Browser: `snes_rollback_probe` 19/19, `ps1_netplay_test` 26/26 (needs `CHROME_PATH` on
this box), `gc_rollback_det_test` 7/7, `gc_netplay_room_test` (RUN_MS=120000) 20/20,
`n64/tools/lockstep_probe.mjs` GATE PASS, `dreamcast/tools/room_desync_soak.mjs --game
pso2 --soak 60` IN SYNC over 32 RAM checkpoints and 32 fingerprints. The soak ran against
the live `:8080` tree, not a hermetic snapshot; its md5s were STABLE.

### Is the prod N64 / Dreamcast direct-room regression real? No.

The PR 238 live bench read N64 room 0.9826 and Dreamcast 0.9814 on the default ANGLE arm.
Matched pairs, served locally by two `tools/devserver.mjs` roots that differ only in
`lib/netplay.js` (`8bf4ff1`'s `bb106f86` vs prod's `f1c13bf4`), with a fresh browser per
run, interleaved ABBA, `?bench=1&benchauto=1&benchsec=20`:

| batch (load) | N64 room old / new | Dreamcast room old / new |
|---|---|---|
| 1, 4 reps (4.7-8.1) | 0.9762 0.9919 0.975 0.9939 / 0.9809 0.9971 0.9742 0.9949 | 1.0014 0.99 0.9989 0.9945 / 1.002 0.9992 0.9964 0.9999 |
| 2, 3 reps after a container restart (3.8-7.0) | 0.9988 1.0 0.9997 / 0.9992 1.0 0.9988 | 0.9997 1.0006 1.0 / 1.0016 0.9946 0.9299* |

\* that run's SOLO read 0.9894 too: the box was disturbed for the whole page, not the room.

The old engine failed N64 exactly as often as the new one did before the restart (2 of 4
each), and both passed every N64 rep after it. A third arm put back the pre-PR
`n64/bementalJIT/mips_emit.js`, the only other N64 file PR 238 changed. It read 0.9852
mean against 0.979 for current, 4 reps each, at load 3.7-6.0. Every one of those 8 runs
was under 0.995. So the failing reads were the box's state at the time, not either change.

## What is NOT shown

- **Real hardware on a real 443-only network.** The firewall is real (kernel), but both
  browsers share one box and the broker is the rig's. The public 443 brokers are verified from
  Node.
- A relayed room is not a direct room. One-way time is 150-330 ms here, so delay-lockstep
  input lag is 20-29 frames, and a rollback room re-simulates deep or the capacity gate moves
  it to delay. The chip says so.
- Brokers are third parties under unknown rate limits. Only shiftr and tbmq are known to work
  on 443 today, and `tools/netplay_broker_check.mjs` is the standing check.
