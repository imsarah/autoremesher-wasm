/**
 * Geometry helpers: quad -> triangle conversion, normals, and mesh
 * pre/post-processing used by remesh().
 */
/** Axis-aligned bounding box of a position buffer. */
export interface BoundingBox {
    min: [number, number, number];
    max: [number, number, number];
}
/**
 * Converts a quad index buffer (4 indices per face, triangles encoded
 * with the last index repeated) into a triangle index buffer.
 */
export declare function quadsToTriangles(quads: Uint32Array): Uint32Array;
/**
 * Reconstructs quad faces from adjacent source triangles without moving a
 * single vertex. It is a last-resort, topology-safe fallback when the native
 * field extractor cannot close a mesh: clean CAD/primitive grids still get a
 * valid quad representation instead of a corrupt cap across the surface.
 */
export declare function pairTriangleFacesIntoQuads(indices: Uint32Array): Uint32Array;
/**
 * Area-weighted smooth vertex normals from a triangulated mesh.
 */
export declare function computeVertexNormals(vertices: Float32Array, indices: Uint32Array): Float32Array;
/** Axis-aligned bounding box of xyz triples. */
export declare function meshBoundingBox(vertices: Float32Array): BoundingBox;
/** Bounding-box volume (0 if the mesh is empty or flat on any axis). */
export declare function boundingBoxVolume(box: BoundingBox): number;
/** Bounding-box diagonal length. */
export declare function boundingBoxDiagonal(box: BoundingBox): number;
/** Surface area of a triangle mesh. */
export declare function meshSurfaceArea(vertices: Float32Array, indices: Uint32Array): number;
/**
 * Merge vertices that share the same position (within a grid). Render
 * meshes often duplicate verts at UV/normal seams; without welding,
 * AutoRemesher splits the surface into many manifold islands and
 * remeshes only a strip — which looks "ugly" or collapsed.
 */
export declare function weldVerticesByPosition(vertices: Float32Array, indices: Uint32Array, quantize?: number): {
    vertices: Float32Array;
    indices: Uint32Array;
    weldedFrom: number;
};
/**
 * Drops degenerate triangles (repeated indices or near-zero area).
 * Returns a new index buffer; vertices are left unchanged.
 */
export declare function sanitizeTriangleIndices(vertices: Float32Array, indices: Uint32Array, areaEpsilon?: number): {
    indices: Uint32Array;
    removed: number;
};
/**
 * Counts boundary edges (used by exactly one triangle). Useful as a
 * cheap closedness proxy for quality checks.
 */
export declare function countBoundaryEdges(indices: Uint32Array): number;
/** Detailed connectivity validation for a triangulated remesh result. */
export interface TriangleTopologyQuality {
    ok: boolean;
    boundaryEdges: number;
    nonManifoldEdges: number;
    duplicateTriangles: number;
    degenerateTriangles: number;
    invalidIndices: number;
    reasons: string[];
}
/**
 * Checks the actual triangles rendered by the browser. Boundary edges are
 * reported separately because intentionally open meshes may allow them.
 */
export declare function assessTriangleTopology(vertices: Float32Array, indices: Uint32Array): TriangleTopologyQuality;
/**
 * Face-connected components via undirected edge adjacency (loose "pieces").
 */
export declare function extractConnectedShells(indices: Uint32Array): number[][];
/**
 * Face-connected components matching AutoRemesher's C++ MeshSeparator:
 * two faces are connected only if they share an edge with **opposite**
 * winding (a→b on one face, b→a on the other). Inconsistent winding or
 * non-manifold edges split islands — that is what produces
 * "Island 43: mixed-integer solve" even when the mesh looks like one object.
 */
export declare function extractManifoldShells(indices: Uint32Array): number[][];
/**
 * Flip triangle windings so adjacent faces use opposite edge directions
 * wherever they share an undirected edge. Merges many of C++'s "islands"
 * that only exist because of inconsistent normals/winding in exports.
 * Returns a new index buffer (does not mutate the input).
 */
export declare function makeFaceWindingConsistent(indices: Uint32Array): Uint32Array;
export interface SelectShellsOptions {
    /** Drop shells with fewer triangles than this. Default 32. */
    minPartTriangles?: number;
    /**
     * Keep at most this many largest shells after the min-size filter.
     * Default 1 (main body only) — avoids "Island 43" hangs.
     * Pass a large number (e.g. 1000) to keep every part above min size.
     */
    maxParts?: number;
}
export interface SelectShellsResult {
    /** Compact mesh of the selected shells only. */
    vertices: Float32Array;
    indices: Uint32Array;
    totalShells: number;
    /** Manifold islands after winding fix (what AutoRemesher would process). */
    manifoldIslands: number;
    keptShells: number;
    droppedShells: number;
    keptTriangles: number;
    droppedTriangles: number;
    flippedForWinding: boolean;
}
/**
 * Prepares a mesh for AutoRemesher:
 * 1) make face windings consistent
 * 2) split with the same manifold rules as C++ MeshSeparator
 * 3) keep only the largest shell(s)
 *
 * Without (1)+(2), a single "object" can still become Island 1…43 in WASM.
 */
export declare function selectLargestShells(vertices: Float32Array, indices: Uint32Array, options?: SelectShellsOptions): SelectShellsResult;
/**
 * Wait for meshoptimizer WASM (edge-collapse simplifier). Call once before
 * the first {@link decimateToTriangleBudget} in an async path (remesh /
 * playground pre-decimate).
 */
export declare function ensureDecimatorReady(): Promise<void>;
export type DecimateMethod = "none" | "meshopt" | "grid";
export interface DecimateResult {
    vertices: Float32Array;
    indices: Uint32Array;
    reduced: boolean;
    fromTriangles: number;
    toTriangles: number;
    /** Which algorithm produced the result. */
    method: DecimateMethod;
}
/**
 * Hard cap on triangle count before the native mixed-integer solve.
 *
 * Prefer **meshoptimizer edge-collapse** (good on spheres / organic closed
 * meshes). Fall back to grid clustering when WASM simplify is unavailable.
 *
 * IMPORTANT: never returns the original mesh when over budget — that used
 * to leave 30k+ inputs stuck on "Island 1: mixed-integer solve".
 *
 * Call {@link ensureDecimatorReady} once before the first use in an async
 * context so meshopt WASM is initialized.
 */
export declare function decimateToTriangleBudget(vertices: Float32Array, indices: Uint32Array, maxTriangles: number): DecimateResult;
/**
 * Non-uniform scale that maps the mesh bbox to a cube of side
 * `targetSize` centered at the origin. AutoRemesher's isotropic
 * pre-remesh uses a single voxel size derived from total surface area;
 * elongated shapes therefore undersample the short axes and the quad
 * extractor collapses to a fragment. Fitting into a cube first avoids
 * that failure mode; vertices are restored afterwards.
 */
export interface AspectRatioTransform {
    /** Transformed vertex positions. */
    vertices: Float32Array;
    /** Original bbox center. */
    center: [number, number, number];
    /** Per-axis scale applied to go from original → unit cube. */
    scale: [number, number, number];
    /** True when a non-uniform scale was applied (max/min extent > threshold). */
    applied: boolean;
}
/**
 * Center + scale into a stable range so voxel sizing is consistent.
 *
 * Strategy (shape-aware):
 * - **Rod-like** (one axis much longer than the other two, e.g. stretched
 *   character/limb): non-uniform squash into a cube. Without this the
 *   MIQ solver collapses (diag/vol → ~0).
 * - **Everything else** (sphere, torus, pancake): *uniform* scale only.
 *   Non-uniform warps torus quads into streaks (aspect ~2.5 vs ~1.3).
 *
 * Rod detection: sort extents (min, mid, max); rod when max/mid ≥ 2.
 */
export declare function aspectRatioNormalize(vertices: Float32Array, targetSize?: number, rodThreshold?: number): AspectRatioTransform;
/** Inverse of {@link aspectRatioNormalize}. */
export declare function aspectRatioRestore(vertices: Float32Array, transform: Pick<AspectRatioTransform, "center" | "scale">): Float32Array;
export interface MeshQuality {
    ok: boolean;
    /** True when the only failures are holes (not collapse / garbage). */
    hasHolesOnly: boolean;
    bboxVolumeRatio: number;
    boundaryEdges: number;
    quadCount: number;
    reasons: string[];
}
export interface AssessQualityOptions {
    /**
     * When true, any remaining boundary edges after fill attempts count
     * as a quality failure. Use when the caller wants a closed solid.
     */
    requireWatertight?: boolean;
}
/**
 * Cheap post-remesh health check. The native extractor sometimes
 * "succeeds" with a collapsed fragment (handful of quads, near-zero
 * bbox) or a mesh full of holes — treat that as a failure so the
 * wrapper can retry denser, fill holes, or error.
 */
export declare function assessRemeshQuality(sourceVertices: Float32Array, resultVertices: Float32Array, resultIndices: Uint32Array, quadCount: number, options?: AssessQualityOptions): MeshQuality;
/**
 * Closes only small, simple, near-planar boundary loops by fan-triangulating
 * them. The native extractor can occasionally emit a long, winding boundary;
 * fan-capping that boundary creates the giant crossing sheets seen in broken
 * torus/sphere results, so unsafe loops are deliberately left for a retry.
 *
 * Boundary edges that form non-manifold junctions (vertex with more
 * than one outgoing hole half-edge that cannot form a simple cycle)
 * are left alone; remainingBoundaryEdges reports what is left.
 */
export declare function fillMeshHoles(vertices: Float32Array, indices: Uint32Array): {
    indices: Uint32Array;
    filledTriangles: Uint32Array;
    loopsFilled: number;
    remainingBoundaryEdges: number;
};
/**
 * Appends triangle faces as repeated-last-index quads so exporters that
 * only look at `quads` stay in sync after hole filling.
 */
export declare function appendTriangleQuads(quads: Uint32Array, triangles: Uint32Array): Uint32Array;
/**
 * Clamps the engine's targetTriangleCount so the derived voxel size
 * stays in a range where isotropic remesh + MIQ extraction is stable.
 * Very high targets relative to surface area produce tiny voxels and
 * empty/fragmented output on modest meshes.
 */
export declare function clampTargetTriangleCount(requested: number, area: number, diagonal: number, inputTriangleCount: number): number;
