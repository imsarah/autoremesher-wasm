/**
 * Attribute transfer from a source triangle mesh onto remeshed output.
 *
 * For every target vertex, finds the closest point on the source
 * surface (BVH-accelerated) and interpolates the source's per-vertex
 * attribute with barycentric weights. This is the standard
 * closest-point projection used for UV preservation after retopology;
 * expect artifacts directly on UV-island seams (a target vertex snaps
 * to one side of the seam).
 */
/** Source surface plus one per-vertex attribute to sample. */
export interface TransferSource {
    /** Source vertex positions, xyz triples. */
    vertices: Float32Array;
    /** Source triangle indices, 3 per face. */
    indices: Uint32Array;
}
/**
 * Samples a per-vertex attribute of the source mesh at each target
 * position via closest-point projection.
 *
 * @param source     source surface (positions + triangles)
 * @param values     source per-vertex attribute values (itemSize floats per vertex)
 * @param itemSize   floats per vertex in `values` (2 for UVs, 3 for colors, ...)
 * @param targetPositions  positions to sample at, xyz triples
 * @returns per-target-vertex attribute, targetPositions.length / 3 * itemSize floats
 */
export declare function transferAttribute(source: TransferSource, values: Float32Array, itemSize: number, targetPositions: Float32Array): Float32Array;
/** Convenience wrapper: transfers 2-component UVs. */
export declare function transferUVs(source: TransferSource & {
    uvs: Float32Array;
}, targetPositions: Float32Array): Float32Array;
