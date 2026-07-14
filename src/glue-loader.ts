/**
 * Loads the Emscripten glue module (ESM build).
 *
 * This file is intentionally tiny: the CJS build replaces it with a
 * hand-written CommonJS implementation (scripts/postbuild.mjs), because
 * TypeScript would otherwise downlevel `import()` to `require()`, which
 * cannot load an ES module on Node < 22.
 */

export type EmscriptenModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<unknown>;

export async function loadGlueFactory(threaded: boolean): Promise<EmscriptenModuleFactory> {
    // Resolved relative to lib/esm/ at runtime; bundlers follow these
    // imports and pick up the .wasm assets referenced by the glue.
    const glue = threaded
        ? await import(
            /* webpackChunkName: "autoremesher-wasm-mt" */
            "../../wasm/autoremesher-mt.mjs"
        )
        : await import(
            /* webpackChunkName: "autoremesher-wasm" */
            "../../wasm/autoremesher.mjs"
        );
    return (glue.default ?? glue) as EmscriptenModuleFactory;
}
