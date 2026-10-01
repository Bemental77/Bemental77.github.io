//
// rdram.c: RDRAM memory interface
//

#define RDRAM_MASK 0x00ffffff

// macros used to interface with AL's code
#define RREADADDR8(rdst, in) {(rdst) = rdram_read_idx8((in));}
#define RREADIDX16(rdst, in) {(rdst) = rdram_read_idx16((in));}
#define RREADIDX32(rdst, in) {(rdst) = rdram_read_idx32((in));}

#define RWRITEADDR8(in, val) rdram_write_idx8((in), (val))
#define RWRITEIDX16(in, val) rdram_write_idx16((in), (val))
#define RWRITEIDX32(in, val) rdram_write_idx32((in), (val))

#define PAIRREAD16(rdst, hdst, in) rdram_read_pair16(&rdst, &hdst, (in))

#define PAIRWRITE16(in, rval, hval) rdram_write_pair16((in), (rval), (hval))

#define PAIRWRITE32(in, rval, hval0, hval1) rdram_write_pair32((in), (rval), (hval0), (hval1))

#define PAIRWRITE8(in, rval, hval) rdram_write_pair8((in), (rval), (hval))

// pointer indexing limits for aliasing RDRAM reads and writes
static uint32_t idxlim8;
static uint32_t idxlim16;
static uint32_t idxlim32;

static uint32_t* rdram32;
static uint16_t* rdram16;
static uint8_t* rdram8;
static uint8_t rdram_hidden[RDRAM_MAX_SIZE / 2];

// NEIL RAW STATE: which 4 KiB pages of rdram_hidden were written, and when.
// neil_hid_ep[p] = the save epoch during which page p was last written;
// neil_hid_all_ep = an epoch at which EVERY page counts as written (init,
// and every state load, replace the whole plane). One u32 store per pixel
// write; read only by neil_state_save_raw_fast (src/libretro/neil_rawstate.c).
#define NEIL_HID_PAGES ((RDRAM_MAX_SIZE / 2) >> 12)
uint32_t neil_hid_epoch = 1;
uint32_t neil_hid_all_ep = 1;
uint32_t neil_hid_ep[NEIL_HID_PAGES];
#define NEIL_HID_MARK(i) (neil_hid_ep[(i) >> 12] = neil_hid_epoch)

static void rdram_init(void)
{
    idxlim8 = config.gfx.rdram_size - 1;
    idxlim16 = (idxlim8 >> 1) & 0xffffffu;
    idxlim32 = (idxlim8 >> 2) & 0xffffffu;

    rdram32 = (uint32_t*)config.gfx.rdram;
    rdram16 = (uint16_t*)config.gfx.rdram;
    rdram8 = config.gfx.rdram;

    memset(rdram_hidden, 3, sizeof(rdram_hidden));
    neil_hid_all_ep = neil_hid_epoch;
}

static STRICTINLINE bool rdram_valid_idx8(uint32_t in)
{
    return in <= idxlim8;
}

static STRICTINLINE bool rdram_valid_idx16(uint32_t in)
{
    return in <= idxlim16;
}

static STRICTINLINE bool rdram_valid_idx32(uint32_t in)
{
    return in <= idxlim32;
}

static STRICTINLINE uint8_t rdram_read_idx8(uint32_t in)
{
    in &= RDRAM_MASK;
    return rdram_valid_idx8(in) ? rdram8[in ^ BYTE_ADDR_XOR] : 0;
}

static STRICTINLINE uint8_t rdram_read_idx8_fast(uint32_t in)
{
    return rdram8[in ^ BYTE_ADDR_XOR];
}

static STRICTINLINE uint16_t rdram_read_idx16(uint32_t in)
{
    in &= RDRAM_MASK >> 1;
    return rdram_valid_idx16(in) ? rdram16[in ^ WORD_ADDR_XOR] : 0;
}

static STRICTINLINE uint16_t rdram_read_idx16_fast(uint32_t in)
{
    return rdram16[in ^ WORD_ADDR_XOR];
}

static STRICTINLINE uint32_t rdram_read_idx32(uint32_t in)
{
    in &= RDRAM_MASK >> 2;
    return rdram_valid_idx32(in) ? rdram32[in] : 0;
}

static STRICTINLINE uint32_t rdram_read_idx32_fast(uint32_t in)
{
    return rdram32[in];
}

static STRICTINLINE void rdram_write_idx8(uint32_t in, uint8_t val)
{
    in &= RDRAM_MASK;
    if (rdram_valid_idx8(in)) {
        rdram8[in ^ BYTE_ADDR_XOR] = val;
    }
}

static STRICTINLINE void rdram_write_idx16(uint32_t in, uint16_t val)
{
    in &= RDRAM_MASK >> 1;
    if (rdram_valid_idx16(in)) {
        rdram16[in ^ WORD_ADDR_XOR] = val;
    }
}

static STRICTINLINE void rdram_write_idx32(uint32_t in, uint32_t val)
{
    in &= RDRAM_MASK >> 2;
    if (rdram_valid_idx32(in)) {
        rdram32[in] = val;
    }
}

static STRICTINLINE void rdram_read_pair16(uint16_t* rdst, uint8_t* hdst, uint32_t in)
{
    in &= RDRAM_MASK >> 1;
    if (rdram_valid_idx16(in)) {
        *rdst = rdram16[in ^ WORD_ADDR_XOR];
        *hdst = rdram_hidden[in];
    } else {
        *rdst = *hdst = 0;
    }
}

static STRICTINLINE void rdram_write_pair8(uint32_t in, uint8_t rval, uint8_t hval)
{
    in &= RDRAM_MASK;
    if (rdram_valid_idx8(in)) {
        rdram8[in ^ BYTE_ADDR_XOR] = rval;
        if (in & 1) {
            rdram_hidden[in >> 1] = hval;
            NEIL_HID_MARK(in >> 1);
        }
    }
}

static STRICTINLINE void rdram_write_pair16(uint32_t in, uint16_t rval, uint8_t hval)
{
    in &= RDRAM_MASK >> 1;
    if (rdram_valid_idx16(in)) {
        rdram16[in ^ WORD_ADDR_XOR] = rval;
        rdram_hidden[in] = hval;
        NEIL_HID_MARK(in);
    }
}

static STRICTINLINE void rdram_write_pair32(uint32_t in, uint32_t rval, uint8_t hval0, uint8_t hval1)
{
    in &= RDRAM_MASK >> 2;
    if (rdram_valid_idx32(in)) {
        rdram32[in] = rval;
        rdram_hidden[in << 1] = hval0;
        rdram_hidden[(in << 1) + 1] = hval1;
        NEIL_HID_MARK(in << 1);
    }
}
