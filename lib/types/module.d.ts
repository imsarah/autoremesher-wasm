/**
 * WASM module loading and low-level marshalling.
 */
import type { ModuleLoadOptions } from "./types.js";
/** The subset of the Emscripten module instance the wrapper uses. */
export interface AutoRemesherWasmModule {
    _ar_remesh(verticesPtr: number, vertexCount: number, trianglesPtr: number, triangleCount: number, targetTriangleCount: number, scaling: number, adaptivity: number, sharpEdgeDegrees: number, smoothNormalDegrees: number, modelType: number): number;
    _ar_get_vertices(): number;
    _ar_get_vertex_count(): number;
    _ar_get_quads(): number;
    _ar_get_quad_count(): number;
    _ar_get_error(): number;
    _ar_release(): void;
    _ar_malloc(size: number): number;
    _ar_free(ptr: number): void;
    UTF8ToString(ptr: number): string;
    HEAPF32: Float32Array;
    HEAPU32: Uint32Array;
    HEAPU8: Uint8Array;
    onRemeshProgress?: (progress: number, status: string) => void;
}
/**
 * True when the current environment can run the pthreads build:
 * SharedArrayBuffer must exist, and in browsers the page must be
 * cross-origin isolated (COOP/COEP).
 */
export declare function threadsSupported(): boolean;
/**
 * Loads (and caches, per variant) the WASM module. Call it ahead of
 * time to warm up, or let remesh() load it lazily on first use.
 */
export declare function loadAutoRemesherModule(options?: ModuleLoadOptions): Promise<AutoRemesherWasmModule>;
export interface NativeRemeshParams {
    targetTriangleCount: number;
    scaling: number;
    adaptivity: number;
    sharpEdgeDegrees: number;
    smoothNormalDegrees: number;
    modelType: number;
    onProgress?: (progress: number, status: string) => void;
}
export interface NativeRemeshOutput {
    vertices: Float32Array;
    quads: Uint32Array;
}
/**
 * Runs the native remesher over raw buffers. Handles heap allocation,
 * copies, error propagation, and cleanup. Note the WASM call itself is
 * synchronous and will block the calling thread; run inside a worker
 * for interactive applications.
 */
export declare function runNativeRemesh(module: AutoRemesherWasmModule, vertices: Float32Array, indices: Uint32Array, params: NativeRemeshParams): NativeRemeshOutput;
