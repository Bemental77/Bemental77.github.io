#!/bin/bash
cd `dirname $0`
emcc -O3 -s WASM=1 -s EXTRA_EXPORTED_RUNTIME_METHODS='["cwrap"]' -s ALLOW_MEMORY_GROWTH=1 source/*.c -o snes9x_2005.js