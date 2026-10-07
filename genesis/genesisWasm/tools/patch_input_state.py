#!/usr/bin/env python3
"""Carry the CONTROLLER PORTS' state in Genesis-Plus-GX savestates. Idempotent.

    python3 genesis/genesisWasm/tools/patch_input_state.py <GPGX_SRC>

WHY. core/state.c saves the I/O registers (io_reg) but nothing that sits
BEHIND them: core/input_hw/gamepad.c's per-pad TH state / 6-button counter /
timeout / TH latency, the EA 4-Way Play select latch, the Master Tap
flip-flops, core/input_hw/teamplayer.c's Team Player handshake state and read
counter, and input.pad[]. With them out of the blob, a load hands the guest
whatever the LAST SIMULATED frame left in them (or the reset values, where
state_load resets the ports) instead of what the saved frame had — e.g. a
Team Player read sequence a game left mid-handshake at the frame boundary.

⚠ WHAT IT DOES NOT DO, MEASURED 2026-10-07 — read before relying on it:
  * It is NOT what keeps a room exact. genesis.html runs the canonical step
    (load -> pads -> run -> save) on EVERY console for EVERY frame, so every
    console sees the same loads; tools/genesis_rollback_probe.mjs passes 3- and
    4-player rooms (Team Player and 4-Way Play) against a never-guessing
    reference on a control build WITHOUT this section too.
  * input.pad[] has no stale window to close: system_frame_gen() starts at
    V-blank and calls osd_input_update() in its first line, so every frame
    re-reads the pads before the guest can see them. It is carried anyway,
    as the value the frame actually ran on.
  * A load is still not a straight run in Genesis-Plus-GX: on
    tools/genesis_multitap_rom.mjs, a load before every frame vs no loads
    differs from frame 1 by ONE main-loop pass (68000 timing within the frame
    is not fully carried) — with or without this section, adaptor or not.
It makes the blob carry more of what the guest reads; it is defensive, not
load-bearing, and the probes above are the claim.

FORMAT. Appended AFTER every other section, including patch_fm_busy_state.py's
"FMBY" (tag "INPT" + the bytes below), so a state written before this patch
still loads exactly as before: its tag is absent and the live port state is
left alone. Run AFTER patch_fm_busy_state.py (build.sh does).

The new accessors bemental_input_system()/bemental_input_dev() are read-backs
for the shim (gpgx_shim.c gpx_multitap_state) — what the CORE has plugged in,
not what the page asked for.
"""
import sys, os

src = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/gpgx-src')
MARK = 'bemental-input:'

def edit(rel, fn):
    p = os.path.join(src, rel)
    with open(p, newline='') as f: s = f.read()
    if MARK in s:
        print('already patched (input state): ' + rel); return
    nl = '\r\n' if '\r\n' in s else '\n'
    t = fn(s.replace('\r\n', '\n')).replace('\n', nl)
    with open(p, 'w', newline='') as f: f.write(t)
    print('patched (input state): ' + rel)

def gamepad_c(s):
    return s + '''
/* bemental-input: the pads' internal state, for core/state.c (see
 * genesis/genesisWasm/tools/patch_input_state.py). Every byte here is read
 * back by gamepad_read()/wayplay_*()/mastertap_*() and none of it was in the
 * savestate. */
int gamepad_context_save(uint8 *state)
{
  int n = 0;
  memcpy(&state[n], gamepad, sizeof(gamepad));   n += sizeof(gamepad);
  memcpy(&state[n], flipflop, sizeof(flipflop)); n += sizeof(flipflop);
  state[n++] = latch;
  return n;
}
int gamepad_context_load(uint8 *state)
{
  int n = 0;
  memcpy(gamepad, &state[n], sizeof(gamepad));   n += sizeof(gamepad);
  memcpy(flipflop, &state[n], sizeof(flipflop)); n += sizeof(flipflop);
  latch = state[n++];
  return n;
}
int bemental_input_system(int port) { return (port >= 0 && port < 2) ? input.system[port] : -1; }
int bemental_input_dev(int i) { return (i >= 0 && i < MAX_DEVICES) ? input.dev[i] : -1; }
/* Pull every adaptor out: the input half of libretro.c config_default() (both
 * ports SYSTEM_GAMEPAD, every pad type on "auto"), old_system forgotten so the
 * next ROM load picks its own (loadrom.c), then exactly what
 * retro_set_controller_port_device() finishes with (io_init -> input_init,
 * input_reset). A console that had a Team Player / 4-Way Play plugged in for a
 * room is, after this, the console a fresh page boots. */
void bemental_input_defaults(void)
{
  int i;
  for (i = 0; i < MAX_INPUTS; i++) config.input[i].padtype = DEVICE_PAD2B | DEVICE_PAD3B | DEVICE_PAD6B;
  input.system[0] = input.system[1] = SYSTEM_GAMEPAD;
  old_system[0] = old_system[1] = -1;
  io_init();
  input_reset();
}
'''

def gamepad_h(s):
    a = '#endif'
    i = s.rfind(a)
    assert i > 0
    return s[:i] + '''/* bemental-input: see gamepad.c */
extern int gamepad_context_save(uint8 *state);
extern int gamepad_context_load(uint8 *state);
extern int bemental_input_system(int port);
extern int bemental_input_dev(int i);
extern void bemental_input_defaults(void);

''' + s[i:]

def teamplayer_c(s):
    return s + '''
/* bemental-input: the Team Player handshake state and read counter, for
 * core/state.c. Table[] is derived from the plugged pads (teamplayer_init) and
 * is not state. */
int teamplayer_context_save(uint8 *state)
{
  int i, n = 0;
  for (i = 0; i < 2; i++) { state[n++] = teamplayer[i].State; state[n++] = teamplayer[i].Counter; }
  return n;
}
int teamplayer_context_load(uint8 *state)
{
  int i, n = 0;
  for (i = 0; i < 2; i++) { teamplayer[i].State = state[n++]; teamplayer[i].Counter = state[n++]; }
  return n;
}
'''

def teamplayer_h(s):
    a = '#endif'
    i = s.rfind(a)
    assert i > 0
    return s[:i] + '''/* bemental-input: see teamplayer.c */
extern int teamplayer_context_save(uint8 *state);
extern int teamplayer_context_load(uint8 *state);

''' + s[i:]

def state_c(s):
    end = '  return bufferptr;\n}\n'
    parts = s.split(end)
    assert len(parts) == 3, 'state.c: expected exactly state_load and state_save'
    assert 'FMBY' in parts[0] and 'FMBY' in parts[1], 'run patch_fm_busy_state.py first: INPT goes after FMBY'
    load_tail = '''  /* bemental-input: the controller ports' state, appended after every other
   * section (tools/patch_input_state.py); a state without the tag leaves the
   * live port state alone, exactly as before. */
  if (!memcmp(&state[bufferptr], "INPT", 4))
  {
    bufferptr += 4;
    bufferptr += gamepad_context_load(&state[bufferptr]);
    bufferptr += teamplayer_context_load(&state[bufferptr]);
    load_param(input.pad, sizeof(input.pad));
  }
'''
    save_tail = '''  /* bemental-input: see state_load */
  save_param("INPT", 4);
  bufferptr += gamepad_context_save(&state[bufferptr]);
  bufferptr += teamplayer_context_save(&state[bufferptr]);
  save_param(input.pad, sizeof(input.pad));
'''
    return parts[0] + load_tail + end + parts[1] + save_tail + end + parts[2]

edit('core/input_hw/gamepad.c', gamepad_c)
edit('core/input_hw/gamepad.h', gamepad_h)
edit('core/input_hw/teamplayer.c', teamplayer_c)
edit('core/input_hw/teamplayer.h', teamplayer_h)
def state_c_inc(s):
    a = '#include "shared.h"\n'
    assert s.count(a) == 1
    return state_c(s.replace(a, a + '/* bemental-input: the port accessors (tools/patch_input_state.py) */\n#include "input_hw/gamepad.h"\n#include "input_hw/teamplayer.h"\n', 1))
edit('core/state.c', state_c_inc)
