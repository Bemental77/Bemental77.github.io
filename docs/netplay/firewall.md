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

## Delay rooms that keep the wall clock (2026-10-08, netplay.js `49a04b83`)

### Where a relayed delay room's time went (Genesis)

The matrix now records each page's dropped tick credit by cause (`window.__genTickLoss`),
the engine's holds (`lsStats`), GameCube's wait attribution (`__gcLockstep()` `gcLs`), and the
Long Animation Frames over 100 ms with the scripts in them (`native.loaf`; solos: `loaf`).
Baseline, same code as `8c9e6f80` plus those counters (`/tmp/npdm/base-loss`, load 11.3-11.6):

| Genesis host | ownClock rate | dropped to the 4-frame tick cap | to the 100 ms clamp | waiting on its peer | audio dropouts |
|---|---|---|---|---|---|
| `fw` | 0.9572 | 1453 ms (57 ticks) | 1017 ms (25 ticks) | 406 ms | 52 |
| `fw300` | 0.9452 | 1280 ms (55 ticks) | 916 ms (17 ticks) | 2310 ms | 74 |

- **The room's time was lost in the page's tick, not on the link.** `genesis.html` tick() ran
  at most 4 frames and 100 ms of wall time a tick and dropped the rest. Solo that is the
  anti-sprint rule (gate 9). In a delay room on this box the display ticks were late, not
  stalled: rAF ran 15-45/s, and the long frames were mostly the rAF callback plus 43-147 ms of
  rendering. Each late tick lost frames that nobody repaid, the room ran at the slower page's
  rate, and its peer then waited on it.
- **The audio dropouts are the same loss.** Every lost frame is 16.7 ms of guest audio that was
  never made. The AudioWorklet resumes a dry spell at half its 80 ms cushion
  (`lib/cart_audio_worklet.js`), so the cushion never recovers. Across the earlier cells the
  host's dropouts tracked its own-clock rate: 0.9376 -> 108, 0.9826 -> 23, 0.992 -> 14.
  The joiner had none at the same rate in some runs because its sink's backlog grew instead.
- **The host also started one one-way ahead of its guest.** A guest's frame 0 is the moment
  `lsgo` reaches it. So the host's slack against the guest's inputs was the delay minus
  (one-way + batching) minus one more one-way, while the guest had that one-way spare. The
  relay's delay is sized for one one-way, so the host stalled until it had lost that much,
  and again on later tails. With the tick fixed (`/tmp/npdm/cand-3`) the host still stalled
  6 / 11 times and ended 10 / 20 frames behind its clock at `fw` / `fw300`; the joiner never
  stalled.

### The changes

1. **`genesis.html`: a delay-lockstep room runs what its wall clock owes in the tick that owes
   it.** The tick limit is 250 ms / 15 frames (`ROOM_MAX_TICK_MS`, `ROOM_MAX_CATCHUP_FRAMES`).
   Solo and rollback keep 100 ms / 4. The end-of-tick clamp still drops any credit left over
   and any wait, so nothing is banked across ticks.
2. **`lib/netplay.js`: a relayed delay room's host holds frame 0 for the relay's measured
   one-way** (`rbHintMs`, at most 600 ms; `_startHoldUntil`). Its own clock starts when the
   hold ends. The hold applies only to a room that starts in delay because of the relay
   (`csr`); a direct link's one-way is a few ms and is not held.
3. **`genesis.html`: a one-frame delay-room catch-up frame keeps its audio** (`keepAudio`).
   Its picture is still skipped. A rejoin's frames are still dropped.
4. **The 30-frame relay ceiling (`RELAY_MAX_DELAY`) stays.** With 1 and 2 in place, Genesis
   `fw300` runs at 30 frames with 3 / 2 stalls (139 / 39 ms) a minute. The ceiling was not the
   limit; the host's lost one-way and the page's dropped ticks were.
5. **Tried and reverted: own-clock catch-up in the engine** (hidden frames whenever a console
   is behind its own wall clock). It got Genesis to 1.000x, but the host stalled 493 / 367 times.
   The host's own clock runs one one-way ahead of the room's (change 2), so repaying to it ran
   the host into its guest's input frontier on every tick. That clock is the wrong reference.

`tools/netplay_rb_pace_sim.mjs` models the delay-room tick, a display period (`vsyncMs`) and an
`oldTickCap` control. `tools/netplay_rb_capacity_test.mjs` adds the cell **`relay-30hz`**: a
relay room at a 30 Hz display with 70 ms hitches on 4% of ticks. It needs every console at
>= 0.995x and the host at <= 1 stall, and its old-tick control must read < 0.99x. Results:
1.000x, 0 stalls, control 0.9676x. On `8c9e6f80` the host stalls 4 times, so the cell FAILs.

### Before / after (`tools/netplay_device_matrix.mjs`, 60 s per cell)

Host / joiner. GameCube is quoted by its guest-clock witness, the others by engine frames.
Stalls are count / total ms. "Load" is the cell's max 1-min load on this 4-core box. Every relay
cell carried the firewall proof and had 0 desyncs.

| cell | before: `8c9e6f80` (`rl-all-4`) | before: `8c9e6f80` + counters (`base-loss`) | after (`final-1`) |
|---|---|---|---|
| Genesis `fw` | 0.9955 / 0.9966 · stalls 4 / 0 · audio 14 / 1 · load 9.7 | 0.9585 / 0.9607 · 12 / 32 · audio 52 / 29 · load 11.6 | **0.9999 / 0.9996 · 0 / 0 · audio 0 / 0 · PASS** · load 7.3 |
| Genesis `fw300` | 0.9769 / 0.9788 · 5 / 25 · audio 44 / 16 · load 10.5 | 0.9479 / 0.9501 · 25 / 30 · audio 74 / 32 · load 11.3 | **0.9986 / 0.9991 · 3 (139 ms) / 2 (39 ms) · audio 1 / 2 · PASS** · load 9.1 |
| PS1 `fw` | 0.9997 / 1.0001 · 1 / 0 · load 7.4 | — | **1.0011 / 1.0004 · 0 / 0 · PASS** · load 5.3 |
| PS1 `fw300` | 1.0007 / 1.0001 · 80 (2874 ms) / 0 · load 4.0 | — | **1.0001 / 1.0008 · 0 / 0 · PASS** · load 4.0 |
| GameCube `fw` | 0.9373 / 0.9415 · 38 / 38 (max 484 / 586 ms) · load 14.5 | 0.9713 / 0.9874 · 18 / 1 (max 179 / 592) · load 13.9 | 0.971 / 0.9657 · 19 / 39 (max 215 / 277) · fastest 5 s 1.028x · load 13.0 |
| GameCube `fw300` | 0.9022 / 0.8702 · 93 / 95 (max 328 / 491) · load 17.3 | 0.9487 / 0.9506 · 37 / 87 (max 370 / 443) · load 13.2 | 0.9643 / 0.97 · 37 / 24 (max 270 / 328) · fastest 5 s 1.028x · load 11.9 |

⚠ **The loads are not matched.** The Genesis "after" cells ran at load 7-9 and `base-loss` at
11-12. The matched comparison is the simulator's `relay-30hz` cell: the same room reads 0.9676x
with the old tick and 1.000x with the new one. `cand-3` (tick fix only) ran at load 8.6-9.8,
the same band as `rl-all-4`: 0.9955 / 0.9977 and 0.9946 / 0.9999, with 6 and 4 host dropouts.
The PS1 "after" cells ran on a tree that also carried the PS1 room-step work committed as
`7c6f905` (a ~4x cheaper room step), so the PS1 `fw300` host's 80 -> 0 stalls cannot be put on
the start hold alone.
The GameCube "fastest 5 s" FAST-FORWARD verdicts are the page's own witness after a stall. The
baseline had them too (`base-loss` joiner 1.0286x), before the start hold existed. GameCube does
not load `genesis.html`, so its only change here is the start hold, which runs nothing.

### GameCube: are the 484-586 ms stalls the box? Yes, as far as one witness shows

- A GameCube relay room's stalls are waits on the other console's inputs while that console's
  **main thread** is stopped. In a delay room every frame is released there (`gcLsStep`), and
  inputs are sent from there. GameCube's LoAFs over 150 ms in the room (`base-loss`) ran
  150-983 ms, and the scripts in them came to only 5-40 ms each.
- **Witness: two GameCube pages, no room, same box** (`--solo-only --solo pair`,
  `/tmp/npdm/gc-pair-loaf`, load 9.0-13.6). Each page had 39 / 24 LoAFs of 150 ms or more,
  totalling 10.9 / 8.0 s over the window, max 725 / 784 ms. Of that, script was 541 / 327 ms
  and rendering 31 / 152 ms, so about 95% of the time was neither this page's script nor its
  rendering. Guest rate 0.9905 / 0.9932. One GameCube solo at load 4-5 (`cand-1`): 1.0002x and
  0 long tasks in the window. A second solo pair at load 6.8-13.3 (`cand-1`): 0.9859 / 0.9843,
  max long task 620 ms.
- So the 500-800 ms stops happen with no room at all, whenever two GameCubes share this box.
  I have not shown what fills them (OS scheduling, V8 GC and GPU-process waits on SwiftShader
  are the candidates). A solo page rides them out: its worker keeps the clock with 8 frames of
  backlog. A delay room cannot, because its next frame needs the main thread and the other
  console's input. That is why the room reads 0.95-0.97 where the pair solo reads 0.985-0.993.
- **What would close the room's share of it:** let the worker release delay-lockstep frames
  whose inputs are already all in hand (`lead` was 9-15 frames) without the main thread. This is
  `recomp_worker.js` roomSelf with a per-frame image ring instead of one guess. Rollback rooms
  already have this ("A ROOM'S FRAMES DO NOT WAIT ON THIS THREAD"). It would not remove the
  stall a blacked-out console causes its peer once the peer's slack runs out, because that
  console's own inputs are also sent from the stopped thread. Not done here:
  `gamecube/recomp/recomp_worker.js` has another agent's uncommitted work in it.

### GameCube: the over-1.02x windows were owed time, repaid too fast (2026-10-08)

**Two causes, both shown.**

1. **The witness was not a 5 s rate.** The rig averaged five of the page's 1 s `producedPerS`
   readings. The page closes those windows on its own timer, so a main-thread stop at a window
   edge splits one second's frames into a low reading and a high one. In `final-1`, the host
   `fw` read 0.830 and then 1.138 while the engine released 60 and 60 frames. A 5 s run that
   started on the high reading read 1.0278x. Time-weighted over the same spans, the engine's own
   frame counter came to at most 1.018x. In the `fw300` joiner it was 1.0029x while the witness
   read 1.0279x. The rig now reads a cumulative guest clock (`__gcPace().clock`: credits consumed,
   plus frames the backstop or the room worker ran and the page has not yet absorbed). It divides
   by its own timestamps, and a 5 s window runs to the first sample at least 5000 ms later. One
   delayed sample had made "five samples" span 4.85 s. GameCube is judged by that clock
   (`rateBy: 'witness'`). The old reading is kept as `witnessHud*`, with no verdict.
2. **On the exact clock it was still catch-up past the ceiling.** In a delay room the clock banks
   up to `MAX_BACKLOG` = 8 credits during a stall, and the step released them as fast as the
   worker ran: 8 frames inside 5 s is 1.027x. The control (`?roompace=0`, exact clock) shows it.
   Both `fw` cells FAST-FORWARD: 1.0239 / 1.0206 and 1.0225 / 1.019.

**It is owed time, never past real time.** `__gcLockstep().ownAhead` is frames run since the room
released, minus wall time x 60, sampled every second. Its maximum on every GameCube room player in
every run was +0.71 frames. In the relay cells it never rose above -3.

**Fix (`gamecube.html`, PACE_\*).** A delay or lockstep room's release (credited or hidden) must
keep every window of at least 5 s ending now at <= 61 frames/s. That is <= 305 frames in any 5 s
(1.0167x) and 61/s over anything longer. The check is O(1): a count of the releases in the last
5 s, plus the least `C(s) - 61 s` over older release instants. This is the most catch-up the
ceiling allows: owed time is repaid at up to 1 frame/s past the first 5. A simulator with random
50-450 ms stalls gives max 1.0167x and costs 0.17% of the rate (0.9445 vs 0.9461).

Rejected, all measured on the matrix:
- a sliding "304 per trailing 5 s" count does not bound longer windows (1.047x over the next 6 s);
- a token bucket at 1.01x / depth 2 starved ordinary jitter (relay 0.945x);
- 1.002x / depth 4 repaid too little (0.959-0.978x).

Rollback frames are **not** paced. Paced, a direct room's joiner lost 12 frames, went into REJOIN,
and showed a held frame for 10 s.

**Matched pairs**

Interleaved ctl, pace, ctl, pace (`/tmp/npdm/gc-pair-{ctl,pace,ctl2,pace2}`). Rates are host /
joiner on the exact clock. The parenthesis is the fastest window of at least 5 s.

| cell | control (`roompace=0`) | paced |
|---|---|---|
| `fw` | 0.9939 / 0.9895 (**1.0239 / 1.0206 FF**) · 0.985 / 0.9829 (**1.0225 FF** / 1.019) · load 12.0, 13.1 | 0.9884 / 0.9864 (1.0137 / 1.0077) · 0.9872 / 0.9884 (1.0114 / 1.0133) · load 10.2, 12.5 |
| `fw300` | 0.9767 / 0.9769 (1.0136 / 1.0115) · 0.9844 / 0.9867 (1.0067 / 1.008) · load 11.6, 10.7 | 0.9717 / 0.9737 (1.0131 / 1.005) · 0.98 / 0.9799 (1.0147 / 1.0146) · load 11.7, 12.8 |

- **Ceiling:** the control fast-forwarded in 2 of 4 cells. The paced build did in 0 of 10 relay
  cells: these 4 plus `gc-pace-after4/5/6`, max 1.0167x. One of those (`after5 fw300`) PASSed
  outright.
- **Rate:** within the box's noise. The `fw` means are 0.9878 vs 0.9876; the `fw300` means are
  0.9812 vs 0.9763. At load 10-13 the matched-pair noise is larger than that.
- **What still fails** is the 0.99 floor: 0.97-0.99 on both arms. The stalls (0.2-3.8 s per
  minute, waits on the other console) are what lose the time. No catch-up the ceiling allows can
  repay them.
- **Direct (`a`, rollback, unpaced):** host / joiner 0.9997 / 1.0079, fastest 1.0193 / **1.0787**
  (`gc-pace-after6`, load 10.0), and ownAhead never above +0.49. This is rollback catch-up of owed
  time. The rig flags it. It is the open item.

**Not done: worker release of delay frames whose inputs are in hand.** This needs:
- an engine API for a future frame's agreed image (lib/netplay.js has only `_covered(f)`);
- a per-frame image ring in `recomp_worker.js` roomSelf in place of its one guess;
- a delay-mode reconcile, because `gcRaReconcile` feeds `beginFrame` the latched pad, which in
  delay mode is the pad for frame f, not the pad sampled for f + D.

That is not cheap. The stalls it would cover are waits on the *other* console's input, which it
cannot remove (see above).

Suites on this change (load 1.3-9.5):
- Node: `netplay_rollback_test` 28/28, `netplay_rb_capacity_test` 30/30, `netplay_lockstep_test`
  152/152, `delay_stepdown_test` 26/26, `netplay_rb_pace_sim` 15/15, `netplay_pace_sim` 18/18,
  `netplay_pace_sim_n` 6/6.
- `gc_rollback_det_test`: 7/7.
- `gc_netplay_room_test` (RUN_MS=120000): **19/1 on the first run.** The failing check was
  `never-runs-faster-than-hardware`: the first 15 s window read 1.0205x on p2. That is the rollback
  start catch-up, which this change does not pace, and the same known flake as the 1.0218x
  recorded above. The rerun was 20/20 (windows 0.9990-1.0008x, load 6.0-8.5).

### Suites (netplay.js `49a04b83`, under `tools/probe_lock.sh`)

Node: `netplay_rollback_test` 28/28, `netplay_rb_capacity_test` 30/30 (adds `relay-30hz`),
`netplay_lockstep_test` 152/152, `delay_stepdown_test` 26/26, `netplay_rb_pace_sim` 15/15,
`netplay_pace_sim` 18/18, `netplay_pace_sim_n` 6/6 (load 4-5).
Browser (2026-10-08 06:42-07:04, load 1.8-8.3): `snes_rollback_probe` 19/19, `ps1_netplay_test` 27/27,
`gc_rollback_det_test` 7/7, `genesis_netplay_test` 27/27 (guest 1.0012x),
`genesis_rollback_test --arms lockstep,rollback --lag 50` 15/15, `n64/tools/lockstep_probe.mjs`
GATE PASS (solo/bridge/pair 2/2), `dreamcast/tools/room_desync_soak.mjs --game pso2 --soak 60
--url http://localhost:8080` IN SYNC over 32 RAM checkpoints and 32 fingerprints (md5 STABLE).
`gc_netplay_room_test` (RUN_MS=120000) read **19/1 on its first run** at load 3.3-7.6. Its
summary was cut off, so which check failed is not known. It read 20/20 on the rerun at load
6.6-7.0. The GameCube page's only change here is the relay start hold, which a direct room
does not take.

## What is NOT shown

- **Real hardware on a real 443-only network.** The firewall is real (kernel), but both
  browsers share one box and the broker is the rig's. The public 443 brokers are verified from
  Node.
- A relayed room is not a direct room. One-way time is 150-330 ms here, so delay-lockstep
  input lag is 20-29 frames, and a rollback room re-simulates deep or the capacity gate moves
  it to delay. The chip says so.
- Brokers are third parties under unknown rate limits. Only shiftr and tbmq are known to work
  on 443 today, and `tools/netplay_broker_check.mjs` is the standing check.
