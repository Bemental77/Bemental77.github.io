// sr_exi.c — THE EXPANSION INTERFACE, transcribed from Dolphin: three channels, the memory card
// in slot A, and the IPL device (SRAM / RTC / ROM) on channel 0 device 1.
//
// [2026-09-29] Replaces, when switched on (sr_image_set_exi_model(2)), the TSTART-only model
// sr_image.c has carried since the first boot.  The reason is the ORACLE: the shipped Dolphin
// path has a memory card in slot A (Config::MAIN_SLOT_A defaults to MemoryCardFolder,
// Core/Config/MainSettings.cpp:133-134, not overridden under DolphinLibretro/), and there SAB goes
// mcwarnD -> otherprintD; with no card it goes mcwarnD -> advertiseD (README §10.8).  To follow
// the path players see, the card has to exist.  sr_image_set_card(0) is the card-absent arm.
//
// SOURCES, all Dolphin (gamecube/dolphin-src/Source/Core/Core/HW/):
//   EXI/EXI_Channel.cpp:40-150     the four registers, CS -> device, TSTART, SendTransferComplete
//   EXI/EXI_Channel.cpp:215-233    IsCausingInterrupt; EXI/EXI.cpp:240-253 UpdateInterrupts
//   EXI/EXI_Channel.h:63-100       UEXI_STATUS / UEXI_CONTROL bit layout
//   EXI/EXI_Device.cpp             default ImmRead/ImmWrite/DMARead/DMAWrite = TransferByte loops
//   EXI/EXI_DeviceMemoryCard.cpp   the card: command set, status, SetCS, TransferByte, DMA timing
//   EXI/EXI_DeviceIPL.cpp:248-400  the IPL device: 4-byte command, ROM / SRAM / UART regions
//   Sram.cpp                        sram_dump (Dolphin's default SRAM), SetCardFlashID, checksums
//   GCMemcard/GCMemcard.cpp         InitializeHeaderData, Header/Directory/BlockAlloc + checksums
//   GCMemcard/GCMemcardDirectory.cpp:179-250  a fresh GCI-folder card: header, dir1=dir2, bat1=bat2
//
// STATED GAPS (raise or report, never guessed):
//   * IPL ROM contents: not present.  Dolphin loads the fonts from files; a ROM read here returns
//     0 and is COUNTED (sr_exi_rom_reads) so a game that draws with the IPL font is visible.
//   * Time: Dolphin's RTC and the card's format time come from the HOST clock at boot.  Here both
//     are a FIXED origin (SR_EXI_BOOT_TIME below) plus guest time, so every run is identical.
//   * No card writes persist past the process (the image is in host memory only).
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <emscripten.h>
#include "gekko_rt.h"

extern uint8_t  *g_ram;
extern uint32_t  g_ram_size;
extern uint32_t  g_fault;
void sr_image_pi_set_exi(int on);            // sr_image.c: PI INT_CAUSE_EXI (0x10)
void sr_image_ev_rearm(void);                // sr_image.c
void sr_image_ov_dma(uint32_t pa, uint32_t len);   // sr_image.c: overlay guard invalidation

#define EXI_BASE 0xCC006800u
#define SR_F_EXI 0xC6D00000u                 // an EXI access this model does not cover

// seconds 2000-01-01 -> the fixed boot instant used for RTC and format time
#define SR_EXI_BOOT_TIME 0x2E7DD980ull       // a fixed instant in 2024 (seconds since 2000), for determinism

// ---------------------------------------------------------------- the SRAM (Sram.h layout)
static uint8_t g_sram[0x44];                 // rtc(4) settings(0x14) settings_ex(0x2c)
static void sram_init(void) {                // Sram.cpp:9-24 sram_dump, then FixSRAMChecksums
    memset(g_sram, 0, sizeof g_sram);
    g_sram[4] = 0x00; g_sram[5] = 0x2c; g_sram[6] = 0xff; g_sram[7] = 0xd0;
    g_sram[4 + 0x13] = 0x20 | 0x08 | 0x04;   // flags: 0x20 | kOobeDone | kStereo
    const char *a = "DOLPHINSLOTA", *b = "DOLPHINSLOTB";
    memcpy(g_sram + 0x18, a, 12); memcpy(g_sram + 0x18 + 12, b, 12);
    g_sram[0x18 + 0x26] = 0x6E; g_sram[0x18 + 0x27] = 0x6D;   // flash_id_checksum
    uint16_t cs = 0, ci = 0;                 // FixSRAMChecksums: [rtc_bias, settings_ex) as BE u16
    for (uint32_t o = 4 + 0x0C; o < 0x18; o += 2) {
        uint16_t v = (uint16_t)((g_sram[o] << 8) | g_sram[o + 1]);
        cs += v; ci += (uint16_t)~v;
    }
    g_sram[4] = (uint8_t)(cs >> 8); g_sram[5] = (uint8_t)cs;
    g_sram[6] = (uint8_t)(ci >> 8); g_sram[7] = (uint8_t)ci;
}

// ---------------------------------------------------------------- the card image
#define MC_BLOCK   0x2000u
#define MC_MBIT    0x80u                     // MBIT_SIZE_MEMORY_CARD_2043 (GCMemcard.h:117)
#define MC_SIZE    (MC_MBIT * 131072u)       // SIZE_TO_Mb = 1024*8*16 (EXI_DeviceMemoryCard.cpp:46)
static uint8_t *g_card = 0;
static void be16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void mc_checksums(const uint8_t *d, uint32_t size, uint8_t *out) {   // GCMemcard.cpp:326-350
    uint16_t c = 0, i = 0;
    for (uint32_t k = 0; k < size; k += 2) { uint16_t v = (uint16_t)((d[k] << 8) | d[k + 1]); c += v; i += (uint16_t)(v ^ 0xFFFF); }
    if (c == 0xFFFF) c = 0;
    if (i == 0xFFFF) i = 0;
    be16(out, c); be16(out + 2, i);
}
static void card_init(void) {
    if (!g_card) g_card = (uint8_t *)malloc(MC_SIZE);
    memset(g_card, 0xFF, MC_SIZE);           // GCMemcardDirectory::Read: unmapped blocks read 0xFF
    // --- block 0: Header(header_data) — InitializeHeaderData (GCMemcard.cpp:1198-1223)
    uint8_t *h = g_card;
    uint64_t t = SR_EXI_BOOT_TIME + 0;       // format_time: Dolphin passes SECONDS since GC_EPOCH (+channel), EXI.cpp:131-139
    uint64_t rnd = t;
    for (int i = 0; i < 12; i++) {
        rnd = ((rnd * 0x41c64e6dull) + 0x3039ull) >> 16;
        h[i] = (uint8_t)(g_sram[0x18 + i] + (uint32_t)rnd);
        rnd = ((rnd * 0x41c64e6dull) + 0x3039ull) >> 16;
        rnd &= 0x7fffull;
    }
    for (int i = 0; i < 8; i++) h[0x0c + i] = (uint8_t)(t >> (56 - 8 * i));
    memcpy(h + 0x14, g_sram + 4 + 0x0C, 4);  // m_sram_bias = settings.rtc_bias (raw)
    h[0x18] = h[0x19] = h[0x1a] = 0; h[0x1b] = g_sram[4 + 0x12];   // m_sram_language (BE u32)
    memset(h + 0x1c, 0, 4);                  // m_dtv_status = 0
    be16(h + 0x20, 0);                       // m_device_id = 0
    be16(h + 0x22, MC_MBIT);                 // m_size_mb
    be16(h + 0x24, 0);                       // m_encoding: ANSI (NTSC-U)
    mc_checksums(h, 0x1FC, h + 0x1FC);       // Header::CalculateChecksums: [m_data, m_checksum)
    // --- blocks 1, 2: Directory() then FixChecksums, dir2 = dir1 (GCMemcardDirectory.cpp:248-249)
    uint8_t *d = g_card + MC_BLOCK;
    be16(d + 0x1FFA, 0);                     // m_update_counter = 0 (rest 0xFF)
    mc_checksums(d, 0x1FFC, d + 0x1FFC);
    memcpy(g_card + 2 * MC_BLOCK, d, MC_BLOCK);
    // --- blocks 3, 4: BlockAlloc(size) (GCMemcard.cpp:549-555), bat2 = bat1
    uint8_t *b = g_card + 3 * MC_BLOCK;
    memset(b, 0, MC_BLOCK);
    be16(b + 6, (uint16_t)(MC_MBIT * 16u - 5u));  // m_free_blocks = MbitToFreeBlocks
    be16(b + 8, 4);                               // m_last_allocated_block
    mc_checksums(b + 4, MC_BLOCK - 4, b);         // area [m_update_counter, end)
    memcpy(g_card + 4 * MC_BLOCK, b, MC_BLOCK);
    // SetCardFlashID (Sram.cpp:40-65): the IPL learns the card's flash id from its header
    uint64_t r2 = ((uint64_t)h[12] << 56) | ((uint64_t)h[13] << 48) | ((uint64_t)h[14] << 40) | ((uint64_t)h[15] << 32) |
                  ((uint64_t)h[16] << 24) | ((uint64_t)h[17] << 16) | ((uint64_t)h[18] << 8) | h[19];
    uint8_t csum = 0;
    for (int i = 0; i < 12; i++) {
        r2 = ((r2 * 0x41c64e6dull) + 0x3039ull) >> 16;
        csum += g_sram[0x18 + i] = (uint8_t)(h[i] - (uint8_t)(r2 & 0xff));
        r2 = ((r2 * 0x41c64e6dull) + 0x3039ull) >> 16;
        r2 &= 0x7fffull;
    }
    g_sram[0x18 + 0x26] = (uint8_t)(csum ^ 0xFF);
}

// ---------------------------------------------------------------- the memory card device
#define MC_BUSY 0x80
#define MC_UNLOCKED 0x40
#define MC_ERASEERR 0x10
#define MC_PROGERR 0x08
#define MC_READY 0x01
static struct {
    int present, interrupt_switch, interrupt_set;
    uint32_t command, status, position, address;
    uint8_t prog[128];
} mc;
static uint64_t g_mc_done_at = UINT64_MAX, g_mc_tc_at = UINT64_MAX;
static uint32_t g_mc_cmds = 0, g_mc_bytes_rd = 0, g_mc_bytes_wr = 0;
static void exi_update(void);
static void mc_reset(void) {
    memset(&mc, 0, sizeof mc);
    mc.command = 0; mc.status = MC_BUSY | MC_UNLOCKED | MC_READY;   // :118
}
static void mc_cmd_done_later(uint64_t cycles) { g_mc_done_at = g_gk_cycles + cycles; sr_image_ev_rearm(); }
static void mc_setcs(int cs) {                                  // :269-316
    if (cs) { mc.position = 0; return; }
    switch (mc.command) {
    case 0xF1:                                                  // SectorErase
        if (mc.position > 2) {
            uint32_t a = (mc.address & (MC_SIZE - 1)) & ~(MC_BLOCK - 1);
            memset(g_card + a, 0xFF, MC_BLOCK);
            mc.status |= MC_BUSY; mc.status &= ~MC_READY;
            mc_cmd_done_later(5000);
        }
        break;
    case 0xF4:                                                  // ChipErase
        if (mc.position > 2) { memset(g_card, 0xFF, MC_SIZE); mc.status &= ~MC_BUSY; }
        break;
    case 0xF2:                                                  // PageProgram
        if (mc.position >= 5) {
            int count = (int)mc.position - 5, i = 0;
            mc.status &= ~MC_BUSY;
            while (count--) {
                g_card[mc.address & (MC_SIZE - 1)] = mc.prog[i++]; g_mc_bytes_wr++;
                i &= 127;
                mc.address = (mc.address & ~0x1FFu) | ((mc.address + 1) & 0x1FFu);
            }
            mc_cmd_done_later(5000);
        }
        break;
    default: break;
    }
}
static void mc_byte(uint8_t *byte) {                            // :325-470 TransferByte
    if (mc.position == 0) {
        mc.command = *byte; *byte = 0xFF; g_mc_cmds++;
        if (mc.command == 0x89) {                               // ClearStatus
            mc.status &= ~(MC_PROGERR | MC_ERASEERR);
            mc.status |= MC_READY;
            mc.interrupt_set = 0;
            *byte = 0xFF; mc.position = 0;
        }
    } else {
        switch (mc.command) {
        case 0x00:                                              // NintendoID
            *byte = mc.position == 1 ? 0x80 : (uint8_t)(MC_MBIT >> (24 - (((mc.position - 2) & 3) * 8)));
            break;
        case 0x52:                                              // ReadArray
            switch (mc.position) {
            case 1: mc.address = (uint32_t)*byte << 17; *byte = 0xFF; break;
            case 2: mc.address |= (uint32_t)*byte << 9; break;
            case 3: mc.address |= (uint32_t)(*byte & 3) << 7; break;
            case 4: mc.address |= (*byte & 0x7F); break;
            }
            if (mc.position > 1) {
                *byte = g_card[mc.address & (MC_SIZE - 1)];
                if (mc.position >= 9) mc.address = (mc.address & ~0x1FFu) | ((mc.address + 1) & 0x1FFu);
            }
            break;
        case 0x83: *byte = (uint8_t)mc.status; break;           // ReadStatus
        case 0x85:                                              // ReadID: m_card_id = 0xc221
            *byte = mc.position == 1 ? 0xC2 : (uint8_t)((mc.position & 1) ? 0x21 : 0xC2);
            break;
        case 0xF1:                                              // SectorErase
            if (mc.position == 1) mc.address = (uint32_t)*byte << 17;
            else if (mc.position == 2) mc.address |= (uint32_t)*byte << 9;
            *byte = 0xFF;
            break;
        case 0x81:                                              // SetInterrupt
            if (mc.position == 1) mc.interrupt_switch = *byte;
            *byte = 0xFF;
            break;
        case 0xF4: *byte = 0xFF; break;                         // ChipErase
        case 0xF2:                                              // PageProgram
            switch (mc.position) {
            case 1: mc.address = (uint32_t)*byte << 17; break;
            case 2: mc.address |= (uint32_t)*byte << 9; break;
            case 3: mc.address |= (uint32_t)(*byte & 3) << 7; break;
            case 4: mc.address |= (*byte & 0x7F); break;
            }
            if (mc.position >= 5) mc.prog[(mc.position - 5) & 0x7F] = *byte;
            *byte = 0xFF;
            break;
        default: *byte = 0xFF; break;                           // unknown: WARN_LOG in Dolphin
        }
    }
    mc.position++;
}

// ---------------------------------------------------------------- the IPL device (ch0 dev1)
static struct { uint32_t cmd, nrecv, cursor; } ipl;
static uint32_t g_rom_reads = 0;
static void ipl_setcs(int cs) { if (cs) { ipl.nrecv = 0; ipl.cursor = 0; } }   // :248-255
static void ipl_rtc_update(void) {                              // :257-261 UpdateRTC
    uint32_t rtc = (uint32_t)(SR_EXI_BOOT_TIME + g_gk_cycles / 486000000ull);
    g_sram[0] = (uint8_t)(rtc >> 24); g_sram[1] = (uint8_t)(rtc >> 16); g_sram[2] = (uint8_t)(rtc >> 8); g_sram[3] = (uint8_t)rtc;
}
static void ipl_byte(uint8_t *data) {                           // :268-400
    if (ipl.nrecv < 4) {
        ipl.cmd = (ipl.cmd << 8) | *data; *data = 0xFF; ipl.nrecv++;
        if (ipl.nrecv == 4) ipl_rtc_update();
        return;
    }
    const uint32_t addr = (ipl.cmd >> 6) & 0x1FFFFFFu, wr = ipl.cmd >> 31;
    if (addr < 0x200000u) {                                     // ROM
        if (!wr) { *data = 0; g_rom_reads++; ipl.cursor++; }
    } else if (addr >= 0x800000u && addr < 0x800044u) {         // SRAM (+RTC at 0)
        uint32_t a = (addr - 0x800000u + ipl.cursor++) % 0x44u;
        if (wr) g_sram[a] = *data; else *data = g_sram[a];
    } else if (addr >= 0x800400u && addr < 0x800400u + 0x50u) { // UART: reads 0 (:310-314)
        if (!wr) *data = 0;
    } else {
        if (!g_fault) g_fault = SR_F_EXI | 0x1000u | ((addr >> 12) & 0xFFFu);
    }
}

// ---------------------------------------------------------------- the channels
typedef struct { uint32_t status, mar, len, cr, data; } Ch;
static Ch ch[3];
static int g_exi_on = 0;
static uint32_t g_exi_tstarts = 0;
// device index: 0 = CS1, 1 = CS2, 2 = CS4.  Present devices: ch0.dev0 card (arm), ch0.dev1 IPL.
static int dev_present(int c, int d) { return (c == 0 && d == 0) ? mc.present : (c == 0 && d == 1); }
static int cs_dev(uint32_t cs) { return cs == 1 ? 0 : cs == 2 ? 1 : cs == 4 ? 2 : -1; }
static void dev_setcs(int c, int d, int cs) {
    if (c == 0 && d == 0 && mc.present) mc_setcs(cs);
    else if (c == 0 && d == 1) ipl_setcs(cs);
}
static void dev_byte(int c, int d, uint8_t *b) {
    if (c == 0 && d == 0 && mc.present) mc_byte(b);
    else if (c == 0 && d == 1) ipl_byte(b);
    else *b = 0;                                                // no device: IEXIDevice base returns 0/nothing
}
static int dev_irq(int c, int d) { return (c == 0 && d == 0 && mc.present) ? (mc.interrupt_switch ? mc.interrupt_set : 0) : 0; }
static int causing(int c) {                                     // EXI_Channel.cpp:215-233
    Ch *x = &ch[c];
    int d = cs_dev((x->status >> 7) & 7);
    if (c != 2 && dev_irq(c, 0)) x->status |= 2u;
    else if (d >= 0 && dev_irq(c, d)) x->status |= 2u;
    return ((x->status >> 1) & x->status & 1u) || ((x->status >> 3) & (x->status >> 2) & 1u) ||
           ((x->status >> 11) & (x->status >> 10) & 1u);
}
static void exi_update(void) {                                  // EXI.cpp:240-253
    if (dev_irq(0, 2)) ch[2].status |= 2u; else ch[2].status &= ~2u;
    int any = 0;
    for (int c = 0; c < 3; c++) any |= causing(c);
    sr_image_pi_set_exi(any);
}
static uint8_t *reg(uint32_t ea) { return g_ram + GK_HWREG_OFF + (ea - GK_HWREG_LO); }
static uint32_t rd(uint32_t ea) { uint8_t *r = reg(ea); return ((uint32_t)r[0] << 24) | ((uint32_t)r[1] << 16) | ((uint32_t)r[2] << 8) | r[3]; }
static void wr(uint32_t ea, uint32_t v) { uint8_t *r = reg(ea); r[0] = (uint8_t)(v >> 24); r[1] = (uint8_t)(v >> 16); r[2] = (uint8_t)(v >> 8); r[3] = (uint8_t)v; }
static void publish(int c) {
    uint32_t b = EXI_BASE + 0x14u * (uint32_t)c;
    Ch *x = &ch[c];
    if (c == 2) x->status &= ~(1u << 12);                       // EXT: ch2 always 0
    else x->status = (x->status & ~(1u << 12)) | ((uint32_t)dev_present(c, 0) << 12);
    wr(b, x->status); wr(b + 4, x->mar); wr(b + 8, x->len); wr(b + 12, x->cr); wr(b + 16, x->data);
}
static void tc(int c) { ch[c].status |= 8u; exi_update(); publish(c); }   // SendTransferComplete

int sr_exi_active(void) { return g_exi_on; }
void sr_exi_read(uint32_t ea, uint32_t n) {
    if (!g_exi_on || ea < EXI_BASE || ea >= EXI_BASE + 0x3Cu) return;
    (void)n;
    for (int c = 0; c < 3; c++) publish(c);                     // EXT is recomputed on read (:43-54)
}
void sr_exi_write(uint32_t ea, uint32_t n) {
    if (!g_exi_on || ea < EXI_BASE || ea >= EXI_BASE + 0x3Cu) return;
    if (n != 4 || (ea & 3u)) { if (!g_fault) g_fault = SR_F_EXI | (ea & 0xFFFFu); return; }
    const int c = (int)((ea - EXI_BASE) / 0x14u);
    const uint32_t o = (ea - EXI_BASE) % 0x14u, v = rd(ea);
    Ch *x = &ch[c];
    if (o == 0x00) {                                            // :56-85
        x->status = (x->status & ~1u) | (v & 1u);               // EXIINTMASK
        if (v & 2u) x->status &= ~2u;                           // EXIINT w1c
        x->status = (x->status & ~4u) | (v & 4u);               // TCINTMASK
        if (v & 8u) x->status &= ~8u;                           // TCINT w1c
        x->status = (x->status & ~0x70u) | (v & 0x70u);         // CLK
        if (c == 0 || c == 1) {
            x->status = (x->status & ~0x400u) | (v & 0x400u);   // EXTINTMASK
            if (v & 0x800u) x->status &= ~0x800u;               // EXTINT w1c
        }
        if (c == 0) x->status = (x->status & ~0x2000u) | (v & 0x2000u);   // ROMDIS
        uint32_t oldcs = (x->status >> 7) & 7u, newcs = (v >> 7) & 7u;
        int d = cs_dev(oldcs ^ newcs);
        x->status = (x->status & ~0x380u) | (newcs << 7);
        if (d >= 0) dev_setcs(c, d, (int)newcs);                // SetCS(m_status.CHIP_SELECT)
        exi_update();
    } else if (o == 0x04) { x->mar = v;
    } else if (o == 0x08) { x->len = v;
    } else if (o == 0x10) { x->data = v;
    } else if (o == 0x0C) {                                     // :90-142
        x->cr = v;
        if (x->cr & 1u) {
            g_exi_tstarts++;
            int d = cs_dev((x->status >> 7) & 7u);
            if (d >= 0) {
                const uint32_t rw = (x->cr >> 2) & 3u, tlen = ((x->cr >> 4) & 3u) + 1u;
                int delayed = (c == 0 && d == 0 && mc.present);  // UseDelayedTransferCompletion
                if (!(x->cr & 2u)) {                            // immediate
                    if (rw == 0) {                              // ImmRead
                        uint32_t r = 0;
                        for (uint32_t i = 0; i < tlen; i++) { uint8_t b = 0; dev_byte(c, d, &b); r |= (uint32_t)b << (24 - 8 * i); }
                        x->data = r;
                    } else if (rw == 1) {                       // ImmWrite
                        uint32_t dd = x->data;
                        for (uint32_t i = 0; i < tlen; i++) { uint8_t b = (uint8_t)(dd >> 24); dev_byte(c, d, &b); dd <<= 8; }
                    } else if (rw == 2) {                       // ImmReadWrite: base does nothing
                    } else { if (!g_fault) g_fault = SR_F_EXI | 0x0C00u | rw; }
                } else {                                        // DMA
                    uint32_t a = x->mar & 0x01FFFFFFu, len = x->len;
                    if (a + len > g_ram_size) { if (!g_fault) g_fault = SR_F_EXI | 0x0D00u; }
                    else if (rw == 0) {                         // DMARead: device -> RAM
                        if (c == 0 && d == 0 && mc.present) {   // CEXIMemoryCard::DMARead :527-541
                            for (uint32_t i = 0; i < len; i++) g_ram[a + i] = g_card[(mc.address + i) & (MC_SIZE - 1)];
                            g_mc_bytes_rd += len;
                            sr_image_ov_dma(a, len);
                            g_mc_tc_at = g_gk_cycles + (uint64_t)len * (486000000ull / (512u * 1024u));
                            sr_image_ev_rearm();
                        } else {
                            for (uint32_t i = 0; i < len; i++) { uint8_t b = 0; dev_byte(c, d, &b); g_ram[a + i] = b; }
                        }
                    } else if (rw == 1) {                       // DMAWrite: RAM -> device
                        if (c == 0 && d == 0 && mc.present) {   // :543-556
                            for (uint32_t i = 0; i < len; i++) g_card[(mc.address + i) & (MC_SIZE - 1)] = g_ram[a + i];
                            g_mc_bytes_wr += len;
                            g_mc_tc_at = g_gk_cycles + (uint64_t)len * (486000000ull / 98432u);  // 96.125 KB/s
                            sr_image_ev_rearm();
                        } else {
                            for (uint32_t i = 0; i < len; i++) { uint8_t b = g_ram[a + i]; dev_byte(c, d, &b); }
                        }
                    } else { if (!g_fault) g_fault = SR_F_EXI | 0x0E00u | rw; }
                }
                x->cr &= ~1u;                                   // TSTART = 0
                if (!delayed) { x->status |= 8u; exi_update(); }
            } else {
                // no device selected: Dolphin returns without clearing TSTART (:98-99)
            }
        }
    }
    publish(c);
}
// events: the card's CmdDone (:252-258) and TransferComplete (:260-265)
uint64_t sr_exi_next_event(void) { return g_mc_done_at < g_mc_tc_at ? g_mc_done_at : g_mc_tc_at; }
void sr_exi_event(uint64_t now) {
    if (g_mc_done_at <= now) {
        g_mc_done_at = UINT64_MAX;
        mc.status |= MC_READY; mc.status &= ~MC_BUSY;
        mc.interrupt_set = 1; exi_update(); publish(0);
    }
    if (g_mc_tc_at <= now) { g_mc_tc_at = UINT64_MAX; tc(0); }
}
// power-on state (EXI_Channel.cpp:30-38): EXTINT set on channels 0/1, ch1 CS=1
EMSCRIPTEN_KEEPALIVE void sr_exi_init(int card_present) {
    memset(ch, 0, sizeof ch);
    ch[0].status = 0x800u; ch[1].status = 0x800u | (1u << 7);
    sram_init();
    mc_reset();
    mc.present = card_present;
    if (card_present) card_init();
    g_exi_on = 1;
    for (int c = 0; c < 3; c++) publish(c);
}
EMSCRIPTEN_KEEPALIVE uint32_t sr_exi_card_cmds(void)  { return g_mc_cmds; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_exi_card_rd(void)    { return g_mc_bytes_rd; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_exi_card_wr(void)    { return g_mc_bytes_wr; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_exi_tstarts(void)    { return g_exi_tstarts; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_exi_rom_reads(void)  { return g_rom_reads; }
