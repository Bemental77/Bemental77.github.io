#!/usr/bin/env python3
# validate_msm_bswap.py — prove gamecube/recomp/shims/src/gc_musyx_bswap.c is correct, against
# the REAL Mario Party 4 sound bank, without booting anything.
#
#   python3 gamecube/recomp/validate_msm_bswap.py [path/to/Mario Party 4 (USA).iso]
#
# WHY THIS EXISTS. A byte-order swapper fails silently. Swap a field twice and it is big-endian
# again; walk one byte past a section and you corrupt the next one. Neither shows up as an
# error — it shows up as a wedge or an out-of-bounds trap thousands of frames later, inside
# MusyX, with nothing pointing back at the swapper. That is exactly what happened twice here:
#
#   1. Bounding every section by the END OF THE BLOB instead of by the next section's start let
#      the project's ID lists and the pool's MEM_DATA chains run past their own section and swap
#      the SAMPLE DIRECTORY a second time. This script reported a double swap at exactly
#      `sdirOfs` in all 126 of MP4's group blobs. The runtime symptom had been a hang.
#   2. Treating the MEM_DATA terminator (`nextOff == 0xFFFFFFFF`) as a node WITH a payload swept
#      the rest of the pool as u32s, clobbering the layer list. Runtime symptom: an out-of-bounds
#      trap inside sndPushGroup, ~344 frames into the boot.
#
# HOW IT PROVES IT. This is a line-by-line MODEL of the C swapper (keep the two in step), run
# over every group blob in the retail disc's /sound/mpgcsnd.msm, with two independent checks:
#
#   * DOUBLE-SWAP DETECTION. Every byte a swap touches is recorded with its width. Touching a
#     byte twice is an error, whatever the widths. This is the check that catches overruns,
#     because an overrun is almost always ALSO a re-swap of a neighbour.
#   * SEMANTIC RE-PARSE. After swapping, the image is read back LITTLE-ENDIAN — the way the
#     recomp will read it — and every sample-directory entry must make sense: compression type
#     in range, sample rate plausible, the ADPCM coefficient block inside the directory, a
#     believable sample count. A swap that is merely self-consistent but wrong fails here.
#     The GROUP_DATA chain must also terminate when walked little-endian.
#
# A clean run reports 126 groups, 0 failures, and every sample-directory entry verified.

import struct, sys, os

ISO = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/Mario Party 4 (USA).iso")
f = open(ISO, "rb")

def find_msm():
    """Locate /sound/mpgcsnd.msm through the disc FST rather than hardcoding its offset."""
    f.seek(0x424); fst_off, fst_sz = struct.unpack(">II", f.read(8))
    f.seek(fst_off); fst = f.read(fst_sz)
    nent = struct.unpack(">I", fst[8:12])[0]
    strtab = 12 * nent
    for i in range(nent):
        no = struct.unpack(">I", b"\0" + fst[i*12+1:i*12+4])[0]
        e = fst.index(b"\0", strtab + no)
        if fst[i*12] == 0 and fst[strtab+no:e].decode("latin1").lower() == "mpgcsnd.msm":
            return struct.unpack(">II", fst[i*12+4:i*12+12])
    raise SystemExit("mpgcsnd.msm not found in the disc FST")

BASE, MSM_SIZE = find_msm()
def rd(o, n): f.seek(BASE + o); return f.read(n)
H=struct.unpack(">24i", rd(0,0x60)); grpInfoOfs,grpInfoSize,grpDataOfs=H[8],H[9],H[14]
gi=rd(grpInfoOfs,grpInfoSize)

class Buf:
    """Mirrors the C swapper, and records every swapped byte range so a double swap is caught."""
    def __init__(s,b): s.b=bytearray(b); s.marks={}   # off -> width
    def _mark(s,o,w):
        for k in range(o,o+w):
            if k in s.marks: raise AssertionError(f"DOUBLE SWAP at byte {k} (widths {s.marks[k]} then {w})")
            s.marks[k]=w
    def sw16(s,o): s._mark(o,2); s.b[o:o+2]=s.b[o:o+2][::-1]
    def sw32(s,o): s._mark(o,4); s.b[o:o+4]=s.b[o:o+4][::-1]
    def rd16(s,o): return struct.unpack_from("<H",s.b,o)[0]
    def rd32(s,o): return struct.unpack_from("<I",s.b,o)[0]
    def raw16(s,o): return struct.unpack_from(">H",s.b,o)[0]

def swap_adpcm_info(B,p,ctype,nsmp):
    B.sw16(p+0); B.sw16(p+4); B.sw16(p+6)
    for i in range(16): B.sw16(p+8+i*2)
    if ctype==1:
        for i in range((nsmp+13)//14): B.sw16(p+0x28+i*6); B.sw16(p+0x28+i*6+2)

def swap_sdir(B,sdir,limit):
    e=sdir; n=0
    while (e-sdir)+0x20<=limit and B.raw16(e)!=0xFFFF:
        for o in (0x00,0x02): B.sw16(e+o)
        for o in (0x04,0x08,0x0C,0x10,0x14,0x18,0x1C): B.sw32(e+o)
        ln=B.rd32(e+0x10); ctype=ln>>24; nsmp=ln&0xFFFFFF; xd=B.rd32(e+0x1C)
        if ctype in (0,1,4,5) and xd and xd<limit: swap_adpcm_info(B,sdir+xd,ctype,nsmp)
        e+=0x20; n+=1
    return n

def swap_id_list(B,base,off,limit):
    if not off or off>=limit: return
    p=base+off
    while (p-base)+2<=limit and B.raw16(p)!=0xFFFF: B.sw16(p); p+=2

def swap_mem_list(B,pool,off,limit,kind):
    if not off or off>=limit: return
    m=pool+off
    for _ in range(65536):
        if (m-pool)+8>limit: return
        B.sw32(m); nxt=B.rd32(m)
        if nxt==0xFFFFFFFF: return
        B.sw16(m+4); B.sw16(m+6)
        payload=nxt-8 if nxt>8 else 0
        if (m-pool)+nxt>limit: return
        d=m+8
        if kind=="macro":
            for i in range(payload//4): B.sw32(d+i*4)
        elif kind=="keymap":
            i=0
            while i+8<=payload: B.sw16(d+i); B.sw16(d+i+4); i+=8
        elif kind=="layer":
            B.sw32(d); num=B.rd32(d); L=d+4
            for i in range(num):
                if (i+1)*12+4>payload: break
                B.sw16(L+i*12); B.sw16(L+i*12+6)
        m+=nxt

def swap_page(B,prj,off,limit):
    if not off or off>=limit: return
    o=off
    while o+6<=limit:
        B.sw16(prj+o)
        if B.b[prj+o+4]==0xFF: return
        o+=6

def swap_midi(B,prj,off,limit):
    if not off or off>=limit: return
    p=prj+off
    while (p-prj)+8<=limit and B.raw16(p)!=0xFFFF: B.sw16(p); p+=8

def swap_fx(B,prj,off,limit):
    if not off or off+4>limit: return
    fx=prj+off; B.sw16(fx); B.sw16(fx+2); num=B.rd16(fx); t=fx+4
    for i in range(num):
        if off+4+(i+1)*10>limit: break
        B.sw16(t+i*10); B.sw16(t+i*10+2)

def swap_project(B,prj,limit):
    g=prj
    for _ in range(4096):
        if (g-prj)+0x28>limit: return
        B.sw32(g+0x00); B.sw16(g+0x04); B.sw16(g+0x06)
        for o in (0x08,0x0C,0x10,0x14,0x18,0x1C,0x20,0x24): B.sw32(g+o)
        typ=B.rd16(g+0x06)
        for o in (0x0C,0x08,0x10,0x14,0x18): swap_id_list(B,prj,B.rd32(g+o),limit)
        if typ==1: swap_fx(B,prj,B.rd32(g+0x1C),limit)
        else:
            swap_page(B,prj,B.rd32(g+0x1C),limit); swap_page(B,prj,B.rd32(g+0x20),limit)
            swap_midi(B,prj,B.rd32(g+0x24),limit)
        nxt=B.rd32(g+0x00)
        if nxt==0xFFFFFFFF: return
        if nxt+0x28>limit: return
        g=prj+nxt

def section_end(off, bounds, size):
    e = size
    for b in bounds:
        if b > off and b < e: e = b
    return e

def swap_group(blob):
    B=Buf(blob); size=len(blob)
    for i in range(4): B.sw32(i*4)
    poolOfs,projOfs,sdirOfs,sngOfs=B.rd32(0),B.rd32(4),B.rd32(8),B.rd32(12)
    bounds=[poolOfs,projOfs,sdirOfs,sngOfs,size]
    nsmp=0
    if sdirOfs and sdirOfs<size: nsmp=swap_sdir(B,sdirOfs,section_end(sdirOfs,bounds,size)-sdirOfs)
    if projOfs<size: swap_project(B,projOfs,section_end(projOfs,bounds,size)-projOfs)
    if poolOfs and poolOfs+16<=size:
        pend=section_end(poolOfs,bounds,size)
        for i in range(4): B.sw32(poolOfs+i*4)
        for i,k in enumerate(("macro","curve","keymap","layer")):
            swap_mem_list(B,poolOfs,B.rd32(poolOfs+i*4),pend-poolOfs,k)
    return B,nsmp

ok=0; bad=0; tot_smp=0; smp_checked=[0]; chain=[0]
for k in range(grpInfoSize//0x20):
    gid,=struct.unpack_from(">H",gi,k*32)
    dataOfs,dataSize=struct.unpack_from(">2i",gi,k*32+4)
    if dataSize==0: continue
    blob=rd(grpDataOfs+dataOfs,dataSize)
    try:
        B,nsmp=swap_group(blob); tot_smp+=nsmp
        # LE re-parse must reproduce the BE parse of the untouched original
        be=struct.unpack_from(">4i",blob,0); le=struct.unpack_from("<4i",B.b,0)
        assert be==le, f"grp{gid} head {be} != {le}"
        # SEMANTIC checks on the swapped image: every sdir entry must now read as a sane
        # sample header when loaded little-endian, exactly as the recomp will read it.
        poolOfs,projOfs,sdirOfs,sngOfs = le
        send = section_end(sdirOfs,[poolOfs,projOfs,sdirOfs,sngOfs,dataSize],dataSize)
        e=sdirOfs; n=0
        while e+0x20<=send and struct.unpack_from("<H",B.b,e)[0]!=0xFFFF:
            sid,ref = struct.unpack_from("<2H",B.b,e)
            soff,addr = struct.unpack_from("<2I",B.b,e+4)
            info,ln,lo,ll = struct.unpack_from("<4I",B.b,e+0xC)
            xd, = struct.unpack_from("<I",B.b,e+0x1C)
            ct=ln>>24; nsm=ln&0xFFFFFF
            assert ct<=5, f"grp{gid} sdir[{n}] id={sid} compType={ct}"
            rate=info&0xFFFFFF
            assert 1000<=rate<=48000, f"grp{gid} sdir[{n}] id={sid} sampleRate={rate}"
            if ct in (0,1,4,5):
                assert 0<xd<send-sdirOfs, f"grp{gid} sdir[{n}] extraData={xd} out of sdir"
                ncoef,=struct.unpack_from("<H",B.b,sdirOfs+xd)
                assert ncoef<=64, f"grp{gid} sdir[{n}] numCoef={ncoef}"
            assert nsm < 0x800000, f"grp{gid} sdir[{n}] nSamples={nsm}"
            e+=0x20; n+=1
        smp_checked[0]+=n
        # GROUP_DATA chain must terminate LE too
        g=projOfs; steps=0
        while True:
            nxt,gid2,typ = struct.unpack_from("<IHH",B.b,g)
            steps+=1; assert steps<4096, f"grp{gid} project chain runaway"
            if nxt==0xFFFFFFFF: break
            g=projOfs+nxt
        chain[0]+=steps
        ok+=1
    except AssertionError as e:
        bad+=1; print(f"  grp gid={gid} size={dataSize}: {e}")
print(f"\ngroups swapped clean: {ok}   failures: {bad}   sdir entries swapped: {tot_smp}   sdir entries semantically verified: {smp_checked[0]}   project nodes walked: {chain[0]}")
