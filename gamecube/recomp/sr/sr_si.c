// sr_si.c — THE SERIAL INTERFACE with one standard GameCube controller on port 0, transcribed from
// Dolphin, and a deterministic input schedule so a node run can press Start / A.
//
// [2026-09-29] SOURCES (gamecube/dolphin-src/Source/Core/Core/HW/):
//   SI/SI.cpp:65-69        GetRDSTBit           SI/SI.cpp:99-131  UpdateInterrupts / GenerateSIInterrupt
//   SI/SI.cpp:137-140      ConvertSILengthField SI/SI.cpp:147-215 RunSIBuffer
//   SI/SI.cpp:349-505      the register file (buffer, channels, SIPOLL, SICOMCSR, SISR, EXILK)
//   SI/SI.cpp UpdateDevices   the poll: GetData per channel -> RDST / NOREP+ERRSTAT
//   SI/SI.h                USIPoll / USIComCSR / USIStatusReg / USIChannelIn_Hi bit layouts
//   SI/SI_DeviceGCController.cpp  RunBuffer (STATUS/RESET, DIRECT, ORIGIN, RECALIBRATE), GetData
//                          (modes 0-7), MapPadStatus, SendCommand (CMD_WRITE -> mode), origin centred
//   SI/SI_DeviceNull.cpp   ports 1-3: RunBuffer -1, GetData ErrorNoResponse
//   SI/SI_Device.h         SI_GC_CONTROLLER = 0x09000000;  InputCommon/GCPadStatus.h  button bits
//   VideoInterface.cpp:955-1030  the poll schedule: at a field boundary the next poll is 15
//                          half-lines later (NUM_HALF_LINES_FOR_SI_POLL), then every 2*X half-lines
// The ONE thing this adds that Dolphin does not have: where the pad state comes from.  Dolphin
// asks the host's controller; here a table of (first VI field, last VI field, buttons) set before
// boot (sr_si_input_add) — keyed on GUEST time, so a run with inputs is as deterministic as one
// without.  Button combos (X+Y+Start origin, B+X+Start reset) are not transcribed: they need a
// 3-second hold of those exact buttons, which no schedule here produces; raised if one does.
#include <stdint.h>
#include <string.h>
#include <emscripten.h>
#include "gekko_rt.h"

extern uint8_t *g_ram;
extern uint32_t g_fault;
void sr_image_pi_set_si(int on);             // sr_image.c: PI INT_CAUSE_SI (0x08)

#define SI_BASE 0xCC006400u
#define SR_F_SI 0xC6D80000u

static uint32_t out_[4], inhi[4], inlo[4], poll_, comcsr, status_, exilk;
static int g_si_on = 0, g_mode = 0;          // GC controller report mode (SendCommand CMD_WRITE)
static uint32_t g_polls = 0, g_xfers = 0;
static uint8_t *reg(uint32_t ea) { return g_ram + GK_HWREG_OFF + (ea - GK_HWREG_LO); }
static uint32_t rd(uint32_t ea) { uint8_t *r = reg(ea); return ((uint32_t)r[0] << 24) | ((uint32_t)r[1] << 16) | ((uint32_t)r[2] << 8) | r[3]; }
static void wr(uint32_t ea, uint32_t v) { uint8_t *r = reg(ea); r[0] = (uint8_t)(v >> 24); r[1] = (uint8_t)(v >> 16); r[2] = (uint8_t)(v >> 8); r[3] = (uint8_t)v; }
static void publish(void) {
    for (int i = 0; i < 4; i++) { wr(SI_BASE + 0xC * i, out_[i]); wr(SI_BASE + 0xC * i + 4, inhi[i]); wr(SI_BASE + 0xC * i + 8, inlo[i]); }
    wr(SI_BASE + 0x30, poll_); wr(SI_BASE + 0x34, comcsr); wr(SI_BASE + 0x38, status_); wr(SI_BASE + 0x3C, exilk);
}
static void update_irq(void) {                                  // SI.cpp:99-117
    if (status_ & (0x20000000u | 0x00200000u | 0x00002000u | 0x00000020u)) comcsr |= 1u << 28;
    else comcsr &= ~(1u << 28);
    int irq = (((comcsr >> 28) & (comcsr >> 27) & 1u)) || (((comcsr >> 31) & (comcsr >> 30) & 1u));
    sr_image_pi_set_si(irq);
}
static uint32_t rdst_bit(int ch) { return 0x20000000u >> (ch * 8); }
static void no_response(int ch) { status_ |= 0x08000000u >> (ch * 8); }   // NOREPn

// ---- the input schedule
#define SI_SCHED 64
static struct { uint32_t from, to, buttons; } g_sched[SI_SCHED];
static uint32_t g_nsched = 0;
EMSCRIPTEN_KEEPALIVE int sr_si_input_add(uint32_t from_field, uint32_t to_field, uint32_t buttons) {
    if (g_nsched >= SI_SCHED) return 0;
    g_sched[g_nsched].from = from_field; g_sched[g_nsched].to = to_field; g_sched[g_nsched].buttons = buttons & 0xFFFFu;
    g_nsched++; return 1;
}
static uint32_t g_field = 0;                 // VI fields so far (sr_image.c passes it in)
static uint32_t pad_buttons(void) {
    uint32_t b = 0;
    for (uint32_t i = 0; i < g_nsched; i++) if (g_field >= g_sched[i].from && g_field <= g_sched[i].to) b |= g_sched[i].buttons;
    if ((b & 0xFF00u) == (0x0800u | 0x0400u | 0x1000u) || (b & 0xFF00u) == (0x0200u | 0x0400u | 0x1000u)) {
        if (!g_fault) g_fault = SR_F_SI | 0x0C0Cu;            // a button combo: not transcribed
    }
    return b;
}
// GCPadStatus of the pad now: sticks centred (0x80), triggers/analog 0 (Pad::GetStatus neutral)
static void gc_getdata(uint32_t *hi, uint32_t *lo) {            // SI_DeviceGCController.cpp GetData
    const uint32_t sx = 0x80, sy = 0x80, cx = 0x80, cy = 0x80, tl = 0, tr = 0, aa = 0, ab = 0;
    *hi = sy | (sx << 8) | ((pad_buttons() | 0x0080u) << 16);    // MapPadStatus: | PAD_USE_ORIGIN
    switch (g_mode) {
    case 1: *lo = (ab >> 4) | ((aa >> 4) << 4) | (tr << 8) | (tl << 16) | ((cy >> 4) << 24) | ((cx >> 4) << 28); break;
    case 2: *lo = ab | (aa << 8) | ((tr >> 4) << 16) | ((tl >> 4) << 20) | ((cy >> 4) << 24) | ((cx >> 4) << 28); break;
    case 3: *lo = tr | (tl << 8) | (cy << 16) | (cx << 24); break;
    case 4: *lo = ab | (aa << 8) | (cy << 16) | (cx << 24); break;
    default: *lo = (ab >> 4) | ((aa >> 4) << 4) | ((tr >> 4) << 8) | ((tl >> 4) << 12) | (cy << 16) | (cx << 24); break;
    }
}
static int gc_runbuffer(uint8_t *buf) {                         // SI_DeviceGCController.cpp RunBuffer
    switch (buf[0]) {
    case 0x00: case 0xFF: buf[0] = 0x09; buf[1] = 0x00; buf[2] = 0x00; return 3;   // SI_GC_CONTROLLER
    case 0x40: {
        uint32_t hi, lo; gc_getdata(&hi, &lo);
        for (int i = 0; i < 4; i++) { buf[i] = (uint8_t)(hi >> (24 - 8 * i)); buf[i + 4] = (uint8_t)(lo >> (24 - 8 * i)); }
        return 8;
    }
    case 0x41: case 0x42: {                                     // SOrigin: button(0) sticks 0x80 x4, 0...
        const uint8_t o[10] = {0, 0, 0x80, 0x80, 0x80, 0x80, 0, 0, 0, 0};
        memcpy(buf, o, 10); return 10;
    }
    case 0x1d: return 0;                                        // CMD_SET_GAME_ID
    default: if (!g_fault) g_fault = SR_F_SI | buf[0]; return 0;   // PanicAlert in Dolphin
    }
}
static void run_si_buffer(void) {                               // SI.cpp:147-215
    if (!(comcsr & 1u)) return;
    const uint32_t ch = (comcsr >> 1) & 3u;
    const uint32_t rq = (((comcsr >> 16) & 0x7Fu) - 1u & 0x7Fu) + 1u;
    (void)rq;
    uint8_t *buf = reg(SI_BASE + 0x80);
    int n = ch == 0 ? gc_runbuffer(buf) : -1;                   // ports 1-3: CSIDevice_Null
    g_xfers++;
    if (n != 0) {
        comcsr &= ~1u;
        if (n < 0) { comcsr |= 1u << 29; no_response((int)ch); } else comcsr &= ~(1u << 29);
        comcsr |= 1u << 31;                                     // GenerateSIInterrupt(INT_TCINT)
        update_irq();
    } else {
        // TransferInterval() is 0 for these devices: Dolphin reschedules at +0; a 0-length reply
        // is only CMD_SET_GAME_ID, which then never completes there either — raised, not guessed.
        if (!g_fault) g_fault = SR_F_SI | 0x1D00u;
    }
}
static void update_devices(void) {                              // SI.cpp UpdateDevices
    for (int i = 0; i < 4; i++) {
        uint32_t errlatch = (inhi[i] >> 30) & 1u;
        if (i == 0) {
            uint32_t hi, lo; gc_getdata(&hi, &lo);
            inhi[i] = hi; inlo[i] = lo;                         // GetData(in_hi.hex, in_lo.hex)
            status_ |= rdst_bit(i);
        } else {
            no_response(i);
            errlatch = 1; inhi[i] |= 0x80000000u;               // ERRSTAT
        }
        inhi[i] = (inhi[i] & ~0x40000000u) | (errlatch << 30);
    }
    g_polls++;
    update_irq();
    publish();
}

// ---- hooks from sr_image.c
void sr_si_read(uint32_t ea, uint32_t n) {
    if (!g_si_on || ea < SI_BASE || ea >= SI_BASE + 0x100u) return;
    (void)n;
    uint32_t o = ea - SI_BASE;
    if (o < 0x30 && (o % 0xC) != 0) {                           // IN_HI / IN_LO: clear RDST (:396-410)
        status_ &= ~rdst_bit((int)(o / 0xC));
        update_irq();
    }
    publish();
}
void sr_si_write(uint32_t ea, uint32_t n) {
    if (!g_si_on || ea < SI_BASE || ea >= SI_BASE + 0x100u) return;
    uint32_t o = ea - SI_BASE;
    if (o >= 0x80) return;                                      // the buffer: the bytes ARE the buffer
    if (n != 4 || (o & 3u)) { if (!g_fault) g_fault = SR_F_SI | 0x4000u | o; return; }
    uint32_t v = rd(ea);
    if (o < 0x30) {
        int i = (int)(o / 0xC), r = (int)(o % 0xC);
        if (r == 0) out_[i] = v; else if (r == 4) inhi[i] = v; else inlo[i] = v;
    } else if (o == 0x30) { poll_ = v;
    } else if (o == 0x34) {                                     // :416-443
        comcsr = (comcsr & ~((3u << 1) | (0x7Fu << 8) | (0x7Fu << 16) | (1u << 27) | (1u << 30))) |
                 (v & ((3u << 1) | (0x7Fu << 8) | (0x7Fu << 16) | (1u << 27) | (1u << 30)));
        if (v & (1u << 28)) comcsr &= ~(1u << 28);
        if (v & (1u << 31)) comcsr &= ~(1u << 31);
        if (v & 1u) { comcsr |= 1u; run_si_buffer(); }
        if (!(comcsr & 1u)) update_irq();
    } else if (o == 0x38) {                                     // :445-500
        const uint32_t w1c = 0x0F0F0F0Fu;                       // UNRUN/OVRUN/COLL/NOREP of each channel
        status_ &= ~(v & w1c);
        if (v & 0x80000000u) {                                  // WR: SendCommand to every channel
            for (int i = 0; i < 4; i++) {
                if (i != 0) continue;                           // Null: nothing
                uint32_t cmd = out_[i];
                if (((cmd >> 16) & 0xFFu) == 0x40) {             // CMD_WRITE
                    if (!((poll_ >> (7 - i)) & 1u)) g_mode = (int)(cmd & 0xFFu);   // poll == EN_i
                } else if (((cmd >> 16) & 0xFFu) != 0x00) {
                    if (!g_fault) g_fault = SR_F_SI | 0x5000u | ((cmd >> 16) & 0xFFu);
                }
            }
            status_ &= ~(0x80000000u | 0x10101010u);            // WR, WRST0..3
        }
    } else if (o == 0x3C) { exilk = v;
    }
    publish();
}
// the poll schedule, driven by sr_image.c's VI half-line (VideoInterface.cpp:995-1019)
static uint32_t g_next_poll = 0xFFFFFFFFu;
void sr_si_half_line(uint32_t half_line_count, uint32_t odd_field_len, uint32_t fields) {
    if (!g_si_on) return;
    g_field = fields;
    const int boundary = half_line_count == 0 || half_line_count == odd_field_len;
    if (half_line_count == g_next_poll) {
        update_devices();
        g_next_poll += 2u * ((poll_ >> 16) & 0x3FFu);
    }
    if (boundary) g_next_poll = half_line_count + 15u;
}
EMSCRIPTEN_KEEPALIVE void sr_si_init(void) {
    memset(out_, 0, sizeof out_); memset(inhi, 0, sizeof inhi); memset(inlo, 0, sizeof inlo);
    poll_ = comcsr = status_ = exilk = 0; g_mode = 0; g_si_on = 1; g_next_poll = 0xFFFFFFFFu;
    publish();
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_si_polls(void) { return g_polls; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_si_xfers(void) { return g_xfers; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_si_mode(void)  { return (uint32_t)g_mode; }
