/**
 * Minimal glTF 2.0 / GLB triangle-mesh extraction (no external deps).
 *
 * Supports:
 *  - GLB containers (embedded BIN chunk)
 *  - .gltf JSON with base64 data: URI buffers
 *  - POSITION accessors (float32), indexed and non-indexed primitives,
 *    u8/u16/u32 index component types, byteStride/interleaved layouts
 *
 * All triangle primitives of all meshes are merged into a single buffer
 * pair (node transforms are not applied). External .bin buffer files are
 * not fetched — pass a GLB or embed buffers as data URIs.
 */
export interface ParsedGltf {
    vertices: Float32Array;
    indices: Uint32Array;
    /**
     * Merged TEXCOORD_0, present only when every triangle primitive
     * carries float32 VEC2 texture coordinates.
     */
    uvs?: Float32Array;
}
export declare function isGlb(bytes: Uint8Array): boolean;
export declare function parseGlb(bytes: Uint8Array): ParsedGltf;
export declare function parseGltfJson(text: string): ParsedGltf;
