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
    // Prefer the single-thread build as a static import path so bundlers
    // (Next/webpack workers) do not pull the pthread glue into the graph by
    // default. The mt build uses top-level await + em-pthread and creates
    // circular worker chunks that break browser remesh workers.
    //
    // When threads are requested, load mt via a runtime URL so webpack cannot
    // statically include it in the default remesher bundle.
    if (threaded) {
        const url = new URL("../../wasm/autoremesher-mt.mjs", import.meta.url);
        const glue = await import(
            /* webpackIgnore: true */
            url.href
        );
        return (glue.default ?? glue) as EmscriptenModuleFactory;
    }
    const glue = await import(
        /* webpackChunkName: "autoremesher-wasm" */
        "../../wasm/autoremesher.mjs"
    );
    return (glue.default ?? glue) as EmscriptenModuleFactory;
}
