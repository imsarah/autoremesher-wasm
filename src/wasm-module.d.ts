/**
 * Ambient declaration for the Emscripten glue module produced by the
 * WASM build (wasm/autoremesher.mjs).
 */
declare module "*autoremesher.mjs" {
    const factory: (moduleArg?: Record<string, unknown>) => Promise<unknown>;
    export default factory;
}

declare module "*autoremesher-mt.mjs" {
    const factory: (moduleArg?: Record<string, unknown>) => Promise<unknown>;
    export default factory;
}
