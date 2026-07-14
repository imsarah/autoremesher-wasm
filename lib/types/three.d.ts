/**
 * Three.js integration helpers.
 *
 * Import from "@autoremesher/wasm/three" — this subpath is the only
 * part of the package that imports "three" at runtime (declared as an
 * optional peer dependency).
 */
import { BufferGeometry } from "three";
import type { RawMesh, RemeshedResult } from "./types.js";
/**
 * Extracts vertices/indices from a BufferGeometry (indexed or not).
 * Note: attribute buffers are referenced, not copied.
 */
export declare function fromBufferGeometry(geometry: BufferGeometry): RawMesh;
/**
 * Builds a render-ready BufferGeometry (triangulated) from a remeshed
 * result, including smooth normals when present.
 */
export declare function toBufferGeometry(result: RemeshedResult): BufferGeometry;
