# Quake III Arena "LAN" over party play - feasibility and plan

Status 2026-10-29: **LAN DOES NOT WORK. Nothing here claims otherwise.** No two
browsers ever discovered each other's Quake III game. This document records what
exists, what is missing, and the smallest next steps. The disc itself (Task 1) is
added and separately verified; this is Task 2.

Evidence sources used this session: the live wasm
`https://caseybement.com/dreamcast/flycast_libretro/flycast_worker_emcc.wasm`
(7,048,375 B, sha256 prefix `7c285d539b734c4c`, string-scanned), upstream
Flycast at the commit `dreamcast/tools/verify_core_tree.sh` pins (`4be8a48`,
fetched from raw.githubusercontent.com into a scratch dir; line numbers below are
from those files), and this repo at `origin/prod` `55b4bb0`.

## 1. Is the Broadband Adapter in the shipped core?

Yes, compiled in. String scan of the live wasm finds: `rtl8139_io_writeb/w`,
`rtl8139_do_receive`, `RTL8139State`, `bba_ReadMem`, `bba_WriteMem`,
`bba_recv_frame`, `dreamcast/flycast-src/core/hw/bba/bba.cpp`,
`core/network/picoppp.cpp`, `core/network/dcnet.cpp`,
`net::modbba::DCNetService`, `net::modbba::PicoTcpService`,
`net::modbba::EthSocket`, and the libretro option key `reicast_emulate_bba`.
`dreamcast/flycast-bridge/flycast_stubs.cpp:15` says the same of the build
(picotcp and BBA/modem code "unconditionally added" to the archive).

What I did NOT establish (hedged): whether `reicast_emulate_bba` is ever set to
`enabled` by the shim (I found no `reicast_` string in `dreamcast/flycast_libretro/flycast_worker.js`
or `dreamcast/flycast-bridge/*`), whether any shipped game has ever driven the
adapter, and whether Quake III Arena (MK-51061) actually offers a LAN / system-link
menu at all. I believe the Dreamcast release is built around SegaNet online play;
that is unverified and is the first thing to check (step A below) because the rest
of this plan is wasted if the disc has no LAN mode.

### How the adapter reaches a network (upstream, `4be8a48`)

- Guest writes a frame -> `rtl8139` -> `qemu_send_packet()` (`core/hw/bba/bba.cpp:209`) ->
  `net::modbba::receiveEthFrame()` (`bba.cpp:211`).
- `core/network/netservice.cpp:33-41` picks the backend: `DCNetService` when
  `config::UseDCNet`, else `PicoTcpService`. Both are the ONLY implementations of
  `net::modbba::Service` (`netservice.h`).
- `PicoTcpService` (picoppp.cpp) is a **NAT/proxy stack**, not a switch: it creates
  one picotcp Ethernet device with MAC `0c:0a:0f:0e:00:01` (`picoppp.cpp:1102`),
  gives itself `192.168.169.1`, and runs a DHCP server whose pool is the single
  address `192.168.169.2` (`picoppp.cpp:1351-1371`). Guest TCP/UDP is re-originated
  from **host sockets via asio** and answered back through `bba_recv_frame()`
  (`bba.cpp:216`) via `send_eth_frame` (`picoppp.cpp:1187`). It never forwards a raw
  frame to another console.
- Host requirement: **real sockets** (and optionally UPnP). A browser has none, and
  the thread it spawns (`PicoThread`, `picoppp.cpp:1203`) needs a working asio
  io_context. `DCNetService` talks to the DCNet cloud service over TCP/WebSocket-like
  sockets (`dcnet.cpp`). There is no TAP/pcap dependency in this path: upstream's
  Ethernet service is socket NAT. So "needs a TAP device" is NOT the blocker here;
  "needs host sockets" is.

### Consequences for a LAN

1. Even with sockets, picotcp NAT would give each console a private network
   (`192.168.169.2` to its own gateway) - two consoles would **not** see each
   other. The existing `PicoTcpService` cannot be the LAN.
2. The MAC is hardcoded: `NICConf nicConf = { 0xc, 0xa, 0xf, 0xe, 0, 0 }`
   (`bba.cpp:69`). Two consoles in one room would have identical MACs. A per-seat
   MAC must be passed in.
3. Frame data never leaves C++: there is no JS callback on transmit or receive.

## 2. Design: a virtual Ethernet switch over the netplay transport

Add a third `net::modbba::Service`, `WebLanService` (in the bridge, selected by a
new config bit `UseWebLan`, in `netservice.cpp:start()`):

- `receiveEthFrame(frame,size)` (guest TX) -> `EM_ASM`/`emscripten_run_in_main_runtime_thread`
  call into the page worker -> `LanSwitch.LanNode.egress(frame)`.
- JS -> `Module._bba_inject(ptr,len)` (new exported C function that calls
  `bba_recv_frame(data,len)`, `bba.cpp:216`; it returns 0 when `rtl8139_can_receive`
  is false, so JS must keep a small queue and retry).
- `writeModem/readModem/modemAvailable` are no-ops (BBA only).
- `bba_Init` takes the seat so the MAC is `0c:0a:0f:0e:00:<seat+1>`.

The JS half is written and unit-tested in this commit: `lib/lan_switch.js` +
`tools/lan_switch.test.mjs` (`node tools/lan_switch.test.mjs`, passes). It
implements exactly the semantics a LAN needs:

- broadcast/multicast (dst MAC bit 0) -> every peer. Quake III server discovery is
  a UDP broadcast (`255.255.255.255`/subnet broadcast; unverified for this port,
  but any broadcast is carried the same way) and ARP who-has is too;
- unicast -> the peer that last sourced that MAC, flood if unknown;
- no re-forwarding of frames that arrived from a peer (full mesh, no loops);
- duplicate-MAC detection (the hardcoded-MAC hazard above);
- identity plan: seat n -> MAC `0c:0a:0f:0e:00:(n+1)`, IP `192.168.169.(10+n)/24`.

IP configuration is static: the Dreamcast's network settings (stored in flash
by the DC's own BIOS/ISP setup) or the game's own screen must be set to
`192.168.169.(10+seat)`, mask `255.255.255.0`, no gateway/DNS. Whether Quake III
reads those or insists on DHCP is **unverified**; if it insists on DHCP, the
`WebLanService` must also answer DHCP (a ~100-line responder keyed on the
requester's MAC) because picotcp's DHCP server is not in the path any more.

### Transport

`lib/netplay.js` already builds a WebRTC mesh per room with MQTT-relay signalling
(`RTCPeerConnection` at `lib/netplay.js:6577`, ordered `play` channel at `:6644`,
and an UNORDERED, `maxRetransmits:0` channel `LSU_LABEL` at `:6684` - exactly the
semantics Ethernet wants: a LAN drops frames, it never delays them). The LAN
should ride a **third** channel (`lan`, unordered, no retransmits) opened beside
those, so no lockstep traffic is disturbed. MTU: Ethernet frames are <= 1518 B,
under the data-channel message limit, so no fragmentation is needed.

## 3. Interaction with lockstep: a `lan` room must NOT use the barrier

Existing online play is deterministic lockstep/rollback: both emulators execute the
same frames from the same inputs. Two consoles talking through a guest network
stack are the opposite: each is an independent machine at 1.000x real time, and
the packets are the only coupling. If the lockstep barrier stays engaged it will
stall one console to wait for the other's input frame, and any non-determinism in
packet arrival would desync the guests (they would then diverge for real, not
"desync"). So:

- the room needs a mode flag (`mode: 'lan'`) chosen by the host and carried in the
  `hello`/`ready` handshake (`lib/netplay.js:7571`, `:7666`) so a console that does
  not understand it refuses with the existing version-mismatch path instead of
  joining a lockstep room;
- in `lan` mode `lib/netplay.js` must skip the `lsready`/barrier negotiation
  entirely, still use the room/signalling/WebRTC machinery, and expose only the
  `lan` channel;
- each console takes its own controller input locally (port 1); there is no shared
  input log; no rollback, no frame-skip;
- save states must be disabled in that room (a state restore would rewind the
  guest's TCP/UDP sequence numbers against live peers).

This is a netplay.js change in a ~9,000-line file that other agents edit; it should
be its own reviewed commit, not part of the disc add.

## 4. What is missing, in order (smallest next steps)

A. **Prove the disc has a LAN mode.** Boot Quake III (live site, headless), walk
   to Multiplayer/Network, and screenshot. If it only offers SegaNet/modem there
   is nothing to bridge and this effort stops. (Not done - the first live boot
   test only proves the disc boots.)
B. **Make the core buildable here.** This machine has no `emcc`, `cmake`, `ninja`
   or working `python` (`where` reports none; `python.exe` is the Microsoft Store
   stub), and `dreamcast/flycast-src/` in this repo only tracks the 34 ported files
   (CLAUDE.md "flycast-src IS NO LONGER IGNORED WHOLESALE"); `core/network/`,
   `core/hw/bba/` are untracked upstream trees that are absent from a fresh clone,
   so even `verify_core_tree.sh` cannot run without the nested upstream checkout
   at `4be8a48`. The documented path is `dreamcast/build_and_probe.sh` after
   installing emsdk (version per `dreamcast/flycast-bridge/flycast_worker_link.sh`)
   and checking out the nested tree. I did not attempt it: a core I cannot prove
   still boots the five existing games must not ship.
C. Patch set (new `dreamcast/flycast-bridge/patches/00NN-weblan-service.patch`):
   `UseWebLan` option, `WebLanService`, `bba_inject` export, seat-aware MAC.
   Keep it disabled by default so the existing games run the unmodified path.
D. Wire `LanNode` to the new exports in `dreamcast.html` / the worker shim, and add
   the `lan` mode + channel to `lib/netplay.js`; add `quake3` as `lan` capable in
   `multiplayer.html`'s catalogue.
E. Test ladder (each step must pass before the next): (1) loopback - one core, frames
   from TX come back via `bba_inject`, guest ARPs itself; (2) two headless contexts,
   `ping` is not available on a DC so use the game: server list shows the other
   console; (3) join and play 60 s with `CDP` screenshots of both sides; (4) all five
   existing games still boot (`dreamcast/build_and_probe.sh`), hash-guarded wasm.

## 5. What this commit contains

- `lib/lan_switch.js`, `tools/lan_switch.test.mjs` - the switching logic, unit tested,
  not used by any page.
- This plan.

Nothing touches the core, `lib/netplay.js`, or any page.
