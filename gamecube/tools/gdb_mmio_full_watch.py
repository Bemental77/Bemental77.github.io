#!/usr/bin/env python3
"""Comprehensive native-Dolphin MMIO trajectory capture via GDB Z2/Z3 watchpoints.

Dolphin's GDB-RSP routes Z2/Z3 to MemChecks (see GDBStub.cpp:872-901 →
MemChecks.Add()) which fire from MMU::Memcheck() on every guest read/write
(MMU.cpp:633-666). MMIO addresses trigger because Memcheck() runs on the
guest EA *before* hardware dispatch.

The count is NOT hardware-limited — only performance-bound (linear lookup in
MemChecks vector). We register both r-watch (Z3) and w-watch (Z2) covering
EVERY MMIO register exposed by RegisterMMIO() across each subsystem.

Subsystem base addresses (Memmap.cpp:68-77 — guest virtual = 0xCC0xxxxx):
  CP   0x0C000000  (CommandProcessor.h:59-93)
  PE   0x0C001000  (PixelEngine.h:31-57)
  VI   0x0C002000  (VideoInterface.h:28-87)
  PI   0x0C003000  (ProcessorInterface.h:52-60)
  MI   0x0C004000  (MemoryInterface.cpp:19-53)
  DSP  0x0C005000  (DSP.cpp:58-77)
  DI   0x0C006000  (DVDInterface.cpp:77-86)
  SI   0x0C006400  (SI.cpp:42-58)
  EXI  0x0C006800  (EXI.cpp:186-198, EXI_Channel.h:55-59 — 3 channels x 5 regs x 4B)
  AI   0x0C006C00  (AudioInterface.cpp:58-61)
  GP   0x0C008000  (GPFifo.h:19 — single 32B write-burst port)
"""
import socket, sys, collections

PORT = 9091
NHITS = int(sys.argv[1]) if len(sys.argv) > 1 else 5000

# Helper: build watch tuples for (kind, addr, label).
# kind: 2 = write watch, 3 = read watch.
WATCHES = []

def add_rw(addr, label):
    WATCHES.append((3, addr, label + ".r"))
    WATCHES.append((2, addr, label + ".w"))

# --- CP (CommandProcessor) — base 0xCC000000 — CommandProcessor.h:59-93 ---
for off, name in [
    (0x00, "CP_STATUS"), (0x02, "CP_CTRL"), (0x04, "CP_CLEAR"),
    (0x06, "CP_PERF_SELECT"), (0x0A, "CP_UNK_0A"),
    (0x20, "CP_FIFO_BASE_LO"), (0x22, "CP_FIFO_BASE_HI"),
    (0x24, "CP_FIFO_END_LO"), (0x26, "CP_FIFO_END_HI"),
    (0x28, "CP_FIFO_HIWM_LO"), (0x2A, "CP_FIFO_HIWM_HI"),
    (0x2C, "CP_FIFO_LOWM_LO"), (0x2E, "CP_FIFO_LOWM_HI"),
    (0x30, "CP_FIFO_RWDIST_LO"), (0x32, "CP_FIFO_RWDIST_HI"),
    (0x34, "CP_FIFO_WPTR_LO"), (0x36, "CP_FIFO_WPTR_HI"),
    (0x38, "CP_FIFO_RPTR_LO"), (0x3A, "CP_FIFO_RPTR_HI"),
    (0x3C, "CP_FIFO_BP_LO"), (0x3E, "CP_FIFO_BP_HI"),
]:
    add_rw(0xCC000000 + off, name)

# --- PE (PixelEngine) — base 0xCC001000 — PixelEngine.h:31-57 ---
for off, name in [
    (0x00, "PE_ZCONF"), (0x02, "PE_ALPHACONF"), (0x04, "PE_DSTALPHACONF"),
    (0x06, "PE_ALPHAMODE"), (0x08, "PE_ALPHAREAD"),
    (0x0A, "PE_CTRL"), (0x0E, "PE_TOKEN"),
    (0x10, "PE_BBOX_L"), (0x12, "PE_BBOX_R"),
    (0x14, "PE_BBOX_T"), (0x16, "PE_BBOX_B"),
]:
    add_rw(0xCC001000 + off, name)

# --- VI (VideoInterface) — base 0xCC002000 — VideoInterface.h:28-87 ---
for off, name in [
    (0x00, "VI_VTIMING"), (0x02, "VI_CTRL"),
    (0x04, "VI_HTIMING0_HI"), (0x06, "VI_HTIMING0_LO"),
    (0x08, "VI_HTIMING1_HI"), (0x0A, "VI_HTIMING1_LO"),
    (0x0C, "VI_VBLANK_ODD_HI"), (0x0E, "VI_VBLANK_ODD_LO"),
    (0x10, "VI_VBLANK_EVEN_HI"), (0x12, "VI_VBLANK_EVEN_LO"),
    (0x14, "VI_BURST_ODD_HI"), (0x16, "VI_BURST_ODD_LO"),
    (0x18, "VI_BURST_EVEN_HI"), (0x1A, "VI_BURST_EVEN_LO"),
    (0x1C, "VI_FB_LT_HI"), (0x1E, "VI_FB_LT_LO"),
    (0x20, "VI_FB_RT_HI"), (0x22, "VI_FB_RT_LO"),
    (0x24, "VI_FB_LB_HI"), (0x26, "VI_FB_LB_LO"),
    (0x28, "VI_FB_RB_HI"), (0x2A, "VI_FB_RB_LO"),
    (0x2C, "VI_VBEAM_POS"), (0x2E, "VI_HBEAM_POS"),
    (0x30, "VI_PRERETRACE_HI"), (0x32, "VI_PRERETRACE_LO"),
    (0x34, "VI_POSTRETRACE_HI"), (0x36, "VI_POSTRETRACE_LO"),
    (0x38, "VI_DI2_HI"), (0x3A, "VI_DI2_LO"),
    (0x3C, "VI_DI3_HI"), (0x3E, "VI_DI3_LO"),
    (0x40, "VI_LATCH0_HI"), (0x42, "VI_LATCH0_LO"),
    (0x44, "VI_LATCH1_HI"), (0x46, "VI_LATCH1_LO"),
    (0x48, "VI_HSCALEW"), (0x4A, "VI_HSCALER"),
    (0x4C, "VI_FILT0_HI"), (0x4E, "VI_FILT0_LO"),
    (0x50, "VI_FILT1_HI"), (0x52, "VI_FILT1_LO"),
    (0x54, "VI_FILT2_HI"), (0x56, "VI_FILT2_LO"),
    (0x58, "VI_FILT3_HI"), (0x5A, "VI_FILT3_LO"),
    (0x5C, "VI_FILT4_HI"), (0x5E, "VI_FILT4_LO"),
    (0x60, "VI_FILT5_HI"), (0x62, "VI_FILT5_LO"),
    (0x64, "VI_FILT6_HI"), (0x66, "VI_FILT6_LO"),
    (0x68, "VI_AA_HI"), (0x6A, "VI_AA_LO"),
    (0x6C, "VI_CLOCK"), (0x6E, "VI_DTV_STATUS"),
    (0x70, "VI_FBWIDTH"),
    (0x72, "VI_BORDER_BLANK_END"), (0x74, "VI_BORDER_BLANK_START"),
]:
    add_rw(0xCC002000 + off, name)

# --- PI (ProcessorInterface) — base 0xCC003000 — ProcessorInterface.h:52-60 ---
for off, name in [
    (0x00, "PI_INTSR"), (0x04, "PI_INTMR"),
    (0x0C, "PI_FIFO_BASE"), (0x10, "PI_FIFO_END"), (0x14, "PI_FIFO_WPTR"),
    (0x18, "PI_FIFO_RESET"),
    (0x24, "PI_RESET_CODE"),
    (0x2C, "PI_FLIPPER_REV"), (0x30, "PI_FLIPPER_UNK"),
]:
    add_rw(0xCC003000 + off, name)

# --- MI (MemoryInterface) — base 0xCC004000 — MemoryInterface.cpp:19-53 (u16 wide) ---
for off, name in [
    (0x000, "MI_R0_FIRST"), (0x002, "MI_R0_LAST"),
    (0x004, "MI_R1_FIRST"), (0x006, "MI_R1_LAST"),
    (0x008, "MI_R2_FIRST"), (0x00A, "MI_R2_LAST"),
    (0x00C, "MI_R3_FIRST"), (0x00E, "MI_R3_LAST"),
    (0x010, "MI_PROT_TYPE"),
    (0x01C, "MI_IRQMASK"), (0x01E, "MI_IRQFLAG"),
    (0x020, "MI_UNKNOWN1"),
    (0x022, "MI_PROT_ADDR_LO"), (0x024, "MI_PROT_ADDR_HI"),
    (0x032, "MI_TIMER0_HI"), (0x034, "MI_TIMER0_LO"),
    (0x036, "MI_TIMER1_HI"), (0x038, "MI_TIMER1_LO"),
    (0x03A, "MI_TIMER2_HI"), (0x03C, "MI_TIMER2_LO"),
    (0x03E, "MI_TIMER3_HI"), (0x040, "MI_TIMER3_LO"),
    (0x042, "MI_TIMER4_HI"), (0x044, "MI_TIMER4_LO"),
    (0x046, "MI_TIMER5_HI"), (0x048, "MI_TIMER5_LO"),
    (0x04A, "MI_TIMER6_HI"), (0x04C, "MI_TIMER6_LO"),
    (0x04E, "MI_TIMER7_HI"), (0x050, "MI_TIMER7_LO"),
    (0x052, "MI_TIMER8_HI"), (0x054, "MI_TIMER8_LO"),
    (0x056, "MI_TIMER9_HI"), (0x058, "MI_TIMER9_LO"),
    (0x05A, "MI_UNKNOWN2"),
]:
    add_rw(0xCC004000 + off, name)

# --- DSP — base 0xCC005000 — DSP.cpp:58-77. Enum vals are absolute-in-MMIO (0x5000-based). ---
# Memmap.cpp:73 passes base=0x0C005000; "base | DSP_FOO" with DSP_FOO≥0x5000 → 0x0C005000 | 0x5000 = 0x0C005000.
# So MMIO address = (0x0C005000 & ~0xFFFF) | off  i.e. 0x0C000000 + off  for off in [0x5000..0x503A].
for off, name in [
    (0x5000, "DSP_MAIL_TO_DSP_HI"), (0x5002, "DSP_MAIL_TO_DSP_LO"),
    (0x5004, "DSP_MAIL_FROM_DSP_HI"), (0x5006, "DSP_MAIL_FROM_DSP_LO"),
    (0x500A, "DSP_CONTROL"), (0x5010, "DSP_INT_CONTROL"),
    (0x5012, "DSP_AR_INFO"), (0x5016, "DSP_AR_MODE"), (0x501A, "DSP_AR_REFRESH"),
    (0x5020, "DSP_AR_DMA_MMADDR_H"), (0x5022, "DSP_AR_DMA_MMADDR_L"),
    (0x5024, "DSP_AR_DMA_ARADDR_H"), (0x5026, "DSP_AR_DMA_ARADDR_L"),
    (0x5028, "DSP_AR_DMA_CNT_H"),    (0x502A, "DSP_AR_DMA_CNT_L"),
    (0x5030, "DSP_ADMA_START_HI"),   (0x5032, "DSP_ADMA_START_LO"),
    (0x5034, "DSP_ADMA_BLOCKS_LEN"), (0x5036, "DSP_ADMA_CTRL_LEN"),
    (0x503A, "DSP_ADMA_BLOCKS_LEFT"),
]:
    add_rw(0xCC000000 + off, name)

# --- DI (DVDInterface) — base 0xCC006000 — DVDInterface.cpp:77-86 ---
for off, name in [
    (0x00, "DI_STATUS"), (0x04, "DI_COVER"),
    (0x08, "DI_CMD0"), (0x0C, "DI_CMD1"), (0x10, "DI_CMD2"),
    (0x14, "DI_DMA_ADDR"), (0x18, "DI_DMA_LEN"), (0x1C, "DI_DMA_CTRL"),
    (0x20, "DI_IMM_BUF"), (0x24, "DI_CONFIG"),
]:
    add_rw(0xCC006000 + off, name)

# --- SI (SerialInterface) — base 0xCC006400 — SI.cpp:42-58 ---
for off, name in [
    (0x00, "SI_CH0_OUT"),   (0x04, "SI_CH0_IN_HI"), (0x08, "SI_CH0_IN_LO"),
    (0x0C, "SI_CH1_OUT"),   (0x10, "SI_CH1_IN_HI"), (0x14, "SI_CH1_IN_LO"),
    (0x18, "SI_CH2_OUT"),   (0x1C, "SI_CH2_IN_HI"), (0x20, "SI_CH2_IN_LO"),
    (0x24, "SI_CH3_OUT"),   (0x28, "SI_CH3_IN_HI"), (0x2C, "SI_CH3_IN_LO"),
    (0x30, "SI_POLL"), (0x34, "SI_COMCSR"), (0x38, "SI_STATUS"),
    (0x3C, "SI_EXI_CLK_CNT"),
    (0x80, "SI_IOBUF_00"), (0x84, "SI_IOBUF_04"), (0x88, "SI_IOBUF_08"),
    (0x8C, "SI_IOBUF_0C"),
]:
    add_rw(0xCC006400 + off, name)

# --- EXI — base 0xCC006800; 3 channels × 5 regs × 4B (EXI.cpp:186-198, EXI_Channel.h:55-59) ---
EXI_REGS = [
    (0x00, "EXI_STATUS"), (0x04, "EXI_DMA_ADDR"),
    (0x08, "EXI_DMA_LEN"), (0x0C, "EXI_DMA_CTRL"), (0x10, "EXI_IMM_DATA"),
]
for ch in (0, 1, 2):
    ch_base = 0xCC006800 + 5 * 4 * ch
    for off, name in EXI_REGS:
        add_rw(ch_base + off, f"EXI{ch}_{name}")

# --- AI (AudioInterface) — base 0xCC006C00 — AudioInterface.cpp:58-61 (offsets are absolute-in-MMIO) ---
# base=0x0C006C00, AI_CONTROL_REGISTER=0x6C00; (base|0x6C00) = 0x0C006C00; (base|0x6C04) = 0x0C006C04.
for off, name in [
    (0x6C00, "AI_CONTROL"), (0x6C04, "AI_VOLUME"),
    (0x6C08, "AI_SAMPLE_COUNTER"), (0x6C0C, "AI_INT_TIMING"),
]:
    add_rw(0xCC000000 + off, name)

# --- GP FIFO — single 32B write-burst port at 0xCC008000 (GPFifo.h:19) ---
add_rw(0xCC008000, "GP_FIFO")


def cksum(s): return sum(s.encode()) & 0xff
def send(s, d): s.sendall(f"${d}#{cksum(d):02x}".encode())
def recv(s):
    while True:
        ch = s.recv(1)
        if not ch: return None
        if ch in (b"+", b"-"): continue
        if ch == b"$":
            buf = b""
            while True:
                c = s.recv(1)
                if c == b"#": s.recv(2); s.sendall(b"+"); return buf.decode("latin-1")
                buf += c
def cmd(s, p): send(s, p); return recv(s)
def reg(s, n):
    r = cmd(s, f"p{n:x}")
    try: return int.from_bytes(bytes.fromhex(r), "big")
    except Exception: return None
def memread(s, addr, n):
    """Read n bytes from guest memory via gdb m packet. Returns bytes or None."""
    r = cmd(s, f"m{addr:x},{n:x}")
    if not r or r.startswith("E"): return None
    try: return bytes.fromhex(r)
    except Exception: return None
def h(v): return "????????" if v is None else f"{v & 0xffffffff:08x}"

# D-form load/store opcodes that touch memory with EA = (rA?ra:0) + simm16.
# We only care about MMIO-touching ones here (loads/stores, any width).
DFORM_OPCODES = {
    32: ("lwz", "u32"), 33: ("lwzu", "u32"),
    34: ("lbz", "u8"),  35: ("lbzu", "u8"),
    36: ("stw", "u32"), 37: ("stwu", "u32"),
    38: ("stb", "u8"),  39: ("stbu", "u8"),
    40: ("lhz", "u16"), 41: ("lhzu", "u16"),
    42: ("lha", "i16"), 43: ("lhau", "i16"),
    44: ("sth", "u16"), 45: ("sthu", "u16"),
}
# X-form 31:xxx with indexed loads/stores — EA = (rA?ra:0) + rB.
XFORM_SUBOPS = {
    23: ("lwzx",  "u32"), 55: ("lwzux", "u32"),
    87: ("lbzx",  "u8"), 119: ("lbzux", "u8"),
   151: ("stwx",  "u32"),183: ("stwux", "u32"),
   215: ("stbx",  "u8"), 247: ("stbux", "u8"),
   279: ("lhzx",  "u16"),311: ("lhzux", "u16"),
   343: ("lhax",  "i16"),375: ("lhaux", "i16"),
   407: ("sthx",  "u16"),439: ("sthux", "u16"),
}

def decode_ea(inst, gpr_vals):
    """Given a 32-bit big-endian PPC instruction word and a callable gpr_vals(n)
       returning the n-th GPR value (or None), return (mnemonic, ea_u32) or
       (None, None) if not a recognized memory op."""
    if inst is None: return (None, None)
    opcd = (inst >> 26) & 0x3F
    if opcd in DFORM_OPCODES:
        ra = (inst >> 16) & 0x1F
        simm = inst & 0xFFFF
        if simm & 0x8000: simm -= 0x10000
        base = gpr_vals(ra) if ra != 0 else 0
        if base is None: return (DFORM_OPCODES[opcd][0], None)
        return (DFORM_OPCODES[opcd][0], (base + simm) & 0xFFFFFFFF)
    if opcd == 31:
        xo = (inst >> 1) & 0x3FF
        if xo in XFORM_SUBOPS:
            ra = (inst >> 16) & 0x1F
            rb = (inst >> 11) & 0x1F
            base = gpr_vals(ra) if ra != 0 else 0
            offs = gpr_vals(rb)
            if base is None or offs is None: return (XFORM_SUBOPS[xo][0], None)
            return (XFORM_SUBOPS[xo][0], (base + offs) & 0xFFFFFFFF)
    return (None, None)


def main():
    s = socket.socket(); s.settimeout(30); s.connect(("127.0.0.1", PORT))
    print(f"qSupported: {cmd(s, 'qSupported')}", file=sys.stderr)
    print(f"watchpoints to install: {len(WATCHES)}", file=sys.stderr)
    sys.stderr.flush()

    fail = 0
    for kind, addr, label in WATCHES:
        r = cmd(s, f"Z{kind},{addr:x},4")
        if r != "OK":
            fail += 1
            print(f"  WP-FAIL Z{kind} @0x{addr:08x} ({label}) -> {r}", file=sys.stderr)
    print(f"WP install: {len(WATCHES) - fail} ok / {fail} fail", file=sys.stderr)
    sys.stderr.flush()

    # Address → label map (kind-agnostic; stop-reply gives the address).
    addr2label = {}
    for kind, addr, label in WATCHES:
        # label already has .r or .w suffix; keep the base for the address
        base = label.rsplit(".", 1)[0]
        addr2label.setdefault(addr, base)

    print("=== native GameCube full-MMIO trajectory (watchpoint hits, port=9091) ===")
    print("  fmt: [n] PC=.. LR=.. r1=.. r3=.. r4=.. r5=.. r6=.. r13=.. MSR=.. <reg-label> <stop-tag>")
    sys.stdout.flush()

    hist_label = collections.Counter()
    hist_subsys = collections.Counter()

    exit_reason = None
    last_i = 0
    for i in range(NHITS):
        last_i = i
        send(s, "c")
        try:
            stop = recv(s)
        except socket.timeout:
            exit_reason = f"[timeout after {i} hits — native idle/no more MMIO access]"
            print(exit_reason)
            sys.stdout.flush()
            break
        if stop is None:
            exit_reason = "[connection closed]"
            print(exit_reason)
            sys.stdout.flush()
            break
        pc  = reg(s, 64); lr  = reg(s, 67); msr = reg(s, 65)
        r1  = reg(s, 1);  r3  = reg(s, 3);  r4  = reg(s, 4)
        r5  = reg(s, 5);  r6  = reg(s, 6);  r13 = reg(s, 13)

        # Dolphin's GDBStub.cpp:1158-1167 sends only T05;PC;r1 in stop replies —
        # NO watch:/rwatch:/awatch: tag. Resolve EA by decoding the load/store
        # at PC (lwz/stw/lhz/sth/lbz/stb D-form or X-form indexed variants).
        wp_addr = None
        mnem = None
        if pc is not None:
            inst_bytes = memread(s, pc, 4)
            if inst_bytes and len(inst_bytes) == 4:
                inst = int.from_bytes(inst_bytes, "big")
                # cache for ra/rb registers we may need
                local_cache = {1: r1, 3: r3, 4: r4, 5: r5, 6: r6, 13: r13}
                def gprv(n):
                    if n in local_cache: return local_cache[n]
                    v = reg(s, n); local_cache[n] = v; return v
                mnem, ea = decode_ea(inst, gprv)
                if ea is not None:
                    wp_addr = ea & 0xffffffff
        # Fallback: scan known regs for a known cell match.
        if wp_addr is None or wp_addr not in addr2label:
            for cand in (r3, r4, r5, r6, r13, r1):
                if cand is None: continue
                a = cand & 0xffffffff
                if 0xCC000000 <= a <= 0xCC008010 and a in addr2label:
                    wp_addr = a; break
        label = addr2label.get(wp_addr & 0xffffffff if wp_addr is not None else -1,
                               f"@0x{(wp_addr or 0) & 0xffffffff:08x}")
        wp_tag = mnem or ""
        # Histogram tallies (kind not available from stop reply — see comment above).
        hist_label[label] += 1
        # Subsystem = first underscore-prefix (PI, SI, DI, AI, EXI, MI, VI, PE, CP, DSP, GP).
        ss = label.split("_", 1)[0] if "_" in label else label
        hist_subsys[ss] += 1

        print(f"  [{i:5d}] PC=0x{h(pc)} LR=0x{h(lr)} r1=0x{h(r1)} r3=0x{h(r3)} r4=0x{h(r4)} "
              f"r5=0x{h(r5)} r6=0x{h(r6)} r13=0x{h(r13)} MSR=0x{h(msr)} "
              f"{label} {wp_tag}@0x{(wp_addr or 0) & 0xffffffff:08x}")
        if (i + 1) % 200 == 0:
            sys.stdout.flush()
    else:
        exit_reason = f"[NHITS={NHITS} reached — natural exit]"
        print(exit_reason)
        sys.stdout.flush()

    # Per-cell and per-subsystem histograms.
    print()
    print("=== per-cell hit histogram (top 60) ===")
    for lbl, n in hist_label.most_common(60):
        print(f"  {n:6d}  {lbl}")
    print()
    print("=== per-subsystem hit histogram ===")
    for ss, n in hist_subsys.most_common():
        print(f"  {n:6d}  {ss}")
    print()
    print(f"=== EXIT: {exit_reason} ===")
    sys.stdout.flush()

    # Remove all watchpoints (best-effort — socket may be stuck after timeout).
    try:
        s.settimeout(2)
        for kind, addr, _ in WATCHES:
            try:
                cmd(s, f"z{kind},{addr:x},4")
            except Exception:
                break
    except Exception:
        pass
    try: s.close()
    except Exception: pass
    print(f"[python-exit] last_i={last_i} reason={exit_reason}", file=sys.stderr)
    sys.stderr.flush()

if __name__ == "__main__":
    main()
