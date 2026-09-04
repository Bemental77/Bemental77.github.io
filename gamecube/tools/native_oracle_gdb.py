#!/usr/bin/env python3
"""
native_oracle_gdb.py -- native Dolphin as the ground-truth oracle for mechanical
PowerPC -> wasm translation.

Drives a headless `dolphin-emu-nogui` through Dolphin's built-in GDB stub
(Source/Core/Core/PowerPC/GDBStub.cpp). NOTHING in Dolphin is patched; every
capability used here is stock.

WHY THE GDB STUB AND NOT THE Qt PROFILER
  Dolphin's exact per-block profiler (JitInterface::JitBlockLogDump, exact
  runCount/cyclesSpent per JIT block) is reachable ONLY from DolphinQt's
  "JIT -> Write JIT Block Log Dump" menu item (MenuBar.cpp:215) or the Android
  JNI shim -- there is no nogui trigger and no config key for it.  Driving that
  Qt menu by AppleScript was tried and is not viable on this machine: with
  another agent's Dolphin instance also live, `DebugModeEnabled=True` together
  with a boot-time savestate load crashed 4/4 runs (heap corruption surfacing in
  AppKit / CoreAudio / the Metal shader compiler).  The GDB stub touches none of
  the window server, CoreAudio or Metal, so it is the reliable path.

HARD PREREQUISITE (silent-false-negative trap)
  JIT breakpoints are only emitted when debugging is enabled:
      JitCommon/JitBase.cpp:76    m_enable_debugging <- Config::MAIN_ENABLE_DEBUGGING
      Jit64/Jit.cpp:1100          if (IsDebuggingEnabled() && ...IsAddressBreakPoint(op.address))
  Launch therefore MUST pass -C Dolphin.Interface.DebugModeEnabled=True or every
  Z0 breakpoint is accepted, never fires, and the census silently reads "nothing
  executed".  Note the same flag disables fastmem (JitBase.cpp:171), so HOST
  timings under this harness are not native-speed.  Guest-side quantities
  (which code ran, how many guest instructions, register/memory deltas) are
  unaffected -- those are what this tool measures.

CONTROL MODEL
  Dolphin's stub has NO asynchronous break: GDBStub::ProcessCommands is only
  reached from CPU.cpp:171, i.e. while the CPU is in State::Stepping, and the
  only thing that puts it there under `c` is a breakpoint hit
  (PowerPC.cpp:902 CheckAndHandleBreakPoints -> CPU::Break + GDBStub::TakeControl).
  So: breakpoints and single-step are the only control primitives.  There is no
  "interrupt the guest every N ms" PC sampler.

REGISTER MAP (GDBStub.cpp:415-500)
  0-31 GPR | 32-63 FPR(PS0, 64-bit) | 64 PC | 65 MSR | 66 CR | 67 LR | 68 CTR
  69 XER | 70 FPSCR | 71-86 SR | 87 PVR | 88-103 IBAT/DBAT | 104+ SPRs
  NOTE: PS1 (the second paired-single lane) is NOT exposed by the stub.  Any
  ps_* result can only be diffed on its PS0 half through this interface.
"""

import os
import re
import socket
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NOGUI = os.path.join(REPO, "gamecube/dolphin-src/build-nogui/Binaries/dolphin-emu-nogui")
# build-nogui/Binaries/dolphin-emu-nogui is BROKEN as of 2026-08-29: it segfaults
# ~1s in ("Emuthread - Starting", EXC_BAD_ACCESS 0x0268002c) in EVERY config
# tried, baseline included, and `ninja -n` reports the build already up to date --
# so it is the binary, not staleness.  /Applications/Dolphin.app is Dolphin 2603a,
# the same revision as this source tree (STATE_VERSION 177) and the same revision
# that wrote GSNE8P.s01, so its savestates interoperate.  Default to it.
QT_APP = "/Applications/Dolphin.app/Contents/MacOS/Dolphin"
DOLPHIN_BIN = os.environ.get("DOLPHIN_BIN", QT_APP)
SAB_ISO = os.path.join(REPO, "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso")
SAB_STATE = os.path.expanduser(
    "~/Library/Application Support/Dolphin/StateSaves/GSNE8P.s01")
SAB_MAP = os.path.join(REPO, "dolphin_captures/sab.map")

# ---------------------------------------------------------------- oracle choice
#
# PICK THE DOLPHIN FROM THE STATE FILE, NEVER FROM A CONSTANT.  Dolphin refuses a
# savestate whose STATE_VERSION differs (State.cpp:723) and then SILENTLY CONTINUES
# COLD-BOOTING -- the connect PC is the DOL entry point and every downstream reading
# still looks plausible.  That single mismatch is what made seven overlay-fixture
# attempts read as "the interpreter boots too slowly to reach an overlay": the state
# was version 177, the oracle was the upstream build at 189, and the scene never
# loaded at all.  A cold boot still reaches plenty of DOL functions, which is why the
# DOL fixtures worked and only the overlays failed -- an overlay is not OSLink'd until
# the game reaches the level.
COOKIE_BASE = 0xBAADBABE
UPSTREAM_NOGUI = os.path.expanduser(
    "~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui")
ORACLES_BY_STATE_VERSION = {
    177: QT_APP,           # /Applications/Dolphin.app -- "Dolphin 2603a"
    189: UPSTREAM_NOGUI,
}


def state_file_version(path):
    """(version, revision_string) from a Dolphin savestate header.

    StateHeaderLegacy is 24 B, then version_cookie u32 and version_string_length u32,
    then the string (State.h:28-54, written at State.cpp:385-387)."""
    import struct as _struct
    with open(path, "rb") as f:
        head = f.read(4096)
    cookie, slen = _struct.unpack_from("<II", head, 24)
    return cookie - COOKIE_BASE, head[32:32 + slen].decode("ascii", "replace")


def pick_oracle(state):
    """The Dolphin on this machine that can READ `state`. -> (binary, version, rev)."""
    if not state:
        return DOLPHIN_BIN, None, None
    ver, rev = state_file_version(state)
    binary = ORACLES_BY_STATE_VERSION.get(ver)
    if binary is None:
        raise RSPError(
            f"{state} is STATE_VERSION {ver} ({rev!r}); no Dolphin here is known to "
            f"read it (known: {sorted(ORACLES_BY_STATE_VERSION)}). Loading it anyway "
            f"would COLD-BOOT silently.")
    return binary, ver, rev

# ---------------------------------------------------------------- RSP client


class RSPError(Exception):
    pass


class GDB:
    """Minimal GDB remote-serial-protocol client for Dolphin's stub."""

    def __init__(self, host="127.0.0.1", port=9123, timeout=30.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.buf = b""
        self._dirty = False

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    # -- framing ---------------------------------------------------------
    def _send(self, body: str):
        csum = sum(body.encode()) & 0xFF
        self.sock.sendall(f"${body}#{csum:02x}".encode())

    def _recv_raw(self, n=65536):
        d = self.sock.recv(n)
        if not d:
            raise RSPError("stub closed the connection")
        return d

    def _read_packet(self, timeout=None):
        """Read one $...# packet, skipping +/- acks."""
        if timeout is not None:
            self.sock.settimeout(timeout)
        while True:
            start = self.buf.find(b"$")
            end = self.buf.find(b"#", start + 1) if start >= 0 else -1
            if start >= 0 and end >= 0 and len(self.buf) >= end + 3:
                body = self.buf[start + 1:end]
                self.buf = self.buf[end + 3:]
                self.sock.sendall(b"+")
                return body.decode(errors="replace")
            self.buf += self._recv_raw()

    def cmd(self, body: str, timeout=None) -> str:
        self._send(body)
        return self._read_packet(timeout=timeout)

    # -- primitives ------------------------------------------------------
    def reg(self, num: int) -> int:
        r = self.cmd(f"p{num:x}")
        if r.startswith("E"):
            raise RSPError(f"p{num:x} -> {r}")
        return int(r, 16)

    def gprs(self) -> list:
        r = self.cmd("g")
        return [int(r[i * 8:(i + 1) * 8], 16) for i in range(32)]

    def pc(self) -> int:
        return self.reg(64)

    def mem(self, addr: int, length: int) -> bytes:
        r = self.cmd(f"m{addr:x},{length:x}")
        if r.startswith("E") and len(r) <= 3:
            raise RSPError(f"m{addr:x},{length:x} -> {r}")
        return bytes.fromhex(r)

    def add_bp(self, addr: int) -> bool:
        return self.cmd(f"Z0,{addr:x},4") == "OK"

    def del_bp(self, addr: int) -> bool:
        return self.cmd(f"z0,{addr:x},4") == "OK"

    def step(self) -> str:
        """One guest instruction. Stub replies with the stop signal."""
        self._send("s")
        return self._read_packet()

    @staticmethod
    def stop_regs(reply: str) -> dict:
        """GDBStub.cpp:1164 formats every stop as
             T{sig:02x}{64:02x}:{pc:08x};{1:02x}:{sp:08x};
        i.e. 'T0f40:801012b4;01:803c0f78;'.  Note the first key follows the
        signal byte with NO separator, so pairs must be parsed from index 3."""
        if not reply.startswith("T"):
            return {}
        return {int(k, 16): int(v, 16)
                for k, v in re.findall(r"([0-9a-fA-F]{2}):([0-9a-fA-F]+);", reply[3:])}

    @classmethod
    def stop_pc(cls, reply: str):
        """PC is register 64 == key '40'. Pulling it from the stop packet makes a
        trace one round trip per instruction instead of two."""
        return cls.stop_regs(reply).get(64)

    def step_pc(self):
        return self.stop_pc(self.step())

    def trace(self, n: int, progress=None, dedup=False, start_pc=None):
        """n single-steps; returns the list of PCs *after* each step.

        NO-PROGRESS STOPS: 0.35% (clean trace) to 0.56% (post-breakpoint) of
        stops report a PC equal to the previous PC.  The obvious theory -- an
        extra queued Sigtrap being mistaken for the next step's reply -- was
        TESTED AND REFUTED: dedup=True (discard such a reply, read another packet
        without issuing a new 's') MADE IT WORSE, scoring 0.99042 alignment with
        0.652% no-progress against 0.99603 / 0.349% for the same capture with
        dedup off.  It is left off by default and kept only for experiments.
        The reliable mitigation is check_alignment(): gate on it, do not trust a
        trace that scores low.  Reference scores: a trace taken immediately after
        connect with no breakpoint ever armed = 0.996; segments taken after a
        breakpoint stop WITHOUT resync() = 0.0003 (i.e. plausible and totally
        wrong); with resync() = 0.89 median, so still gate per segment."""
        out = []
        prev = start_pc
        for i in range(n):
            pc = self.stop_pc(self.step())
            if pc is None:
                raise RSPError(f"step {i}: stop reply carried no PC")
            if dedup and prev is not None and pc == prev:
                try:
                    alt = self.stop_pc(self._read_packet(timeout=0.05))
                    if alt is not None:
                        pc = alt
                except (socket.timeout, TimeoutError, OSError):
                    pass
                finally:
                    self.sock.settimeout(30.0)
            out.append(pc)
            prev = pc
            if progress and (i + 1) % progress == 0:
                print(f"    ...{i+1}/{n}", flush=True)
        return out

    def read_range(self, lo: int, hi: int, chunk=0x400) -> bytes:
        """Bulk memory read; the stub caps a single 'm' reply, so chunk it."""
        out = bytearray()
        a = lo
        while a < hi:
            k = min(chunk, hi - a)
            out += self.mem(a, k)
            a += k
        return bytes(out)

    def send_cont(self):
        """Send 'c' and DO NOT read the reply.  Pairs with await_stop()."""
        self._send("c")
        self._dirty = True

    def await_stop(self, timeout=120.0) -> str:
        """Read the next stop packet WITHOUT sending anything.

        THE ONLY LEGAL WAY TO WAIT A LONG TIME.  After 'c' the guest is running and
        this stub has no async break, so a client that gives up on the read must NOT
        then send another packet -- including another 'c'.  The stub is not listening
        while the CPU runs, so the second 'c' sits in the socket, gets processed after
        the eventual stop, and resumes the guest behind the client's back; every
        exchange from there on is off by one.  Waiting for a rare event (a cold boot
        reaching OSLink) therefore means: send_cont() ONCE, then await_stop() in a
        loop, treating a timeout as "not yet" rather than as a reason to act."""
        return self._read_packet(timeout=timeout)

    def settle(self, timeout=30.0):
        """Restore the socket timeout.

        `_read_packet(timeout=...)` SETS the socket timeout and never restores it, so
        after a deliberately-short `cont(timeout=15)` every later command inherits 15 s
        -- including ones issued when the stub is busy.  Observed as a bare
        `TimeoutError: timed out` from `add_bp` at the start of the NEXT capture, which
        reads like the emulator died and is only a leaked deadline."""
        self.sock.settimeout(timeout)

    def cont(self, timeout=120.0) -> str:
        """Resume. Blocks until a breakpoint hits (no async break exists).

        ALWAYS resync() before stepping again -- see resync()."""
        self._send("c")
        rep = self._read_packet(timeout=timeout)
        self._dirty = True
        return rep

    def resync(self, quiet=0.25) -> int:
        """Drain unsolicited stop packets, then return the true PC.

        THIS IS LOAD-BEARING.  CPU.cpp:167-190 re-evaluates its wait predicate in
        a loop and calls GDBStub::SendSignal(Sigtrap) EVERY time it does, so a
        breakpoint stop can leave extra unsolicited 'T05...' packets queued.  A
        client that starts stepping without draining them consumes a stale packet
        as the reply to its first 's', and EVERY PC in the trace is then shifted
        by one.  Measured cost of skipping this: a stratified capture scored
        0.03% branch-target self-consistency versus 99.60% for a clean trace --
        i.e. the trace looked entirely plausible and was entirely wrong.
        """
        self.sock.settimeout(quiet)
        try:
            while True:
                try:
                    self.buf += self._recv_raw()
                except (socket.timeout, TimeoutError):
                    break
        finally:
            self.sock.settimeout(30.0)
        self.buf = b""
        self._dirty = False
        return self.pc()

    def check_alignment(self, pcs, entry, words) -> float:
        """Fraction of executed unconditional branches whose ARCHITECTURAL target
        equals the next traced PC.  A correct trace scores ~1.0; a desynchronized
        one scores ~0.  Always assert this before believing a trace."""
        prev, ok, bad = entry, 0, 0
        for p in pcs:
            w = words.get(prev)
            if w is not None and ((w >> 26) & 0x3F) == 18:
                li = (w >> 2) & 0xFFFFFF
                if li & 0x800000:
                    li -= 0x1000000
                tgt = ((li << 2) if ((w >> 1) & 1) else (prev + (li << 2))) & 0xFFFFFFFF
                ok += (tgt == p)
                bad += (tgt != p)
            prev = p
        return ok / max(ok + bad, 1)

    def arch_state(self) -> dict:
        """Everything the stub exposes that a translated function could clobber."""
        st = {"gpr": self.gprs()}
        for name, num in (("pc", 64), ("msr", 65), ("cr", 66), ("lr", 67),
                          ("ctr", 68), ("xer", 69), ("fpscr", 70)):
            st[name] = self.reg(num)
        st["fpr"] = [self.reg(32 + i) for i in range(32)]
        return st


# ---------------------------------------------------------------- launcher


class Dolphin:
    """Headless native Dolphin with the GDB stub up and a savestate resident."""

    def __init__(self, iso=SAB_ISO, state=SAB_STATE, port=9123, log=None,
                 dual_core=True, extra=(), binary=None, gfx="Metal"):
        self.port = port
        self.log_path = log or f"/tmp/sabcensus/dolphin_{port}.log"
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        binary = binary or DOLPHIN_BIN
        args = [binary]
        if binary == NOGUI:
            args.append("--platform=headless")
        args += [
            "-C", f"Dolphin.Core.CPUThread={'True' if dual_core else 'False'}",
            "-C", "Dolphin.Core.CPUCore=1",
            # MANDATORY: without this the JIT emits no breakpoint checks at all.
            "-C", "Dolphin.Interface.DebugModeEnabled=True",
            # A GUEST PANIC IS A BLOCKING MODAL AND NOTHING CLICKS IT.  Observed
            # 2026-09-04 mid-capture: "Unknown Pointer 0x20000030  PC 0x801160b8
            # LR 0x812004dc" with [Ignore for this session]/[OK].  Under -b the
            # process then stalls forever and every RSP read times out, which reads
            # as "the stub never answered" rather than "a dialog is up".  Off, the
            # same condition is a log line (Config::MAIN_USE_PANIC_HANDLERS,
            # Source/Core/Core/Config/MainSettings.cpp:431).
            "-C", "Dolphin.Interface.UsePanicHandlers=False",
            # THE `-C` SYSTEM NAME FOR Dolphin.ini IS "Dolphin", NOT "Main".
            # Config.cpp:158 maps System::Main -> "Dolphin", and
            # CommandLineParse.cpp:54-60 SILENTLY DROPS a location whose system name
            # does not resolve -- so `-C Main.General.GDBPort=...` sets nothing and
            # says nothing.  The C++ Info<> objects are declared with System::Main,
            # which is what makes "Main" look right in the source.
            #
            # Video: Null by default for a capture run.  Metal SEGV'd on the CPU-GPU
            # thread (EXC_BAD_ACCESS at 0x0 in Dolphin 2603a, parent process Python,
            # 2026-09-04) and a GDB-stub capture renders nothing it reads back.  Null
            # is always registered (VideoBackendBase.cpp:245), unlike Software, which
            # is compiled in only under HAS_OPENGL/__LIBRETRO__ (:242-244).  Audio is
            # forced off -- two concurrent Dolphins corrupt CoreAudio's heap
            # (crash 2026-08-29-170318).
            "-C", f"Dolphin.Core.GFXBackend={gfx}",
            "-C", "Dolphin.DSP.Backend=No Audio Output",
            "-C", f"Dolphin.General.GDBPort={port}",
            *extra,
            "-e", iso,
        ]
        if state:
            args += ["-s", state]
        self.logf = open(self.log_path, "w")
        self.proc = subprocess.Popen(args, stdout=self.logf, stderr=subprocess.STDOUT)

    def connect(self, deadline=180.0) -> GDB:
        """The stub listens only after the savestate has been applied
        (Core.cpp:388 loads the state, :418 then starts the stub), so a
        successful connect already proves the scene is resident."""
        t0 = time.time()
        while time.time() - t0 < deadline:
            if self.proc.poll() is not None:
                raise RSPError(f"dolphin exited rc={self.proc.returncode}; see {self.log_path}")
            try:
                return GDB(port=self.port)
            except (ConnectionRefusedError, OSError):
                time.sleep(1.0)
        raise RSPError(f"gdb stub never came up on {self.port}; see {self.log_path}")

    def kill(self):
        try:
            self.proc.kill()
            self.proc.wait(timeout=10)
        except Exception:
            pass
        try:
            self.logf.close()
        except Exception:
            pass


# ---------------------------------------------------------------- symbols


def load_map(path=SAB_MAP):
    """Dolphin .map: 'ADDR SIZE VADDR align name [object]' under section headers."""
    syms = []
    section = None
    with open(path, errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            m = re.match(r"^(\.\w+) section layout", line)
            if m:
                section = m.group(1)
                continue
            m = re.match(r"^([0-9a-f]{8})\s+([0-9a-f]{6})\s+([0-9a-f]{8})\s+(\d+)\s+(\S+)(.*)$",
                         line)
            if m and section == ".text":
                start = int(m.group(3), 16)
                size = int(m.group(2), 16)
                syms.append({"start": start, "size": size, "end": start + size,
                             "name": m.group(5), "obj": m.group(6).strip()})
    syms.sort(key=lambda s: s["start"])
    return syms


def symbolize(syms, addr):
    lo, hi = 0, len(syms) - 1
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if syms[mid]["start"] <= addr:
            best = syms[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    if best and best["start"] <= addr < best["end"]:
        return best
    return None


# ------------------------------------------------- store decoding (write log)
#
# A differential oracle is only trustworthy if it never misses a write.  Every
# store form this decoder does not know is reported as an explicit
# "unknown_store" entry rather than silently dropped.

_D_STORES = {  # opcode -> (size, updates_rA)
    38: (1, False), 39: (1, True),    # stb, stbu
    44: (2, False), 45: (2, True),    # sth, sthu
    36: (4, False), 37: (4, True),    # stw, stwu
    52: (4, False), 53: (4, True),    # stfs, stfsu
    54: (8, False), 55: (8, True),    # stfd, stfdu
}
_X_STORES = {  # opcode 31 extended-opcode -> (size, updates_rA)
    215: (1, False), 247: (1, True),   # stbx, stbux
    407: (2, False), 439: (2, True),   # sthx, sthux
    151: (4, False), 183: (4, True),   # stwx, stwux
    663: (4, False), 695: (4, True),   # stfsx, stfsux
    727: (8, False), 759: (8, True),   # stfdx, stfdux
    662: (4, False), 918: (2, False),  # stwbrx, sthbrx
    150: (4, False),                   # stwcx.
    725: (0, False), 661: (0, False),  # stswi, stswx -- variable length
}


def decode_store(word: int, gpr):
    """-> (ea, size) | ('unknown', descr) | None if not a store.
    gpr must be the GPR file BEFORE the instruction executes."""
    op = (word >> 26) & 0x3F
    ra = (word >> 16) & 0x1F
    rb = (word >> 11) & 0x1F
    if op in _D_STORES:
        size, _ = _D_STORES[op]
        simm = word & 0xFFFF
        if simm & 0x8000:
            simm -= 0x10000
        base = gpr[ra] if ra else 0
        return ((base + simm) & 0xFFFFFFFF, size)
    if op == 31:
        xo = (word >> 1) & 0x3FF
        if xo in _X_STORES:
            size, _ = _X_STORES[xo]
            base = gpr[ra] if ra else 0
            ea = (base + gpr[rb]) & 0xFFFFFFFF
            if size == 0:
                return ("unknown", f"string store xo={xo} at ea={ea:#x}")
            return (ea, size)
        return None
    if op == 47:  # stmw: rS..r31 to consecutive words
        simm = word & 0xFFFF
        if simm & 0x8000:
            simm -= 0x10000
        rs = (word >> 21) & 0x1F
        base = gpr[ra] if ra else 0
        return ((base + simm) & 0xFFFFFFFF, 4 * (32 - rs))
    if op in (60, 61):  # psq_st / psq_stu -- paired single, 4 or 8 bytes
        d = word & 0xFFF
        if d & 0x800:
            d -= 0x1000
        base = gpr[ra] if ra else 0
        w = (word >> 15) & 1
        return ((base + d) & 0xFFFFFFFF, 4 if w else 8)
    if op == 4:
        xo6 = (word >> 1) & 0x1F
        if xo6 in (7, 6):  # psq_stx / psq_stux family
            base = gpr[ra] if ra else 0
            return ((base + gpr[rb]) & 0xFFFFFFFF, 8)
    return None


_D_LOADS = {  # opcode -> size (0 = variable, decoded specially)
    32: 4, 33: 4,      # lwz,  lwzu
    34: 1, 35: 1,      # lbz,  lbzu
    40: 2, 41: 2,      # lhz,  lhzu
    42: 2, 43: 2,      # lha,  lhau
    48: 4, 49: 4,      # lfs,  lfsu
    50: 8, 51: 8,      # lfd,  lfdu
}
_X_LOADS = {
    23: 4, 55: 4,      # lwzx,  lwzux
    87: 1, 119: 1,     # lbzx,  lbzux
    279: 2, 311: 2,    # lhzx,  lhzux
    343: 2, 375: 2,    # lhax,  lhaux
    535: 4, 567: 4,    # lfsx,  lfsux
    599: 8, 631: 8,    # lfdx,  lfdux
    534: 4, 790: 2,    # lwbrx, lhbrx
    20: 4,             # lwarx
    597: 0, 533: 0,    # lswi, lswx -- variable length, reported as unknown
}


def decode_load(word: int, gpr):
    """-> (ea, size) | ('unknown', descr) | None if not a load.

    The MIRROR of decode_store.  A replayable fixture needs the INITIAL value of
    every location the function reads, so a load form this does not know must be
    surfaced loudly, exactly like an unknown store."""
    op = (word >> 26) & 0x3F
    ra = (word >> 16) & 0x1F
    rb = (word >> 11) & 0x1F
    simm = word & 0xFFFF
    if simm & 0x8000:
        simm -= 0x10000
    base = gpr[ra] if ra else 0
    if op in _D_LOADS:
        return ((base + simm) & 0xFFFFFFFF, _D_LOADS[op])
    if op == 46:  # lmw: rD..r31 from consecutive words
        rd = (word >> 21) & 0x1F
        return ((base + simm) & 0xFFFFFFFF, 4 * (32 - rd))
    if op in (56, 57):  # psq_l / psq_lu
        d = word & 0xFFF
        if d & 0x800:
            d -= 0x1000
        w = (word >> 15) & 1
        return ((base + d) & 0xFFFFFFFF, 4 if w else 8)
    if op == 4:
        xo = (word >> 1) & 0x3FF
        if xo in (6, 38, 7, 39):        # psq_lx / psq_lux / psq_stx / psq_stux
            return ("unknown", f"x-form quantized paired op4 xo={xo}")
        return None
    if op == 31:
        xo = (word >> 1) & 0x3FF
        if xo in _X_LOADS:
            size = _X_LOADS[xo]
            ea = (base + gpr[rb]) & 0xFFFFFFFF
            if size == 0:
                return ("unknown", f"string load xo={xo} at ea={ea:#x}")
            return (ea, size)
    return None


MEM1_LO, MEM1_HI = 0x80000000, 0x81800000


def capture_replayable_fixture(g: "GDB", entry: int, syms=None, max_steps=200000,
                               progress=None, cont_timeout=120.0, prefetch=None,
                               at_entry=False):
    """capture_fixture + everything needed to RE-RUN the invocation elsewhere.

    capture_fixture records what changed.  To replay a function in the recompiled
    wasm you also need what it READ, and reading the whole 24 MB MEM1 over the RSP
    is not practical.  So this records, for every load, the bytes AS THEY WERE AT
    THE START OF THE INVOCATION -- i.e. the first read of each byte, skipped if this
    invocation already wrote that byte (a read-after-own-write must observe the
    write, not a staged initial value).

    Also returns the executed instruction stream, which the caller needs to decide
    whether the fixture depends on incoming PS1 lanes (the GDB stub cannot read
    PS1, so a fixture that does is NOT replayable and must be rejected, not fudged).

    `cont_timeout` bounds ONE read of the stop packet.  A SHORT value here is a trap
    and it cost a run: `cont()` sends 'c' and the guest keeps running, and this stub
    has NO async break, so a client that abandons the read and then sends anything
    else is permanently one packet behind.  Measured, with cont_timeout=15 on
    candidates that fired during discovery but not again: two abandoned conts, then
    `ConnectionResetError` and `BrokenPipeError` on EVERY later capture -- which reads
    exactly like Dolphin crashing and is entirely self-inflicted.  The way to survey
    many functions cheaply is `at_entry` below, NOT a short deadline.

    `prefetch` is {guest_addr: instruction_word} used instead of an `m` packet for the
    instruction fetch.  For a REL overlay the relocated section has already been read
    out of the machine in full (fixture_rel.py writes it next to the fixtures), so
    every overlay instruction fetch can be served locally.  `syms` does the same job
    for the DOL, but a symbol map cannot cover an overlay -- it has no symbols.

    `at_entry` says the caller ALREADY holds the cpu stopped at `entry`, because its
    own breakpoint just fired there.  A SURVEY needs this: otherwise every capture has
    to reach the entry a SECOND time, and a function that runs once per scene never
    does -- so the rarest functions, which are exactly the ones a survey is for, are
    the ones that get refused.  The caller owns removing its own breakpoints before
    this steps.
    """
    if not at_entry:
        g.settle()        # a previous bounded cont() leaves its short deadline behind
        g.add_bp(entry)
        try:
            for _ in range(4000):
                rep = g.cont(timeout=cont_timeout)
                if GDB.stop_pc(rep) == entry:
                    break
            else:
                raise RSPError(f"never reached {entry:#010x}")
        except (socket.timeout, TimeoutError) as e:
            g.settle()
            g.del_bp(entry)
            raise RSPError(f"never reached {entry:#010x} in {cont_timeout:.0f}s") from e
        g.settle()
        g.del_bp(entry)
    g.resync()
    pc_now = g.pc()
    if pc_now != entry:
        raise RSPError(f"not stopped at {entry:#010x} (pc={pc_now:#010x})")

    st_in = g.arch_state()
    ret_addr = st_in["lr"]
    sp_in = st_in["gpr"][1]

    body = dict(prefetch) if prefetch else {}
    if syms:
        s = symbolize(syms, entry)
        if s:
            blob = g.read_range(s["start"], s["end"])
            for i in range(0, len(blob), 4):
                body[s["start"] + i] = int.from_bytes(blob[i:i + 4], "big")

    writes, unknown, stream = [], [], []
    initial = {}          # guest addr -> byte, as of entry
    written = set()       # bytes this invocation has already written
    outside = set()       # non-MEM1 addresses touched
    # ...and HOW.  A region this harness cannot stage is only fatal if the function
    # READS from it: a write-only region (the GX write-gather pipe at 0xCC008000, and
    # possibly the locked cache used purely as a scratch destination) needs somewhere
    # to put the bytes, not a staged initial value.  Recording the direction is what
    # makes that distinction available instead of refusing the whole class blind.
    outside_kind = {}
    steps, pc = 0, entry
    while steps < max_steps:
        word = body.get(pc)
        if word is None:
            word = int.from_bytes(g.mem(pc, 4), "big")
            body[pc] = word
        gpr = g.gprs()
        stream.append((pc, word))

        ld = decode_load(word, gpr)
        if ld and ld[0] == "unknown":
            unknown.append({"pc": pc, "why": ld[1], "kind": "load"})
        elif ld:
            ea, size = ld
            need = [a for a in range(ea, ea + size)
                    if a not in written and a not in initial]
            if need:
                if MEM1_LO <= ea and ea + size <= MEM1_HI:
                    try:
                        blob = g.mem(ea, size)
                        for i, a in enumerate(range(ea, ea + size)):
                            if a in need:
                                initial[a] = blob[i]
                    except RSPError:
                        unknown.append({"pc": pc, "why": f"load read failed at {ea:#x}",
                                        "kind": "load"})
                else:
                    outside.add(ea)
                    outside_kind[ea] = ('both' if outside_kind.get(ea) == 'store'
                                        else 'load')

        pend = decode_store(word, gpr)
        if pend and pend[0] == "unknown":
            unknown.append({"pc": pc, "why": pend[1], "kind": "store"})
            pend = None
        pre = None
        if pend:
            ea, size = pend
            if not (MEM1_LO <= ea and ea + size <= MEM1_HI):
                # DO NOT ASK THE STUB FOR IT.  This used to read the pre-image
                # unconditionally, and an `m` packet for a GEKKO LOCKED CACHE address
                # (0xE0000000..) walks Dolphin into an inconsistency between two of
                # its own predicates and takes the emulator with it.  The chain, all
                # in this tree:
                #   GDBStub.cpp:828  gates on MMU::HostIsRAMAddress, which
                #   MMU.cpp:926-929  answers TRUE for segment 0xE inside the L1 cache
                #   GDBStub.cpp:833  so it calls Memory::GetPointerForRange, which
                #   Memmap.cpp:634   calls GetSpanForAddress, which
                #   Memmap.cpp:723   masks the address with 0x3FFFFFFF and has NO
                #                    L1-cache arm, so
                #   Memmap.cpp:740   PanicAlertFmt("Unknown Pointer ...") and returns
                #                    an empty span, and
                #   Memmap.cpp:636-640 turns that into a nullptr, which
                #   GDBStub.cpp:834  hands straight to Mem2hex(reply, data, len).
                # Both observed symptoms follow: a BLOCKING MODAL that nothing clicks
                # under -b (so the emulator stalls and every later RSP read times
                # out), and then EXC_BAD_ACCESS at 0x0.  The message the user saw --
                # "Unknown Pointer 0x20000030 PC 0x801160b8 LR 0x812004dc" -- is this
                # line: 0xE0000030 & 0x3FFFFFFF == 0x20000030.
                #
                # THE GUEST WAS NOT FAULTING.  Guest loads and stores reach the
                # locked cache through MMU.cpp:246-251, which handles it correctly;
                # GetSpanForAddress is the HOST-side pointer path, and the only
                # caller here was this line.  SAB's City Escape overlay uses the
                # locked cache normally (two already-recorded fixtures touch
                # 0xE0000000.. and 0xE0000060..).
                #
                # Recording the address in `outside` is all that is needed: the
                # replay harness stages MEM1 only, so verify_fixture.mjs refuses any
                # fixture with a non-empty outside_mem1 anyway.
                outside.add(ea)
                outside_kind[ea] = ('both' if outside_kind.get(ea) == 'load'
                                    else 'store')
                pend = None
            else:
                try:
                    pre = g.mem(ea, size)
                except RSPError:
                    pre = None
                    unknown.append({"pc": pc, "why": f"store pre-read failed at {ea:#x}",
                                    "kind": "store"})

        rep = g.step()
        steps += 1
        npc = GDB.stop_pc(rep)
        if pend and pre is not None:
            ea, size = pend
            try:
                post = g.mem(ea, size)
                # Record EVERY store, including value-preserving ones: the replay
                # comparator filters by per-byte change, so both sides must agree
                # on what was attempted, not on what happened to differ.
                writes.append({"pc": pc, "ea": ea, "size": size,
                               "before": pre.hex(), "after": post.hex()})
                for i, a in enumerate(range(ea, ea + size)):
                    if a not in initial and a not in written:
                        initial[a] = pre[i]     # the pre-image IS the initial value
                    written.add(a)
            except RSPError:
                unknown.append({"pc": pc, "why": f"store post-read failed at {ea:#x}",
                                "kind": "store"})
        pc = npc
        if progress and steps % progress == 0:
            print(f"    ...{steps} steps, pc={pc:#010x}", flush=True)
        if pc == ret_addr and g.gprs()[1] >= sp_in:
            break

    st_out = g.arch_state()
    delta = {}
    for i in range(32):
        if st_in["gpr"][i] != st_out["gpr"][i]:
            delta[f"r{i}"] = [st_in["gpr"][i], st_out["gpr"][i]]
    for i in range(32):
        if st_in["fpr"][i] != st_out["fpr"][i]:
            delta[f"f{i}"] = [st_in["fpr"][i], st_out["fpr"][i]]
    for k in ("cr", "xer", "lr", "ctr", "fpscr", "msr"):
        if st_in[k] != st_out[k]:
            delta[k] = [st_in[k], st_out[k]]
    return {"entry": entry, "ret_addr": ret_addr, "steps": steps,
            "returned": pc == ret_addr, "state_in": st_in, "state_out": st_out,
            "delta": delta, "writes": writes, "unknown_stores": unknown,
            "initial_mem": {f"{a:08x}": b for a, b in sorted(initial.items())},
            "outside_mem1": sorted(outside),
            "outside_mem1_kind": {f"{a:08x}": k for a, k in sorted(outside_kind.items())},
            "stream": [[p, w] for p, w in stream]}


def capture_fixture(g: "GDB", entry: int, syms=None, max_steps=200000,
                    watch_memory=True):
    """THE DIFFERENTIAL FIXTURE.

    Runs one invocation of the guest function at `entry` under native Dolphin and
    returns the complete architectural delta a translated wasm function must
    reproduce: entry state, exit state, and the ORDERED log of memory writes.

    Return detection: the callee returns when PC == the LR captured at entry AND
    the stack pointer is back at (or above) its entry value.  Both conditions are
    required -- PC alone false-positives on a recursive/tail path.
    """
    g.add_bp(entry)
    for _ in range(4000):
        rep = g.cont(timeout=120.0)
        if GDB.stop_pc(rep) == entry:
            break
    else:
        raise RSPError(f"never reached {entry:#010x}")
    g.del_bp(entry)
    g.resync()

    st_in = g.arch_state()
    ret_addr = st_in["lr"]
    sp_in = st_in["gpr"][1]

    body = {}
    if syms:
        s = symbolize(syms, entry)
        if s:
            blob = g.read_range(s["start"], s["end"])
            for i in range(0, len(blob), 4):
                body[s["start"] + i] = int.from_bytes(blob[i:i+4], "big")

    writes, unknown, steps = [], [], 0
    pc = entry
    while steps < max_steps:
        word = body.get(pc)
        if word is None:
            word = int.from_bytes(g.mem(pc, 4), "big")
            body[pc] = word
        pend = decode_store(word, g.gprs()) if watch_memory else None
        if pend and pend[0] == "unknown":
            unknown.append({"pc": pc, "why": pend[1]})
            pend = None
        pre = None
        if pend:
            ea, size = pend
            # SAME HAZARD as in capture_replayable_fixture: an `m` packet for a
            # non-MEM1 address (the Gekko locked cache at 0xE00000xx above all) walks
            # GDBStub.cpp:828/833 -> Memmap.cpp:740 into a blocking panic modal and
            # then a null dereference.  See the long note there for the exact chain.
            if not (MEM1_LO <= ea and ea + size <= MEM1_HI):
                unknown.append({"pc": pc, "why": f"store outside MEM1 at {ea:#x}"})
                pend = None
            else:
                try:
                    pre = g.mem(ea, size)
                except RSPError:
                    pre = None
        rep = g.step()
        steps += 1
        npc = GDB.stop_pc(rep)
        if pend and pre is not None:
            ea, size = pend
            try:
                post = g.mem(ea, size)
                if post != pre:
                    writes.append({"pc": pc, "ea": ea, "size": size,
                                   "before": pre.hex(), "after": post.hex()})
            except RSPError:
                pass
        pc = npc
        if pc == ret_addr and g.gprs()[1] >= sp_in:
            break

    st_out = g.arch_state()
    delta = {}
    for i in range(32):
        if st_in["gpr"][i] != st_out["gpr"][i]:
            delta[f"r{i}"] = [st_in["gpr"][i], st_out["gpr"][i]]
    for i in range(32):
        if st_in["fpr"][i] != st_out["fpr"][i]:
            delta[f"f{i}"] = [st_in["fpr"][i], st_out["fpr"][i]]
    for k in ("cr", "xer", "lr", "ctr", "fpscr", "msr"):
        if st_in[k] != st_out[k]:
            delta[k] = [st_in[k], st_out[k]]
    return {"entry": entry, "ret_addr": ret_addr, "steps": steps,
            "returned": pc == ret_addr, "state_in": st_in, "state_out": st_out,
            "delta": delta, "writes": writes, "unknown_stores": unknown}


if __name__ == "__main__":
    syms = load_map()
    print(f"map: {len(syms)} .text symbols, "
          f"{syms[0]['start']:#010x}..{syms[-1]['end']:#010x}")
    print(f"nogui: {NOGUI} exists={os.path.exists(NOGUI)}")
    print(f"iso:   {SAB_ISO} exists={os.path.exists(SAB_ISO)}")
    print(f"state: {SAB_STATE} exists={os.path.exists(SAB_STATE)}")
