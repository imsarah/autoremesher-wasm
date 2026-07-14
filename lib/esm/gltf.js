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
const GLB_MAGIC = 0x46546c67; // 'glTF'
export function isGlb(bytes) {
    return bytes.byteLength >= 12
        && new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(0, true) === GLB_MAGIC;
}
export function parseGlb(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC)
        throw new Error("Not a GLB file (bad magic)");
    const totalLength = view.getUint32(8, true);
    let offset = 12;
    let json = null;
    let bin = null;
    while (offset + 8 <= totalLength) {
        const chunkLength = view.getUint32(offset, true);
        const chunkType = view.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        if (chunkType === 0x4e4f534a /* JSON */) {
            const jsonBytes = bytes.subarray(chunkStart, chunkStart + chunkLength);
            json = JSON.parse(new TextDecoder().decode(jsonBytes));
        }
        else if (chunkType === 0x004e4942 /* BIN */) {
            bin = bytes.subarray(chunkStart, chunkStart + chunkLength);
        }
        offset = chunkStart + chunkLength + ((4 - (chunkLength % 4)) % 4);
    }
    if (!json)
        throw new Error("GLB file has no JSON chunk");
    return extractTriangles(json, bin);
}
export function parseGltfJson(text) {
    const json = JSON.parse(text);
    return extractTriangles(json, null);
}
function decodeBase64(base64) {
    if (typeof Buffer !== "undefined")
        return new Uint8Array(Buffer.from(base64, "base64"));
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i)
        out[i] = binary.charCodeAt(i);
    return out;
}
function extractTriangles(json, bin) {
    const buffers = (json.buffers ?? []).map((buffer, index) => {
        if (buffer.uri === undefined) {
            if (!bin)
                throw new Error(`glTF buffer ${index} expects a GLB BIN chunk`);
            return bin;
        }
        const dataPrefix = "data:";
        if (buffer.uri.startsWith(dataPrefix)) {
            const comma = buffer.uri.indexOf(",");
            return decodeBase64(buffer.uri.slice(comma + 1));
        }
        throw new Error(`glTF buffer ${index} references external file "${buffer.uri}"; ` +
            "load it as GLB or embed buffers as data URIs");
    });
    const vertexChunks = [];
    const indexChunks = [];
    const uvChunks = [];
    let allHaveUvs = true;
    let vertexBase = 0;
    for (const mesh of json.meshes ?? []) {
        for (const primitive of mesh.primitives) {
            const mode = primitive.mode ?? 4;
            if (mode !== 4)
                continue; // only TRIANGLES
            const positionAccessor = primitive.attributes.POSITION;
            if (positionAccessor === undefined)
                continue;
            const positions = readVec3FloatAccessor(json, buffers, positionAccessor);
            const vertexCount = positions.length / 3;
            const uvAccessor = primitive.attributes.TEXCOORD_0;
            if (uvAccessor !== undefined && allHaveUvs) {
                const uvs = tryReadVec2FloatAccessor(json, buffers, uvAccessor, vertexCount);
                if (uvs)
                    uvChunks.push(uvs);
                else
                    allHaveUvs = false;
            }
            else {
                allHaveUvs = false;
            }
            let indices;
            if (primitive.indices !== undefined) {
                indices = readScalarIntAccessor(json, buffers, primitive.indices);
            }
            else {
                indices = new Uint32Array(vertexCount);
                for (let i = 0; i < vertexCount; ++i)
                    indices[i] = i;
            }
            if (vertexBase > 0) {
                for (let i = 0; i < indices.length; ++i)
                    indices[i] += vertexBase;
            }
            vertexChunks.push(positions);
            indexChunks.push(indices);
            vertexBase += vertexCount;
        }
    }
    if (vertexChunks.length === 0)
        throw new Error("glTF input contains no triangle primitives with POSITION data");
    const vertices = concatFloat32(vertexChunks);
    const indices = concatUint32(indexChunks);
    const result = { vertices, indices };
    if (allHaveUvs && uvChunks.length === vertexChunks.length)
        result.uvs = concatFloat32(uvChunks);
    return result;
}
function accessorView(json, buffers, accessorIndex) {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor)
        throw new Error(`glTF accessor ${accessorIndex} is missing`);
    if (accessor.sparse)
        throw new Error("Sparse glTF accessors are not supported");
    if (accessor.bufferView === undefined)
        throw new Error("glTF accessor without bufferView is not supported");
    const bufferView = json.bufferViews?.[accessor.bufferView];
    if (!bufferView)
        throw new Error(`glTF bufferView ${accessor.bufferView} is missing`);
    const buffer = buffers[bufferView.buffer];
    const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const bytes = buffer.subarray(start, (bufferView.byteOffset ?? 0) + bufferView.byteLength);
    return { accessor, bytes, stride: bufferView.byteStride ?? 0 };
}
function readVec3FloatAccessor(json, buffers, accessorIndex) {
    const { accessor, bytes, stride } = accessorView(json, buffers, accessorIndex);
    if (accessor.componentType !== 5126 || accessor.type !== "VEC3")
        throw new Error("POSITION accessor must be float32 VEC3");
    const out = new Float32Array(accessor.count * 3);
    const effectiveStride = stride || 12;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < accessor.count; ++i) {
        const base = i * effectiveStride;
        out[i * 3 + 0] = view.getFloat32(base + 0, true);
        out[i * 3 + 1] = view.getFloat32(base + 4, true);
        out[i * 3 + 2] = view.getFloat32(base + 8, true);
    }
    return out;
}
/** Reads float32 VEC2 texture coordinates; returns null for any other encoding. */
function tryReadVec2FloatAccessor(json, buffers, accessorIndex, expectedCount) {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor || accessor.sparse || accessor.bufferView === undefined)
        return null;
    if (accessor.componentType !== 5126 || accessor.type !== "VEC2")
        return null;
    if (accessor.count !== expectedCount)
        return null;
    const { bytes, stride } = accessorView(json, buffers, accessorIndex);
    const out = new Float32Array(accessor.count * 2);
    const effectiveStride = stride || 8;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < accessor.count; ++i) {
        const base = i * effectiveStride;
        out[i * 2] = view.getFloat32(base, true);
        out[i * 2 + 1] = view.getFloat32(base + 4, true);
    }
    return out;
}
function readScalarIntAccessor(json, buffers, accessorIndex) {
    const { accessor, bytes, stride } = accessorView(json, buffers, accessorIndex);
    if (accessor.type !== "SCALAR")
        throw new Error("Index accessor must be SCALAR");
    const out = new Uint32Array(accessor.count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const componentSize = accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 1;
    const effectiveStride = stride || componentSize;
    for (let i = 0; i < accessor.count; ++i) {
        const base = i * effectiveStride;
        switch (accessor.componentType) {
            case 5121: // UNSIGNED_BYTE
                out[i] = view.getUint8(base);
                break;
            case 5123: // UNSIGNED_SHORT
                out[i] = view.getUint16(base, true);
                break;
            case 5125: // UNSIGNED_INT
                out[i] = view.getUint32(base, true);
                break;
            default:
                throw new Error(`Unsupported index componentType ${accessor.componentType}`);
        }
    }
    return out;
}
function concatFloat32(chunks) {
    if (chunks.length === 1)
        return chunks[0];
    let total = 0;
    for (const chunk of chunks)
        total += chunk.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
function concatUint32(chunks) {
    if (chunks.length === 1)
        return chunks[0];
    let total = 0;
    for (const chunk of chunks)
        total += chunk.length;
    const out = new Uint32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
