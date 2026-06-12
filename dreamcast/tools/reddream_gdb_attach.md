# Attaching to redream's GDB stub

`redream` ships with a built-in GDB stub (confirmed via `strings redream | grep "GDB"` -> `Create GDB debug server`, and the `--gdb <port>` flag in `--help`). This lets us inspect the *guest* SH4 CPU state with full register / memory / breakpoint control - significantly deeper than `lldb`-poking the host process, which only sees the JIT'd x86 frames.

## 1. Launch redream with the GDB stub

```bash
/Users/caseybement/Bemental77.github.io/dreamcast/oracle/redream/redream \
    --gdb 24690 \
    /tmp/pso.chd
```

`24690` is an arbitrary TCP port - any unused port works. redream will boot, then block at the stub waiting for a client to connect. Once a client connects, send `c` (continue) from GDB to let the guest run.

## 2. Client: `sh4-elf-gdb`

```
$ which sh4-elf-gdb
sh4-elf-gdb not found
```

`sh4-elf-gdb` is **not installed** on this machine, and is not available from Homebrew's standard taps. Options:

### Option A - Homebrew tap (recommended on macOS)

There is no first-party `brew install sh4-elf-binutils`. Two third-party taps that historically work:

```bash
# osx-cross has dropped sh4; nyacom's tap is the simplest path:
brew tap nyacom/sh-elf-gcc https://github.com/nyacom/homebrew-sh-elf-gcc
brew install sh-elf-binutils sh-elf-gcc
# binary lands as sh-elf-gdb (without the "4"); same protocol works.
```

### Option B - build binutils from source

```bash
curl -O https://ftp.gnu.org/gnu/binutils/binutils-2.42.tar.xz
tar xf binutils-2.42.tar.xz && cd binutils-2.42
./configure --target=sh4-elf --prefix=$HOME/sh4-tools --disable-nls
make -j$(sysctl -n hw.ncpu)
make install
export PATH="$HOME/sh4-tools/bin:$PATH"
```

This produces `sh4-elf-gdb` in `$HOME/sh4-tools/bin/`.

### Option C - any gdb with remote-protocol support

`lldb` cannot speak the GDB-remote-serial-protocol against a non-LLVM target. Plain `gdb-multiarch` (from any package manager) usually works too, since the GDB remote protocol is architecture-agnostic at the transport level - the host gdb just needs to be told `set architecture sh4` *after* connecting.

```bash
# example with Linux gdb-multiarch (or a generic gdb built with --enable-targets=all):
gdb-multiarch
(gdb) set architecture sh4
(gdb) target remote :24690
```

## 3. Sample session

Once attached, useful first commands:

```gdb
target remote :24690                # connect to the stub
info registers                      # SH4 GPRs / SR / PC / PR / etc.
x/16i 0x8c008374                    # disassemble 16 SH4 insns at guest PC
x/64xw 0x8c008000                   # hex-dump 64 words of guest RAM
b *0x8c008374                       # software breakpoint at guest addr
c                                   # continue
si                                  # step one guest instruction
ni                                  # step one, over branches
info breakpoints
disconnect                          # cleanly detach (stub stays alive)
```

Notes:
- The stub is a *guest* view: PC, registers, memory are SH4-side, not host x86. This is the whole point - it lets us compare native redream's behavior against our flycast WASM JIT at the same guest PC without translating host pointers.
- `x/16i` will only disassemble correctly with a gdb whose `--target` understands `sh4` (i.e. `sh4-elf-gdb` or any gdb with `--enable-targets=all`). With a target-mismatched gdb, `x/16xw` (hex words) still works fine for memory snooping.
- `redream` keeps the SH4 paused while gdb has a breakpoint hit, so the rest of the system clocks freeze too - useful for taking a coherent snapshot.

## 4. Clean shutdown

`disconnect` from gdb leaves redream running; `quit` closes gdb. Kill redream with `pkill -f redream` or by closing its window.
