/**
 * Post-processes the Emscripten glue (wasm/*.mjs). Two independent fixes:
 *
 * 1. Bundler-safe Node imports. The glue's Node-only dynamic imports
 *    (node:module, node:worker_threads, ...) are guarded by runtime
 *    environment checks, but webpack tries to resolve them statically
 *    and fails with UnhandledSchemeError. Magic comments tell
 *    webpack/Vite to leave them as genuine runtime imports (which
 *    browsers never execute).
 *
 * 2. Resizable-ArrayBuffer TextDecoder fix. With ALLOW_MEMORY_GROWTH the
 *    heap is a resizable ArrayBuffer. Chrome's TextDecoder.decode()
 *    throws "The provided ArrayBuffer value must not be resizable" when
 *    handed a subarray view of one. Emscripten 6 removed the pure-JS
 *    TEXTDECODER=0 fallback, so we rewrite the single decode call to use
 *    .slice() (copies into a fresh, non-resizable buffer) instead of
 *    .subarray() (a view into the resizable heap). Strings decoded here
 *    are short status/error messages, so the copy is negligible.
 *
 * Run automatically at the end of emscripten/build.sh.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wasmDir = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm");
const IGNORE = "/* webpackIgnore: true */ /* @vite-ignore */";

for (const basename of ["autoremesher.mjs", "autoremesher-mt.mjs"]) {
    const path = join(wasmDir, basename);
    if (!existsSync(path))
        continue;
    const source = readFileSync(path, "utf8");
    let patched = source;

    // Fix 1: annotate node: dynamic imports for bundlers.
    patched = patched.replace(
        /import\(\s*(?!\/\*)("node:[^"]+"|'node:[^']+')/g,
        `import(${IGNORE} $1`
    );

    // Fix 2: TextDecoder.decode() must not see a view into a resizable
    // ArrayBuffer. Rewrite .subarray() -> .slice() in both glue shapes:
    //   single-threaded: UTF8Decoder.decode(heap.subarray(idx,endPtr))
    //   pthreads ternary: ...instanceof ArrayBuffer?heap.subarray(...):...
    patched = patched.replace(
        /(\bUTF8Decoder\.decode\(\s*)(\w+)\.subarray\(/g,
        "$1$2.slice("
    );
    patched = patched.replace(
        /(instanceof ArrayBuffer\s*\?\s*)(\w+)\.subarray\(/g,
        "$1$2.slice("
    );

    if (patched !== source) {
        writeFileSync(path, patched);
        console.log(`patch-glue: patched ${basename}`);
    } else {
        console.log(`patch-glue: ${basename} already patched`);
    }
}
