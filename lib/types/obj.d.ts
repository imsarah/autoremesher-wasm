/**
 * Minimal, fast Wavefront OBJ reader/writer.
 *
 * Reads vertex positions, texture coordinates, and faces (polygons are
 * fan-triangulated, negative indices supported); everything else is
 * ignored, mirroring how the original AutoRemesher CLI consumes OBJ.
 *
 * UVs are returned per-vertex: OBJ allows a position to carry a
 * different vt per face corner (UV seams); when that happens the last
 * mapping wins, which is fine for closest-point re-projection.
 */
import type { RemeshedResult } from "./types.js";
export interface ParsedObj {
    vertices: Float32Array;
    indices: Uint32Array;
    /** Per-vertex UVs; only present if the file contains vt records. */
    uvs?: Float32Array;
}
export declare function parseObj(text: string): ParsedObj;
/**
 * Serializes a remeshed result to OBJ text with native quad faces
 * (triangles are written as 3-index faces). Includes vt records when
 * the result carries UVs.
 */
export declare function resultToObj(result: RemeshedResult): string;
