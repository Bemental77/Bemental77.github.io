#!/usr/bin/env python3
"""scene_driver.py -- play a GameCube game in native Dolphin under script control,
so a SCENE can be parked as a savestate.

WHY THIS EXISTS
---------------
The static-recomp verification rig is bounded by the SCENE, not by the translator
or the capture rig.  Measured 2026-09-04 (docs/static-recomp-sab/README.md §9.6):
of 2,704 eligible `main.dol` entries, **373 execute** in the one parked City Escape
savestate, and all 2,331 refusals share a single cause -- `never executed in this
scene`.  The same shape held on overlays: 16 of stg13D's 734 non-trivial entries.
More scenes was named as the highest-value next input, and there was no way to make
one: the only SAB savestate on this machine was that single City Escape park.

This is that way.  It drives `/Applications/Dolphin.app` with synthetic keyboard
input, screenshots what is on screen so navigation is SEEN rather than guessed, and
writes savestates through Dolphin's own hotkeys.

THREE THINGS THAT DO NOT WORK, EACH MEASURED HERE
-------------------------------------------------
1. **AppleScript cannot drive Dolphin AT ALL.**  Dolphin's macOS keyboard input is
   `CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, keycode)`
   (InputCommon/ControllerInterface/Quartz/QuartzKeyboardAndMouse.mm:194).
   `System Events`' `keystroke` / `key down` post to a process serial number and
   never touch the HID system state, so Dolphin sees nothing -- observed as the
   screenshot hotkey silently never firing while `osascript` returned success.
   Events must go to `CGEventPost(kCGHIDEventTap, ...)`, which is what the embedded
   `keyhold` helper below does.  It needs Accessibility permission, same as any
   automation.
2. **A key TAP can be missed entirely.**  That state is POLLED at input-poll rate,
   so a zero-duration press can fall between two polls.  Every press here is an
   explicit down / hold-for-N-ms / up.  This applies to HOTKEYS too -- Dolphin's
   HotkeyManager polls the same ControllerInterface.
3. **AppleScript has no key constant for the arrow keys**, which the stock GCPad
   profile uses for the main stick.  Irrelevant now that presses are raw keycodes,
   but it is why this tool ships its own pad profile.

ISOLATION.  Everything runs against a private Dolphin user directory (`-u`), so the
real `~/Library/Application Support/Dolphin` config is never modified.  A fresh user
dir needs `[Analytics] PermissionAsked = True` pre-written or the Qt app raises a
first-run modal and nothing clicks it.

SAVESTATE COMPATIBILITY IS NOT AUTOMATIC.  Dolphin refuses a savestate whose
STATE_VERSION differs and then SILENTLY CONTINUES COLD-BOOTING (State.cpp:723);
`gamecube/tools/native_oracle_gdb.py` picks its oracle binary FROM the state file
for exactly that reason.  States written here come from /Applications/Dolphin.app
(STATE_VERSION 177), which is the binary that wrote the pre-existing GSNE8P.s01, so
they interoperate with the whole `gamecube/recomp/sr` rig.

USAGE
-----
    python3 gamecube/tools/scene_driver.py setup
    python3 gamecube/tools/scene_driver.py launch [Metal] [<state-to-load>]
    python3 gamecube/tools/scene_driver.py wait 20
    python3 gamecube/tools/scene_driver.py shot <tag>      # -> shot_<tag>.png
    python3 gamecube/tools/scene_driver.py press Start:0.3 A:0.2 Right:0.25
    python3 gamecube/tools/scene_driver.py save 3          # -> <user>/StateSaves/<ID>.s03
    python3 gamecube/tools/scene_driver.py quit

Screenshot after EVERY navigation step and look at it.  Menu flows are not
guessable: SAB needs Start, Start, Start, A (memory-card slot), A (NEW FILE) to
reach its main menu, and one of those Starts lands on an attract-mode 3D character
screen that looks like the title screen.

Env: SCENE_USER (private user dir), SCENE_ISO, SCENE_GAMEID.
"""
import argparse, glob, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
USER = os.environ.get("SCENE_USER", "/tmp/scene_driver_user")
APP = "/Applications/Dolphin.app/Contents/MacOS/Dolphin"
ISO = os.environ.get("SCENE_ISO", os.path.join(
    REPO, "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"))
GAMEID = os.environ.get("SCENE_GAMEID", "GSNE8P")
LOG = os.path.join(USER, "dolphin.log")

# GC pad -> a LETTER key.  Letters only, and disjoint from the hotkey digits below.
PAD = {"A": "X", "B": "Z", "X": "C", "Y": "V", "Z": "B", "Start": "Return",
       "L": "Q", "R": "W", "Up": "I", "Down": "K", "Left": "J", "Right": "L",
       "DUp": "T", "DDown": "G", "DLeft": "F", "DRight": "H"}
# Dolphin key name -> macOS virtual keycode (Carbon kVK_ANSI_*).
KEYCODE = {"A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8,
           "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
           "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
           "8": 28, "0": 29, "O": 31, "U": 32, "I": 34, "P": 35, "Return": 36,
           "L": 37, "J": 38, "K": 40, "N": 45, "M": 46, "Space": 49, "Escape": 53,
           "Left Arrow": 123, "Right Arrow": 124, "Down Arrow": 125, "Up Arrow": 126}

KEYHOLD_SRC = r'''
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static void set_keys(CGKeyCode *k, int n, bool down) {
  for (int i = 0; i < n; i++) {
    CGEventRef e = CGEventCreateKeyboardEvent(NULL, k[i], down);
    if (!e) { fprintf(stderr, "CGEventCreateKeyboardEvent failed\n"); exit(2); }
    CGEventPost(kCGHIDEventTap, e); CFRelease(e); usleep(2000);
  }
}
int main(int argc, char **argv) {
  if (argc < 3 || (argc - 1) % 2) {
    fprintf(stderr, "usage: keyhold <keycode[+keycode...]> <hold_ms> ...\n"); return 1; }
  for (int a = 1; a < argc; a += 2) {
    CGKeyCode k[8]; int n = 0; char buf[64];
    snprintf(buf, sizeof buf, "%s", argv[a]);
    for (char *t = strtok(buf, "+"); t && n < 8; t = strtok(NULL, "+"))
      k[n++] = (CGKeyCode)atoi(t);
    set_keys(k, n, true);
    usleep((useconds_t)atoi(argv[a + 1]) * 1000);
    for (int i = n - 1; i >= 0; i--) set_keys(&k[i], 1, false);
    usleep(60000);
  }
  return 0;
}
'''


def keyhold_bin():
    """Build the CGEventPost helper on first use; cache it in the user dir."""
    out = os.path.join(USER, "keyhold")
    src = os.path.join(USER, "keyhold.c")
    if os.path.exists(out):
        return out
    os.makedirs(USER, exist_ok=True)
    open(src, "w").write(KEYHOLD_SRC)
    subprocess.run(["cc", "-O2", "-framework", "ApplicationServices", "-o", out, src],
                   check=True)
    return out


def osa(line):
    r = subprocess.run(["osascript", "-e", line], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("osascript failed: %s" % r.stderr.strip())
    return r.stdout.strip()


def focus():
    # The input gate requires render-window focus unless Background Input is on
    # (HotkeyScheduler.cpp:165 -> Core::UpdateInputGate(MAIN_FOCUSED_HOTKEYS)).
    osa('tell application "System Events" to set frontmost of process "Dolphin" to true')
    time.sleep(0.35)


def press(key, hold=0.15):
    """key is a Dolphin key name, or 'I+X' for a simultaneous combo."""
    codes = "+".join(str(KEYCODE[p]) for p in key.split("+"))
    r = subprocess.run([keyhold_bin(), codes, str(int(hold * 1000))],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("keyhold failed: %s" % r.stderr.strip())


def setup():
    for sub in ("Config", "StateSaves", "ScreenShots", "GC", "Load", "Dump"):
        os.makedirs(os.path.join(USER, sub), exist_ok=True)
    cfg = os.path.join(USER, "Config")
    open(os.path.join(cfg, "Dolphin.ini"), "w").write(
        "[Analytics]\nID = 00000000000000000000000000000000\nEnabled = False\n"
        "PermissionAsked = True\n[Interface]\nConfirmStop = False\n"
        "UsePanicHandlers = False\nDebugModeEnabled = False\n"
        "[Core]\nCPUThread = True\nCPUCore = 1\nGFXBackend = Metal\n"
        "[DSP]\nBackend = No Audio Output\n")
    pad = ["[GCPad1]", "Device = Quartz/0/Keyboard & Mouse"]
    for logical, key in (("Buttons/A", "A"), ("Buttons/B", "B"), ("Buttons/X", "X"),
                         ("Buttons/Y", "Y"), ("Buttons/Z", "Z"),
                         ("Buttons/Start", "Start"),
                         ("Main Stick/Up", "Up"), ("Main Stick/Down", "Down"),
                         ("Main Stick/Left", "Left"), ("Main Stick/Right", "Right"),
                         ("Triggers/L", "L"), ("Triggers/R", "R"),
                         ("D-Pad/Up", "DUp"), ("D-Pad/Down", "DDown"),
                         ("D-Pad/Left", "DLeft"), ("D-Pad/Right", "DRight")):
        pad.append("%s = `%s`" % (logical, PAD[key]))
    pad.append("Main Stick/Calibration = 100.00 141.42 100.00 141.42 100.00 141.42 "
               "100.00 141.42")
    open(os.path.join(cfg, "GCPadNew.ini"), "w").write("\n".join(pad) + "\n")
    hk = ["[Hotkeys]", "Device = Quartz/0/Keyboard & Mouse",
          "General/Take Screenshot = `9`", "General/Toggle Pause = `0`"]
    for slot in range(1, 9):
        hk.append("Save State/Save State Slot %d = `%d`" % (slot, slot))
    open(os.path.join(cfg, "Hotkeys.ini"), "w").write("\n".join(hk) + "\n")
    keyhold_bin()
    print("[setup] user dir %s" % USER)
    print("[setup] pad: " + ", ".join("%s=%s" % kv for kv in PAD.items()))


def launch(gfx="Metal", state=None):
    if not os.path.isdir(os.path.join(USER, "Config")):
        raise SystemExit("run `setup` first: %s has no Config/" % USER)
    # Match OUR user dir only -- a sibling agent's Dolphin must survive.
    subprocess.run(["pkill", "-9", "-f", USER], capture_output=True)
    time.sleep(1.0)
    args = [APP, "-u", USER, "-b",
            "-C", "Dolphin.Core.CPUThread=True", "-C", "Dolphin.Core.CPUCore=1",
            "-C", "Dolphin.Interface.UsePanicHandlers=False",
            "-C", "Dolphin.Interface.ConfirmStop=False",
            "-C", "Dolphin.Interface.DebugModeEnabled=False",
            "-C", "Dolphin.Core.GFXBackend=%s" % gfx,
            "-C", "Dolphin.DSP.Backend=No Audio Output", "-e", ISO]
    if state:
        args += ["-s", state]
    subprocess.Popen(args, stdout=open(LOG, "w"), stderr=subprocess.STDOUT,
                     start_new_session=True)
    print("[launch] " + " ".join(args))


def shot(tag=None):
    d = os.path.join(USER, "ScreenShots", GAMEID)
    before = set(glob.glob(os.path.join(d, "*.png")))
    focus()
    press("9", hold=0.20)
    for _ in range(40):
        time.sleep(0.25)
        new = set(glob.glob(os.path.join(d, "*.png"))) - before
        if new:
            p = sorted(new)[-1]
            if tag:
                q = os.path.join(USER, "shot_%s.png" % tag)
                shutil.copy(p, q)
                p = q
            print(p)
            return p
    print("NO SCREENSHOT PRODUCED -- is Dolphin frontmost and running?",
          file=sys.stderr)
    return None


def save(slot):
    focus()
    press(str(slot), hold=0.20)
    time.sleep(2.0)
    p = os.path.join(USER, "StateSaves", "%s.s%02d" % (GAMEID, slot))
    if os.path.exists(p):
        print("%s  %d bytes  %s" % (p, os.path.getsize(p),
                                    time.ctime(os.path.getmtime(p))))
    else:
        print("NO STATE WRITTEN at %s" % p, file=sys.stderr)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["setup", "launch", "wait", "focus", "press",
                                    "shot", "save", "quit"])
    ap.add_argument("rest", nargs="*")
    a = ap.parse_args()
    if a.cmd == "setup":
        setup()
    elif a.cmd == "launch":
        launch(a.rest[0] if a.rest else "Metal",
               a.rest[1] if len(a.rest) > 1 else None)
    elif a.cmd == "wait":
        time.sleep(float(a.rest[0]))
        print("waited %ss" % a.rest[0])
    elif a.cmd == "focus":
        focus()
        print(osa('tell application "System Events" to return name of first process '
                  'whose frontmost is true'))
    elif a.cmd == "press":
        focus()
        for spec in a.rest:
            name, _, hold = spec.partition(":")
            key = "+".join(PAD.get(p, p) for p in name.split("+"))
            press(key, hold=float(hold or 0.15))
            print("pressed %s (%s) for %ss" % (name, key, hold or 0.15))
    elif a.cmd == "shot":
        shot(a.rest[0] if a.rest else None)
    elif a.cmd == "save":
        save(int(a.rest[0]))
    elif a.cmd == "quit":
        subprocess.run(["pkill", "-9", "-f", USER], capture_output=True)
        print("killed")


if __name__ == "__main__":
    main()
