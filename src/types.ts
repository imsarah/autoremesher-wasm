/**
 * Public types for @autoremesher/wasm.
 */

/** A plain triangle mesh: xyz vertex triples plus triangle indices. */
export interface RawMesh {
    /** Vertex positions, 3 floats per vertex. */
    vertices: Float32Array | number[];
    /** Triangle vertex indices, 3 per face. */
    indices: Uint32Array | Uint16Array | number[];
    /**
     * Optional per-vertex UVs, 2 floats per vertex. When present they
     * are re-projected onto the remeshed output (see preserveUVs).
     */
    uvs?: Float32Array | number[];
}

/**
 * Structural subset of THREE.BufferGeometry accepted as input, so the
 * core package works with Three.js without depending on it.
 */
export interface BufferGeometryLike {
    isBufferGeometry?: boolean;
    attributes: {
        position: { array: ArrayLike<number>; itemSize: number; count: number };
        uv?: { array: ArrayLike<number>; itemSize: number; count: number };
    };
    index?: { array: ArrayLike<number>; count: number } | null;
}

/**
 * Accepted inputs for remesh():
 *  - RawMesh buffers
 *  - OBJ text (string)
 *  - GLB/glTF binary (ArrayBuffer / Uint8Array) or glTF JSON text
 *  - a Three.js BufferGeometry (structurally typed)
 */
export type RemeshInput = RawMesh | string | ArrayBuffer | Uint8Array | BufferGeometryLike;

export type ModelType = "organic" | "hardSurface";

export interface ModuleLoadOptions {
    /**
     * Override where the runtime looks for autoremesher.wasm.
     * Handy with bundlers that emit hashed asset URLs.
     */
    wasmUrl?: string;
    /** Raw wasm bytes, if the embedder prefers to fetch them itself. */
    wasmBinary?: ArrayBuffer;
    /** Emscripten locateFile hook; takes precedence over wasmUrl. */
    locateFile?: (path: string, prefix: string) => string;
    /** Forwarded to the Emscripten module for log capture. */
    print?: (text: string) => void;
    printErr?: (text: string) => void;
    /**
     * Use the multi-threaded (pthreads) build. Requires
     * SharedArrayBuffer — in browsers that means cross-origin
     * isolation (COOP/COEP headers). "auto" picks threads when the
     * environment supports them; false (default) always uses the
     * single-threaded build.
     */
    threads?: boolean | "auto";
}

export interface RemeshOptions {
    /**
     * Approximate target quad count of the output mesh.
     * Internally mapped to the remesher's target triangle count (x2).
     */
    targetQuads?: number;
    /**
     * Raw target triangle count, matching the original CLI's notion of
     * density. Takes precedence over targetQuads when both are given.
     */
    targetTriangleCount?: number;
    /** Edge scaling factor (original CLI `-s/--scaling`). Default: auto. */
    edgeScaling?: number;
    /** Dihedral angle in degrees treated as a sharp edge. Default 90. */
    sharpEdgeThreshold?: number;
    /** Curvature adaptivity, 0.0 - 1.0. Default 1.0. */
    adaptivity?: number;
    /** Compute smooth per-vertex normals for the result. Default true. */
    smoothNormals?: boolean;
    /**
     * Threshold in degrees below which normals are smoothed during
     * resampling (original CLI `--smooth-normal`). 0 disables.
     */
    smoothNormalDegrees?: number;
    /** Shortcut for modelType: "hardSurface". */
    preserveSharpFeatures?: boolean;
    /** "organic" (default) or "hardSurface". */
    modelType?: ModelType;
    /**
     * Re-project the input's UVs onto the remeshed output via
     * closest-point sampling (fills result.uvs). Default: true whenever
     * the input carries UVs. Expect artifacts on UV-island seams.
     */
    preserveUVs?: boolean;
    /**
     * When false/omitted (default), remesh retries denser settings and fills
     * safe boundary loops. If only a small residual loop remains, the native
     * result is returned as `quality: "near-sealed"`; larger failures throw.
     * Set true for intentionally open shells (planes, cloth, partial scans),
     * where larger boundary loops are valid output.
     */
    allowHoles?: boolean;
    /**
     * How many separate connected pieces ("shells") to remesh.
     * Default 1 — only the largest body. Custom exports often have
     * dozens of tiny islands; remeshing each as "Island 43…" is extremely
     * slow. Raise this if you need multiple props in one mesh.
     */
    maxParts?: number;
    /**
     * Drop connected pieces with fewer triangles than this before remesh.
     * Default 32. Filters dust / loose faces that waste island slots.
     */
    minPartTriangles?: number;
    /**
     * Soft cap on triangles fed into the native solver. Only applied when
     * the mesh is denser than this. Default auto: no simplify under ~12–20k
     * tris; caps large uploads so MIQ stays practical. Lower for speed.
     */
    maxInputTriangles?: number;
    /** Progress callback: progress in [0, 1] plus a status label. */
    onProgress?: (progress: number, status: string) => void;
    /** Options for loading the WASM module (first call only). */
    moduleOptions?: ModuleLoadOptions;
}

export interface RemeshedResult {
    /** Vertex positions, 3 floats per vertex. */
    vertices: Float32Array;
    /**
     * Triangulated indices (3 per face) for direct rendering.
     * Each quad contributes two triangles.
     */
    indices: Uint32Array;
    /**
     * Quad faces, 4 indices per face. A triangle emitted by the
     * extractor is encoded with its last index repeated (i2 === i3).
     */
    quads: Uint32Array;
    /** Smooth per-vertex normals (present unless smoothNormals: false). */
    normals?: Float32Array;
    /**
     * Per-vertex UVs re-projected from the source mesh (present when
     * the input had UVs and preserveUVs was not disabled).
     */
    uvs?: Float32Array;
    /** Number of faces in `quads`. */
    quadCount: number;
    /**
     * Whether the returned triangle surface has no boundary edges. A
     * near-sealed result is still a native remesh, but callers should warn
     * users before exporting it when this is false.
     */
    watertight: boolean;
    /** Result quality classification for UI/export decisions. */
    quality: "remeshed" | "near-sealed";
    /** Wall-clock time spent inside the remesher. */
    processingTimeMs: number;
}

/** Error thrown when the native remesher reports a failure. */
export class AutoRemesherError extends Error {
    readonly code: number;

    constructor(message: string, code: number) {
        super(message);
        this.name = "AutoRemesherError";
        this.code = code;
    }
}
