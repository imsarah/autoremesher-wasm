#!/usr/bin/env bash
# Builds wasm/autoremesher.mjs + wasm/autoremesher.wasm with Emscripten.
#
# Prerequisites:
#   - Emscripten SDK activated (emcc on PATH), e.g. `source /path/to/emsdk/emsdk_env.sh`
#   - CMake >= 3.16
#   - git submodules checked out: `git submodule update --init --depth 1`
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v emcmake >/dev/null 2>&1; then
    echo "error: emcmake not found. Activate the Emscripten SDK first:" >&2
    echo "  source /path/to/emsdk/emsdk_env.sh" >&2
    exit 1
fi

if [ ! -f cpp/autoremesher/src/AutoRemesher/autoremesher.cpp ]; then
    echo "error: cpp/autoremesher submodule is missing. Run:" >&2
    echo "  git submodule update --init --depth 1" >&2
    exit 1
fi

BUILD_DIR="${BUILD_DIR:-build-wasm}"

emcmake cmake -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release "$@"
cmake --build "$BUILD_DIR" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

# Make the glue bundler-safe (annotate Node imports + fix resizable-buffer TextDecoder).
node scripts/patch-glue.mjs

echo
echo "Build outputs:"
ls -lh wasm/autoremesher.mjs wasm/autoremesher.wasm wasm/autoremesher-mt.mjs wasm/autoremesher-mt.wasm
