/**
 * WASM module loading and low-level marshalling.
 */
import { loadGlueFactory } from "./glue-loader.js";
import { AutoRemesherError } from "./types.js";
const modulePromises = {};
/**
 * True when the current environment can run the pthreads build:
 * SharedArrayBuffer must exist, and in browsers the page must be
 * cross-origin isolated (COOP/COEP).
 */
export function threadsSupported() {
    if (typeof SharedArrayBuffer === "undefined")
        return false;
    const isBrowser = typeof window !== "undefined" || typeof self !== "undefined";
    const nav = globalThis.navigator;
    if (!nav?.hardwareConcurrency)
        return false;
    if (isBrowser && typeof crossOriginIsolated !== "undefined")
        return crossOriginIsolated;
    return true;
}
function resolveVariant(options) {
    if (options.threads === true)
        return "mt";
    if (options.threads === "auto")
        return threadsSupported() ? "mt" : "st";
    return "st";
}
/**
 * Loads (and caches, per variant) the WASM module. Call it ahead of
 * time to warm up, or let remesh() load it lazily on first use.
 */
export function loadAutoRemesherModule(options = {}) {
    const variant = resolveVariant(options);
    let promise = modulePromises[variant];
    if (!promise) {
        promise = instantiate(options, variant === "mt");
        modulePromises[variant] = promise;
        promise.catch(() => {
            // Allow retrying with different options after a failed load.
            modulePromises[variant] = undefined;
        });
    }
    return promise;
}
async function instantiate(options, threaded) {
    const factory = await loadGlueFactory(threaded);
    // The native code logs verbosely (progress spam from the quad
    // extractor); keep the library quiet unless the embedder asks.
    const noop = () => { };
    const moduleArg = {
        print: options.print ?? noop,
        printErr: options.printErr ?? noop,
    };
    if (options.wasmBinary)
        moduleArg.wasmBinary = options.wasmBinary;
    if (options.locateFile) {
        moduleArg.locateFile = options.locateFile;
    }
    else if (options.wasmUrl) {
        const wasmUrl = options.wasmUrl;
        moduleArg.locateFile = (path, prefix) => path.endsWith(".wasm") ? wasmUrl : prefix + path;
    }
    return (await factory(moduleArg));
}
/**
 * Runs the native remesher over raw buffers. Handles heap allocation,
 * copies, error propagation, and cleanup. Note the WASM call itself is
 * synchronous and will block the calling thread; run inside a worker
 * for interactive applications.
 */
export function runNativeRemesh(module, vertices, indices, params) {
    const vertexCount = vertices.length / 3;
    const triangleCount = indices.length / 3;
    const verticesPtr = module._ar_malloc(vertices.length * 4);
    const indicesPtr = module._ar_malloc(indices.length * 4);
    if (!verticesPtr || !indicesPtr) {
        if (verticesPtr)
            module._ar_free(verticesPtr);
        if (indicesPtr)
            module._ar_free(indicesPtr);
        throw new AutoRemesherError("Failed to allocate WASM heap memory for input mesh", -100);
    }
    let code;
    try {
        // Heap views must be re-read from the module after any allocation:
        // ALLOW_MEMORY_GROWTH can detach previous ArrayBuffers.
        module.HEAPF32.set(vertices, verticesPtr >> 2);
        module.HEAPU32.set(indices, indicesPtr >> 2);
        module.onRemeshProgress = params.onProgress;
        code = module._ar_remesh(verticesPtr, vertexCount, indicesPtr, triangleCount, params.targetTriangleCount, params.scaling, params.adaptivity, params.sharpEdgeDegrees, params.smoothNormalDegrees, params.modelType);
    }
    finally {
        module.onRemeshProgress = undefined;
        module._ar_free(verticesPtr);
        module._ar_free(indicesPtr);
    }
    if (code !== 0) {
        const message = module.UTF8ToString(module._ar_get_error());
        throw new AutoRemesherError(message || `Remeshing failed with code ${code}`, code);
    }
    try {
        const outVertexCount = module._ar_get_vertex_count();
        const outQuadCount = module._ar_get_quad_count();
        const verticesOut = new Float32Array(module.HEAPF32.buffer, module._ar_get_vertices(), outVertexCount * 3).slice();
        const quadsOut = new Uint32Array(module.HEAPU32.buffer, module._ar_get_quads(), outQuadCount * 4).slice();
        return { vertices: verticesOut, quads: quadsOut };
    }
    finally {
        module._ar_release();
    }
}
