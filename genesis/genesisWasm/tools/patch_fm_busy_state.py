#!/usr/bin/env python3
"""Carry the YM2612 BUSY timer in Genesis-Plus-GX savestates. Idempotent.

    python3 genesis/genesisWasm/tools/patch_fm_busy_state.py <GPGX_SRC>

WHY. core/sound/sound.c keeps `fm_cycles_busy` (when the YM2612's BUSY bit
clears — read by the Z80 sound driver through YM2612_Read) and never saves it;
state_load() -> system_reset() -> sound_reset() -> fm_reset() zeroes it. So a
run that LOADS a state and a run that does not are different machines from the
next FM write on. Measured with tools/rollback_state_measure.mjs on Sonic 3:
continuous-vs-loaded differed after 1 frame (bytes in Z80 RAM and the YM2612
context), and a rollback run never matched a straight run. Rollback netplay
loads a state on every misprediction, so this is load-bearing for it.

FORMAT. Appended AFTER every other section (tag "FMBY" + int32), so a state
written before this patch still loads: its tag is absent and the timer keeps
the value system_reset() gave it, exactly as before.
"""
import sys, os

src = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/gpgx-src')
MARK = 'bemental:'

def edit(rel, fn):
    p = os.path.join(src, rel)
    with open(p, newline='') as f: s = f.read()
    if MARK in s:
        print('already patched: ' + rel); return
    nl = '\r\n' if '\r\n' in s else '\n'
    t = fn(s.replace('\r\n', '\n')).replace('\n', nl)
    with open(p, 'w', newline='') as f: f.write(t)
    print('patched: ' + rel)

def sound_c(s):
    a = 'static int fm_cycles_busy;\n'
    assert s.count(a) == 1
    return s.replace(a, a + '''
/* bemental: fm_cycles_busy is guest-visible (the YM2612 BUSY bit read by the
 * Z80 sound driver, YM2612_Read) but was never serialized, and state_load's
 * system_reset() zeroes it. Exposed so state.c can carry it in the savestate. */
int sound_get_fm_busy(void) { return fm_cycles_busy; }
void sound_set_fm_busy(int v) { fm_cycles_busy = v; }
''', 1)

def sound_h(s):
    a = 'extern void restore_sound_buffer();'
    assert s.count(a) == 1
    return s.replace(a, a + '''
/* bemental: see sound.c */
extern int sound_get_fm_busy(void);
extern void sound_set_fm_busy(int v);''', 1)

def state_c(s):
    end = '  return bufferptr;\n}\n'
    parts = s.split(end)
    assert len(parts) == 3, 'state.c: expected exactly state_load and state_save'
    load_tail = '''  /* bemental: the YM2612 BUSY timer, appended AFTER every section so older
   * states (which end before it) still load; the tag guards against reading
   * whatever followed the old end of the buffer. */
  if ((system_hw & SYSTEM_PBC) == SYSTEM_MD)
  {
    int busy;
    if (!memcmp(&state[bufferptr], "FMBY", 4))
    {
      bufferptr += 4;
      load_param(&busy, sizeof(busy));
      sound_set_fm_busy(busy);
    }
  }
'''
    save_tail = '''  /* bemental: see state_load */
  if ((system_hw & SYSTEM_PBC) == SYSTEM_MD)
  {
    int busy = sound_get_fm_busy();
    save_param("FMBY", 4);
    save_param(&busy, sizeof(busy));
  }
'''
    return parts[0] + load_tail + end + parts[1] + save_tail + end + parts[2]

edit('core/sound/sound.c', sound_c)
edit('core/sound/sound.h', sound_h)
edit('core/state.c', state_c)
