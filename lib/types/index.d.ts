/**
 * @autoremesher/wasm — automatic quad remeshing in WebAssembly.
 *
 * Port of https://github.com/huxingyi/autoremesher (MIT) to the web.
 */
import type { RemeshInput, RemeshOptions, RemeshedResult } from "./types.js";
export { loadAutoRemesherModule, threadsSupported } from "./module.js";
export type { AutoRemesherWasmModule } from "./module.js";
export { transferAttribute, transferUVs } from "./transfer.js";
export type { TransferSource } from "./transfer.js";
export { parseObj, resultToObj } from "./obj.js";
export { parseGlb, parseGltfJson } from "./gltf.js";
export { quadsToTriangles, computeVertexNormals, sanitizeTriangleIndices, aspectRatioNormalize, aspectRatioRestore, assessRemeshQuality, assessTriangleTopology, countBoundaryEdges, fillMeshHoles, makeFaceWindingConsistent, pairTriangleFacesIntoQuads, extractConnectedShells, extractManifoldShells, selectLargestShells, decimateToTriangleBudget, ensureDecimatorReady, weldVerticesByPosition, } from "./geometry.js";
export { AutoRemesherError } from "./types.js";
export type { BufferGeometryLike, ModelType, ModuleLoadOptions, RawMesh, RemeshInput, RemeshOptions, RemeshedResult, } from "./types.js";
/**
 * Remeshes a triangle mesh into a quad-dominant mesh.
 *
 * Accepts raw vertex/index buffers, OBJ text, GLB/glTF data, or a
 * Three.js BufferGeometry. The heavy lifting runs synchronously inside
 * WASM — for interactive apps, call this from a Web Worker.
 *
 * By default, the pipeline retries denser settings and fills residual
 * boundary loops. If only a small, safe residual loop remains, the native
 * remesh is returned as `quality: "near-sealed"`; larger failures throw
 * instead of pretending that the source mesh was remeshed.
 */
export declare function remesh(input: RemeshInput, options?: RemeshOptions): Promise<RemeshedResult>;
