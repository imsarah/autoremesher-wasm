/**
 * Loads the Emscripten glue module (ESM build).
 *
 * This file is intentionally tiny: the CJS build replaces it with a
 * hand-written CommonJS implementation (scripts/postbuild.mjs), because
 * TypeScript would otherwise downlevel `import()` to `require()`, which
 * cannot load an ES module on Node < 22.
 */
export type EmscriptenModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<unknown>;
export declare function loadGlueFactory(threaded: boolean): Promise<EmscriptenModuleFactory>;
