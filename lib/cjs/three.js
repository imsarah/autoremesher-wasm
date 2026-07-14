"use strict";
/**
 * Three.js integration helpers.
 *
 * Import from "@autoremesher/wasm/three" — this subpath is the only
 * part of the package that imports "three" at runtime (declared as an
 * optional peer dependency).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromBufferGeometry = fromBufferGeometry;
exports.toBufferGeometry = toBufferGeometry;
const three_1 = require("three");
/**
 * Extracts vertices/indices from a BufferGeometry (indexed or not).
 * Note: attribute buffers are referenced, not copied.
 */
function fromBufferGeometry(geometry) {
    const position = geometry.getAttribute("position");
    if (!position)
        throw new Error("BufferGeometry has no position attribute");
    const vertices = position.array instanceof Float32Array
        ? position.array
        : Float32Array.from(position.array);
    let indices;
    const index = geometry.getIndex();
    if (index) {
        indices = index.array instanceof Uint32Array
            ? index.array
            : Uint32Array.from(index.array);
    }
    else {
        indices = new Uint32Array(position.count);
        for (let i = 0; i < indices.length; ++i)
            indices[i] = i;
    }
    return { vertices, indices };
}
/**
 * Builds a render-ready BufferGeometry (triangulated) from a remeshed
 * result, including smooth normals when present.
 */
function toBufferGeometry(result) {
    const geometry = new three_1.BufferGeometry();
    geometry.setAttribute("position", new three_1.BufferAttribute(result.vertices, 3));
    geometry.setIndex(new three_1.BufferAttribute(result.indices, 1));
    if (result.normals)
        geometry.setAttribute("normal", new three_1.BufferAttribute(result.normals, 3));
    else
        geometry.computeVertexNormals();
    return geometry;
}
