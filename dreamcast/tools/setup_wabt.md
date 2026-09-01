# wabt setup

`wasm_block_inspect.sh` requires the WebAssembly Binary Toolkit
(wabt) — specifically `wasm2wat`, `wasm-objdump`, and (optionally)
`wasm-validate`.

## macOS

```
brew install wabt
```

After install, verify:

```
which wasm2wat wasm-objdump wasm-validate
```

All three should print paths (typically `/opt/homebrew/bin/...` on Apple
Silicon, `/usr/local/bin/...` on Intel).

## Debian / Ubuntu

```
sudo apt-get install wabt
```

## From source

```
git clone --recursive https://github.com/WebAssembly/wabt
cd wabt && mkdir build && cd build
cmake .. && make -j4 && sudo make install
```

## What each tool does

| Tool             | Use                                                      |
|------------------|----------------------------------------------------------|
| `wasm2wat`       | Binary `.wasm` → human-readable `.wat` (S-expressions).  |
| `wasm-objdump -d` | Disassemble functions in a `.wasm` module.              |
| `wasm-validate`  | Verify a `.wasm` is well-formed (useful for JIT output). |

## Where the block dumps come from

Wave 2 of the SH4 JIT bringup adds `FLYCAST_DUMP_BLOCKS=1` to
`bementalJIT/guests/sh4/rec_wasm.cpp::compile`. When set, every
compiled block is written to `/tmp/dc-blocks/0x<vaddr>.wasm` where
`<vaddr>` is the lower-case hex SH4 virtual address of the block's
first instruction.

`wasm_block_inspect.sh <vaddr>` resolves that path, runs `wasm2wat`
and `wasm-objdump -d`, and prints both. Use `--diff <vaddr2>` to
compare two blocks' `.wat` output line-by-line.
