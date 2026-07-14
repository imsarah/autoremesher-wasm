"use strict";
/**
 * Geometry helpers: quad -> triangle conversion, normals, and mesh
 * pre/post-processing used by remesh().
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.quadsToTriangles = quadsToTriangles;
exports.pairTriangleFacesIntoQuads = pairTriangleFacesIntoQuads;
exports.computeVertexNormals = computeVertexNormals;
exports.meshBoundingBox = meshBoundingBox;
exports.boundingBoxVolume = boundingBoxVolume;
exports.boundingBoxDiagonal = boundingBoxDiagonal;
exports.meshSurfaceArea = meshSurfaceArea;
exports.weldVerticesByPosition = weldVerticesByPosition;
exports.sanitizeTriangleIndices = sanitizeTriangleIndices;
exports.countBoundaryEdges = countBoundaryEdges;
exports.assessTriangleTopology = assessTriangleTopology;
exports.extractConnectedShells = extractConnectedShells;
exports.extractManifoldShells = extractManifoldShells;
exports.makeFaceWindingConsistent = makeFaceWindingConsistent;
exports.selectLargestShells = selectLargestShells;
exports.ensureDecimatorReady = ensureDecimatorReady;
exports.decimateToTriangleBudget = decimateToTriangleBudget;
exports.aspectRatioNormalize = aspectRatioNormalize;
exports.aspectRatioRestore = aspectRatioRestore;
exports.assessRemeshQuality = assessRemeshQuality;
exports.fillMeshHoles = fillMeshHoles;
exports.appendTriangleQuads = appendTriangleQuads;
exports.clampTargetTriangleCount = clampTargetTriangleCount;
const meshoptimizer_1 = require("meshoptimizer");
/**
 * Converts a quad index buffer (4 indices per face, triangles encoded
 * with the last index repeated) into a triangle index buffer.
 */
function quadsToTriangles(quads) {
    let triangleCount = 0;
    for (let i = 0; i < quads.length; i += 4)
        triangleCount += quads[i + 2] === quads[i + 3] ? 1 : 2;
    const out = new Uint32Array(triangleCount * 3);
    let o = 0;
    for (let i = 0; i < quads.length; i += 4) {
        const a = quads[i];
        const b = quads[i + 1];
        const c = quads[i + 2];
        const d = quads[i + 3];
        out[o++] = a;
        out[o++] = b;
        out[o++] = c;
        if (c !== d) {
            out[o++] = a;
            out[o++] = c;
            out[o++] = d;
        }
    }
    return out;
}
/**
 * Reconstructs quad faces from adjacent source triangles without moving a
 * single vertex. It is a last-resort, topology-safe fallback when the native
 * field extractor cannot close a mesh: clean CAD/primitive grids still get a
 * valid quad representation instead of a corrupt cap across the surface.
 */
function pairTriangleFacesIntoQuads(indices) {
    const edgeToFace = new Map();
    const faceCount = indices.length / 3;
    for (let face = 0; face < faceCount; ++face) {
        const offset = face * 3;
        for (let edge = 0; edge < 3; ++edge) {
            const a = indices[offset + edge];
            const b = indices[offset + ((edge + 1) % 3)];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            const refs = edgeToFace.get(key) ?? [];
            refs.push({ face, a, b });
            edgeToFace.set(key, refs);
        }
    }
    const pairedWith = new Int32Array(faceCount);
    pairedWith.fill(-1);
    const quads = [];
    for (const refs of edgeToFace.values()) {
        if (refs.length !== 2)
            continue;
        const [first, second] = refs;
        if (pairedWith[first.face] !== -1 || pairedWith[second.face] !== -1)
            continue;
        const firstOffset = first.face * 3;
        const firstTriangle = [indices[firstOffset], indices[firstOffset + 1], indices[firstOffset + 2]];
        const outerFirst = firstTriangle.find((v) => v !== first.a && v !== first.b);
        const secondOffset = second.face * 3;
        const secondTriangle = [indices[secondOffset], indices[secondOffset + 1], indices[secondOffset + 2]];
        const outerSecond = secondTriangle.find((v) => v !== first.a && v !== first.b);
        if (outerFirst === undefined || outerSecond === undefined || outerFirst === outerSecond)
            continue;
        // Preserve the first triangle's winding in the resulting boundary
        // cycle. The native triangle index buffer remains the render surface,
        // so this never changes the source geometry.
        const outerIndex = firstTriangle.indexOf(outerFirst);
        const next = firstTriangle[(outerIndex + 1) % 3];
        const previous = firstTriangle[(outerIndex + 2) % 3];
        quads.push(outerFirst, next, outerSecond, previous);
        pairedWith[first.face] = second.face;
        pairedWith[second.face] = first.face;
    }
    for (let face = 0; face < faceCount; ++face) {
        if (pairedWith[face] !== -1)
            continue;
        const offset = face * 3;
        quads.push(indices[offset], indices[offset + 1], indices[offset + 2], indices[offset + 2]);
    }
    return Uint32Array.from(quads);
}
/**
 * Area-weighted smooth vertex normals from a triangulated mesh.
 */
function computeVertexNormals(vertices, indices) {
    const normals = new Float32Array(vertices.length);
    for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i] * 3;
        const ib = indices[i + 1] * 3;
        const ic = indices[i + 2] * 3;
        const abx = vertices[ib] - vertices[ia];
        const aby = vertices[ib + 1] - vertices[ia + 1];
        const abz = vertices[ib + 2] - vertices[ia + 2];
        const acx = vertices[ic] - vertices[ia];
        const acy = vertices[ic + 1] - vertices[ia + 1];
        const acz = vertices[ic + 2] - vertices[ia + 2];
        // Cross product magnitude is proportional to triangle area,
        // giving area weighting for free.
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        normals[ia] += nx;
        normals[ia + 1] += ny;
        normals[ia + 2] += nz;
        normals[ib] += nx;
        normals[ib + 1] += ny;
        normals[ib + 2] += nz;
        normals[ic] += nx;
        normals[ic + 1] += ny;
        normals[ic + 2] += nz;
    }
    for (let i = 0; i < normals.length; i += 3) {
        const x = normals[i];
        const y = normals[i + 1];
        const z = normals[i + 2];
        const length = Math.sqrt(x * x + y * y + z * z);
        if (length > 0) {
            normals[i] = x / length;
            normals[i + 1] = y / length;
            normals[i + 2] = z / length;
        }
    }
    return normals;
}
/** Axis-aligned bounding box of xyz triples. */
function meshBoundingBox(vertices) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) {
        for (let k = 0; k < 3; ++k) {
            const value = vertices[i + k];
            if (value < min[k])
                min[k] = value;
            if (value > max[k])
                max[k] = value;
        }
    }
    return { min, max };
}
/** Bounding-box volume (0 if the mesh is empty or flat on any axis). */
function boundingBoxVolume(box) {
    const dx = box.max[0] - box.min[0];
    const dy = box.max[1] - box.min[1];
    const dz = box.max[2] - box.min[2];
    if (!(dx > 0) || !(dy > 0) || !(dz > 0))
        return 0;
    return dx * dy * dz;
}
/** Bounding-box diagonal length. */
function boundingBoxDiagonal(box) {
    const dx = box.max[0] - box.min[0];
    const dy = box.max[1] - box.min[1];
    const dz = box.max[2] - box.min[2];
    return Math.hypot(dx, dy, dz);
}
/** Surface area of a triangle mesh. */
function meshSurfaceArea(vertices, indices) {
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i] * 3;
        const ib = indices[i + 1] * 3;
        const ic = indices[i + 2] * 3;
        const abx = vertices[ib] - vertices[ia];
        const aby = vertices[ib + 1] - vertices[ia + 1];
        const abz = vertices[ib + 2] - vertices[ia + 2];
        const acx = vertices[ic] - vertices[ia];
        const acy = vertices[ic + 1] - vertices[ia + 1];
        const acz = vertices[ic + 2] - vertices[ia + 2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        area += 0.5 * Math.hypot(nx, ny, nz);
    }
    return area;
}
/**
 * Merge vertices that share the same position (within a grid). Render
 * meshes often duplicate verts at UV/normal seams; without welding,
 * AutoRemesher splits the surface into many manifold islands and
 * remeshes only a strip — which looks "ugly" or collapsed.
 */
function weldVerticesByPosition(vertices, indices, quantize = 1e5) {
    const weldedFrom = vertices.length / 3;
    const keyToNew = new Map();
    const newVerts = [];
    const remap = new Uint32Array(weldedFrom);
    for (let i = 0; i < weldedFrom; ++i) {
        const x = vertices[i * 3];
        const y = vertices[i * 3 + 1];
        const z = vertices[i * 3 + 2];
        const key = `${Math.round(x * quantize)},${Math.round(y * quantize)},${Math.round(z * quantize)}`;
        let id = keyToNew.get(key);
        if (id === undefined) {
            id = newVerts.length / 3;
            keyToNew.set(key, id);
            newVerts.push(x, y, z);
        }
        remap[i] = id;
    }
    const newIndices = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; ++i)
        newIndices[i] = remap[indices[i]];
    const cleaned = sanitizeTriangleIndices(Float32Array.from(newVerts), newIndices);
    return {
        vertices: Float32Array.from(newVerts),
        indices: cleaned.indices,
        weldedFrom,
    };
}
/**
 * Drops degenerate triangles (repeated indices or near-zero area).
 * Returns a new index buffer; vertices are left unchanged.
 */
function sanitizeTriangleIndices(vertices, indices, areaEpsilon = 1e-18) {
    const kept = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        if (a === b || b === c || a === c)
            continue;
        const ia = a * 3;
        const ib = b * 3;
        const ic = c * 3;
        if (ia + 2 >= vertices.length
            || ib + 2 >= vertices.length
            || ic + 2 >= vertices.length)
            continue;
        const abx = vertices[ib] - vertices[ia];
        const aby = vertices[ib + 1] - vertices[ia + 1];
        const abz = vertices[ib + 2] - vertices[ia + 2];
        const acx = vertices[ic] - vertices[ia];
        const acy = vertices[ic + 1] - vertices[ia + 1];
        const acz = vertices[ic + 2] - vertices[ia + 2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        if (nx * nx + ny * ny + nz * nz <= areaEpsilon)
            continue;
        kept.push(a, b, c);
    }
    const removed = (indices.length - kept.length) / 3;
    return {
        indices: kept.length === indices.length ? indices : Uint32Array.from(kept),
        removed,
    };
}
/**
 * Counts boundary edges (used by exactly one triangle). Useful as a
 * cheap closedness proxy for quality checks.
 */
function countBoundaryEdges(indices) {
    const edges = new Map();
    for (let i = 0; i < indices.length; i += 3) {
        const tri = [indices[i], indices[i + 1], indices[i + 2]];
        for (let e = 0; e < 3; ++e) {
            const a = tri[e];
            const b = tri[(e + 1) % 3];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    let boundary = 0;
    for (const count of edges.values()) {
        if (count === 1)
            boundary++;
    }
    return boundary;
}
/**
 * Checks the actual triangles rendered by the browser. Boundary edges are
 * reported separately because intentionally open meshes may allow them.
 */
function assessTriangleTopology(vertices, indices) {
    const vertexCount = vertices.length / 3;
    const edges = new Map();
    const faces = new Set();
    let duplicateTriangles = 0;
    let degenerateTriangles = 0;
    let invalidIndices = 0;
    const diagonal = Math.max(1e-12, boundingBoxDiagonal(meshBoundingBox(vertices)));
    const minDoubleAreaSquared = diagonal ** 4 * 1e-20;
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
            invalidIndices++;
            continue;
        }
        if (a === b || b === c || a === c) {
            degenerateTriangles++;
            continue;
        }
        const ia = a * 3, ib = b * 3, ic = c * 3;
        const abx = vertices[ib] - vertices[ia];
        const aby = vertices[ib + 1] - vertices[ia + 1];
        const abz = vertices[ib + 2] - vertices[ia + 2];
        const acx = vertices[ic] - vertices[ia];
        const acy = vertices[ic + 1] - vertices[ia + 1];
        const acz = vertices[ic + 2] - vertices[ia + 2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        if (nx * nx + ny * ny + nz * nz <= minDoubleAreaSquared) {
            degenerateTriangles++;
            continue;
        }
        const face = [a, b, c].sort((x, y) => x - y);
        const faceKey = `${face[0]},${face[1]},${face[2]}`;
        if (faces.has(faceKey))
            duplicateTriangles++;
        else
            faces.add(faceKey);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const edgeKey = u < v ? `${u},${v}` : `${v},${u}`;
            edges.set(edgeKey, (edges.get(edgeKey) ?? 0) + 1);
        }
    }
    let boundaryEdges = 0;
    let nonManifoldEdges = 0;
    for (const useCount of edges.values()) {
        if (useCount === 1)
            boundaryEdges++;
        else if (useCount !== 2)
            nonManifoldEdges++;
    }
    const reasons = [];
    if (invalidIndices > 0)
        reasons.push(`${invalidIndices} out-of-range triangle indices`);
    if (degenerateTriangles > 0)
        reasons.push(`${degenerateTriangles} degenerate triangles`);
    if (duplicateTriangles > 0)
        reasons.push(`${duplicateTriangles} duplicate triangles`);
    if (nonManifoldEdges > 0)
        reasons.push(`${nonManifoldEdges} non-manifold edges`);
    return { ok: reasons.length === 0, boundaryEdges, nonManifoldEdges, duplicateTriangles, degenerateTriangles, invalidIndices, reasons };
}
/**
 * Face-connected components via undirected edge adjacency (loose "pieces").
 */
function extractConnectedShells(indices) {
    return extractShellsByAdjacency(indices, /* manifoldOnly */ false);
}
/**
 * Face-connected components matching AutoRemesher's C++ MeshSeparator:
 * two faces are connected only if they share an edge with **opposite**
 * winding (a→b on one face, b→a on the other). Inconsistent winding or
 * non-manifold edges split islands — that is what produces
 * "Island 43: mixed-integer solve" even when the mesh looks like one object.
 */
function extractManifoldShells(indices) {
    return extractShellsByAdjacency(indices, /* manifoldOnly */ true);
}
function extractShellsByAdjacency(indices, manifoldOnly) {
    const faceCount = indices.length / 3;
    if (faceCount === 0)
        return [];
    const adjacency = Array.from({ length: faceCount }, () => []);
    if (manifoldOnly) {
        // directed edge a→b → face index (same as MeshSeparator::buildEdgeToFaceMap)
        const directed = new Map();
        for (let f = 0; f < faceCount; ++f) {
            const base = f * 3;
            for (let e = 0; e < 3; ++e) {
                const a = indices[base + e];
                const b = indices[base + ((e + 1) % 3)];
                if (a === b)
                    continue;
                directed.set(`${a},${b}`, f);
            }
        }
        for (let f = 0; f < faceCount; ++f) {
            const base = f * 3;
            for (let e = 0; e < 3; ++e) {
                const a = indices[base + e];
                const b = indices[base + ((e + 1) % 3)];
                const opposite = directed.get(`${b},${a}`);
                if (opposite !== undefined && opposite !== f)
                    adjacency[f].push(opposite);
            }
        }
    }
    else {
        const edgeFaces = new Map();
        for (let f = 0; f < faceCount; ++f) {
            const base = f * 3;
            for (let e = 0; e < 3; ++e) {
                const a = indices[base + e];
                const b = indices[base + ((e + 1) % 3)];
                if (a === b)
                    continue;
                const key = a < b ? `${a},${b}` : `${b},${a}`;
                const list = edgeFaces.get(key);
                if (list)
                    list.push(f);
                else
                    edgeFaces.set(key, [f]);
            }
        }
        for (const faces of edgeFaces.values()) {
            for (let i = 0; i < faces.length; ++i) {
                for (let j = i + 1; j < faces.length; ++j) {
                    adjacency[faces[i]].push(faces[j]);
                    adjacency[faces[j]].push(faces[i]);
                }
            }
        }
    }
    const visited = new Uint8Array(faceCount);
    const shells = [];
    for (let seed = 0; seed < faceCount; ++seed) {
        if (visited[seed])
            continue;
        const shell = [];
        const stack = [seed];
        visited[seed] = 1;
        while (stack.length > 0) {
            const f = stack.pop();
            shell.push(f);
            for (const n of adjacency[f]) {
                if (!visited[n]) {
                    visited[n] = 1;
                    stack.push(n);
                }
            }
        }
        shells.push(shell);
    }
    shells.sort((a, b) => b.length - a.length);
    return shells;
}
/**
 * Flip triangle windings so adjacent faces use opposite edge directions
 * wherever they share an undirected edge. Merges many of C++'s "islands"
 * that only exist because of inconsistent normals/winding in exports.
 * Returns a new index buffer (does not mutate the input).
 */
function makeFaceWindingConsistent(indices) {
    const faceCount = indices.length / 3;
    if (faceCount === 0)
        return indices;
    const out = new Uint32Array(indices);
    const flipFace = (f) => {
        const i = f * 3;
        const tmp = out[i];
        out[i] = out[i + 1];
        out[i + 1] = tmp;
    };
    /** +1 if face has directed edge u→v, -1 if v→u, else 0. */
    const edgeSign = (f, u, v) => {
        const base = f * 3;
        for (let e = 0; e < 3; ++e) {
            const a = out[base + e];
            const b = out[base + ((e + 1) % 3)];
            if (a === u && b === v)
                return 1;
            if (a === v && b === u)
                return -1;
        }
        return 0;
    };
    const edgeFaces = new Map();
    for (let f = 0; f < faceCount; ++f) {
        const base = f * 3;
        for (let e = 0; e < 3; ++e) {
            const a = out[base + e];
            const b = out[base + ((e + 1) % 3)];
            if (a === b)
                continue;
            const u = a < b ? a : b;
            const v = a < b ? b : a;
            const key = `${u},${v}`;
            const list = edgeFaces.get(key);
            const link = { face: f, u, v };
            if (list)
                list.push(link);
            else
                edgeFaces.set(key, [link]);
        }
    }
    const neighbors = Array.from({ length: faceCount }, () => []);
    for (const links of edgeFaces.values()) {
        for (let i = 0; i < links.length; ++i) {
            for (let j = i + 1; j < links.length; ++j) {
                neighbors[links[i].face].push({
                    face: links[j].face,
                    u: links[i].u,
                    v: links[i].v,
                });
                neighbors[links[j].face].push({
                    face: links[i].face,
                    u: links[i].u,
                    v: links[i].v,
                });
            }
        }
    }
    const visited = new Uint8Array(faceCount);
    for (let seed = 0; seed < faceCount; ++seed) {
        if (visited[seed])
            continue;
        const queue = [seed];
        visited[seed] = 1;
        for (let qi = 0; qi < queue.length; ++qi) {
            const f = queue[qi];
            for (const { face: g, u, v } of neighbors[f]) {
                // Orient each face exactly once. The previous implementation
                // flipped already-visited faces every time another neighbor
                // referenced them; on a closed mesh that makes the final
                // winding depend on traversal order and can create the long
                // crossing sheets seen in the playground.
                if (visited[g])
                    continue;
                const sf = edgeSign(f, u, v);
                const sg = edgeSign(g, u, v);
                // Adjacent faces must traverse their shared edge in opposite
                // directions. Same direction means the unvisited face needs
                // one flip before it is added to the queue.
                if (sf !== 0 && sg !== 0 && sf === sg)
                    flipFace(g);
                visited[g] = 1;
                queue.push(g);
            }
        }
    }
    return out;
}
/**
 * Prepares a mesh for AutoRemesher:
 * 1) make face windings consistent
 * 2) split with the same manifold rules as C++ MeshSeparator
 * 3) keep only the largest shell(s)
 *
 * Without (1)+(2), a single "object" can still become Island 1…43 in WASM.
 */
function selectLargestShells(vertices, indices, options = {}) {
    const minPartTriangles = options.minPartTriangles ?? 32;
    const maxParts = options.maxParts ?? 1;
    const consistent = makeFaceWindingConsistent(indices);
    const flippedForWinding = !indexBuffersEqual(indices, consistent);
    // Prefer manifold islands (matches native). Fall back to undirected
    // if winding still leaves everything fragmented into dust.
    let shells = extractManifoldShells(consistent);
    let manifoldIslands = shells.length;
    const largestManifold = shells[0]?.length ?? 0;
    if (shells.length > 1 && largestManifold < (consistent.length / 3) * 0.5) {
        // Still badly fragmented after winding fix — keep largest manifold
        // piece anyway (better than processing 43 MIQ solves).
    }
    const totalShells = shells.length;
    const totalTriangles = consistent.length / 3;
    const eligible = shells.filter((s) => s.length >= minPartTriangles);
    const kept = eligible.slice(0, Math.max(1, maxParts));
    if (kept.length === 0 && shells.length > 0)
        kept.push(shells[0]);
    const keptFaceSet = new Set();
    for (const shell of kept) {
        for (const f of shell)
            keptFaceSet.add(f);
    }
    const keptTriangles = keptFaceSet.size;
    const droppedTriangles = totalTriangles - keptTriangles;
    const droppedShells = totalShells - kept.length;
    const oldToNew = new Map();
    const newVerts = [];
    const newIndices = [];
    const mapVertex = (old) => {
        let mapped = oldToNew.get(old);
        if (mapped === undefined) {
            mapped = newVerts.length / 3;
            oldToNew.set(old, mapped);
            const o = old * 3;
            newVerts.push(vertices[o], vertices[o + 1], vertices[o + 2]);
        }
        return mapped;
    };
    // Emit faces in a stable order; winding already fixed in `consistent`.
    const sortedFaces = [...keptFaceSet].sort((a, b) => a - b);
    for (const f of sortedFaces) {
        const base = f * 3;
        newIndices.push(mapVertex(consistent[base]), mapVertex(consistent[base + 1]), mapVertex(consistent[base + 2]));
    }
    // After compacting, re-run winding once more so the single shell is clean.
    const compactedIndices = makeFaceWindingConsistent(Uint32Array.from(newIndices));
    return {
        vertices: Float32Array.from(newVerts),
        indices: compactedIndices,
        totalShells,
        manifoldIslands,
        keptShells: kept.length,
        droppedShells,
        keptTriangles,
        droppedTriangles,
        flippedForWinding,
    };
}
function indexBuffersEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; ++i) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
let decimatorReadyPromise = null;
/**
 * Wait for meshoptimizer WASM (edge-collapse simplifier). Call once before
 * the first {@link decimateToTriangleBudget} in an async path (remesh /
 * playground pre-decimate).
 */
function ensureDecimatorReady() {
    if (!decimatorReadyPromise) {
        decimatorReadyPromise = meshoptimizer_1.MeshoptSimplifier.ready.then(() => undefined);
    }
    return decimatorReadyPromise;
}
function compactIndexedMesh(vertices, indices) {
    const used = new Map();
    const nv = [];
    const ni = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; ++i) {
        const old = indices[i];
        let id = used.get(old);
        if (id === undefined) {
            id = nv.length / 3;
            used.set(old, id);
            nv.push(vertices[old * 3], vertices[old * 3 + 1], vertices[old * 3 + 2]);
        }
        ni[i] = id;
    }
    return { vertices: Float32Array.from(nv), indices: ni };
}
/**
 * High-quality edge-collapse simplify via meshoptimizer. Preserves shape
 * on closed surfaces (sphere/torus) far better than grid clustering.
 */
function decimateWithMeshopt(vertices, indices, maxTriangles) {
    if (!meshoptimizer_1.MeshoptSimplifier.supported)
        return null;
    const targetIndexCount = Math.max(3, Math.floor(maxTriangles) * 3);
    const hasSloppy = typeof meshoptimizer_1.MeshoptSimplifier.simplifySloppy
        === "function";
    // Prefer topology-preserving collapse. Raise error tolerance if we
    // cannot reach the budget (meshopt treats target as soft under a
    // tight error cap). Only use sloppy when available (meshopt ≥1.x).
    const attempts = [
        { error: 0.01, sloppy: false },
        { error: 0.05, sloppy: false },
        { error: 0.15, sloppy: false },
        { error: 0.5, sloppy: false },
        { error: 1.0, sloppy: false },
    ];
    if (hasSloppy) {
        attempts.push({ error: 0.25, sloppy: true }, { error: 1.0, sloppy: true });
    }
    let best = null;
    let bestCount = Infinity;
    for (const { error, sloppy } of attempts) {
        try {
            // Copy indices — meshopt may rewrite the buffer in place.
            const src = indices.slice();
            let outIdx;
            if (sloppy) {
                const result = meshoptimizer_1.MeshoptSimplifier.simplifySloppy(src, vertices, 3, null, targetIndexCount, error);
                outIdx = result[0];
            }
            else {
                const result = meshoptimizer_1.MeshoptSimplifier.simplify(src, vertices, 3, targetIndexCount, error);
                outIdx = result[0];
            }
            if (!outIdx || outIdx.length < 3)
                continue;
            const triCount = outIdx.length / 3;
            if (triCount > 0 && triCount < bestCount) {
                best = outIdx;
                bestCount = triCount;
            }
            if (triCount > 0 && triCount <= maxTriangles * 1.05)
                break;
        }
        catch {
            // try next / fall back
        }
    }
    if (!best || bestCount >= indices.length / 3)
        return null;
    const compacted = compactIndexedMesh(vertices, best);
    const cleaned = sanitizeTriangleIndices(compacted.vertices, compacted.indices);
    if (cleaned.indices.length < 3)
        return null;
    // sanitize may drop degenerates without remapping verts — compact again.
    return compactIndexedMesh(compacted.vertices, cleaned.indices);
}
/**
 * Grid-cluster fallback. Fast but can dent smooth surfaces (sphere) and
 * open small holes. Only used when meshopt is unavailable or fails.
 */
function decimateWithGridCluster(vertices, indices, maxTriangles) {
    const fromTriangles = indices.length / 3;
    const box = meshBoundingBox(vertices);
    const diag = Math.max(1e-12, boundingBoxDiagonal(box));
    const targetVerts = Math.max(150, Math.floor(maxTriangles * 0.55));
    let cell = diag / Math.max(8, Math.ceil(Math.sqrt(targetVerts)));
    let bestVerts = null;
    let bestIndices = null;
    let bestCount = Infinity;
    for (let attempt = 0; attempt < 24; ++attempt) {
        const sums = new Map();
        const remap = new Uint32Array(vertices.length / 3);
        let nextId = 0;
        for (let i = 0; i < remap.length; ++i) {
            const o = i * 3;
            const x = vertices[o];
            const y = vertices[o + 1];
            const z = vertices[o + 2];
            const ix = Math.floor((x - box.min[0]) / cell);
            const iy = Math.floor((y - box.min[1]) / cell);
            const iz = Math.floor((z - box.min[2]) / cell);
            const key = `${ix},${iy},${iz}`;
            let bucket = sums.get(key);
            if (!bucket) {
                bucket = { x: 0, y: 0, z: 0, n: 0, id: nextId++ };
                sums.set(key, bucket);
            }
            bucket.x += x;
            bucket.y += y;
            bucket.z += z;
            bucket.n += 1;
            remap[i] = bucket.id;
        }
        const newVerts = new Float32Array(nextId * 3);
        for (const bucket of sums.values()) {
            const i = bucket.id * 3;
            // Average then lightly push back toward original surface shell
            // by renormalizing toward the cell's mean radius from bbox center
            // — reduces "dented sphere" from pure vertex averaging.
            newVerts[i] = bucket.x / bucket.n;
            newVerts[i + 1] = bucket.y / bucket.n;
            newVerts[i + 2] = bucket.z / bucket.n;
        }
        // Reproject clustered verts toward average radius from center (helps spheres).
        const center = [
            (box.min[0] + box.max[0]) * 0.5,
            (box.min[1] + box.max[1]) * 0.5,
            (box.min[2] + box.max[2]) * 0.5,
        ];
        let avgR = 0;
        let nR = 0;
        for (let i = 0; i < newVerts.length; i += 3) {
            const dx = newVerts[i] - center[0];
            const dy = newVerts[i + 1] - center[1];
            const dz = newVerts[i + 2] - center[2];
            const r = Math.hypot(dx, dy, dz);
            if (r > 1e-12) {
                avgR += r;
                nR++;
            }
        }
        if (nR > 0) {
            avgR /= nR;
            // Only reproject when the shape is fairly sphere-like (radii similar).
            let varR = 0;
            for (let i = 0; i < newVerts.length; i += 3) {
                const r = Math.hypot(newVerts[i] - center[0], newVerts[i + 1] - center[1], newVerts[i + 2] - center[2]);
                varR += (r - avgR) * (r - avgR);
            }
            const std = Math.sqrt(varR / nR);
            if (std / avgR < 0.12) {
                for (let i = 0; i < newVerts.length; i += 3) {
                    const dx = newVerts[i] - center[0];
                    const dy = newVerts[i + 1] - center[1];
                    const dz = newVerts[i + 2] - center[2];
                    const r = Math.hypot(dx, dy, dz);
                    if (r > 1e-12) {
                        const s = avgR / r;
                        newVerts[i] = center[0] + dx * s;
                        newVerts[i + 1] = center[1] + dy * s;
                        newVerts[i + 2] = center[2] + dz * s;
                    }
                }
            }
        }
        const faces = [];
        const faceKeys = new Set();
        for (let i = 0; i < indices.length; i += 3) {
            const a = remap[indices[i]];
            const b = remap[indices[i + 1]];
            const c = remap[indices[i + 2]];
            if (a === b || b === c || a === c)
                continue;
            const s0 = Math.min(a, b, c);
            const s2 = Math.max(a, b, c);
            const s1 = a + b + c - s0 - s2;
            const fk = `${s0},${s1},${s2}`;
            if (faceKeys.has(fk))
                continue;
            faceKeys.add(fk);
            faces.push(a, b, c);
        }
        const triCount = faces.length / 3;
        if (triCount > 0 && triCount < bestCount) {
            bestVerts = newVerts;
            bestIndices = Uint32Array.from(faces);
            bestCount = triCount;
        }
        if (triCount > 0 && triCount <= maxTriangles)
            break;
        cell *= 1.25;
        if (cell > diag)
            break;
    }
    if (!bestIndices || bestCount > maxTriangles) {
        const step = Math.max(1, Math.ceil(fromTriangles / maxTriangles));
        const faces = [];
        for (let f = 0; f < fromTriangles; f += step) {
            const i = f * 3;
            faces.push(indices[i], indices[i + 1], indices[i + 2]);
        }
        const cleaned = sanitizeTriangleIndices(vertices, Uint32Array.from(faces));
        const compacted = compactIndexedMesh(vertices, cleaned.indices);
        return {
            vertices: compacted.vertices,
            indices: compacted.indices,
            fromTriangles,
            toTriangles: compacted.indices.length / 3,
        };
    }
    const cleaned = sanitizeTriangleIndices(bestVerts, bestIndices);
    if (cleaned.indices.length < 3) {
        const step = Math.max(1, Math.ceil(fromTriangles / Math.max(100, maxTriangles)));
        const faces = [];
        for (let f = 0; f < fromTriangles; f += step) {
            const i = f * 3;
            faces.push(indices[i], indices[i + 1], indices[i + 2]);
        }
        return {
            vertices,
            indices: Uint32Array.from(faces),
            fromTriangles,
            toTriangles: faces.length / 3,
        };
    }
    const compacted = compactIndexedMesh(bestVerts, cleaned.indices);
    return {
        vertices: compacted.vertices,
        indices: compacted.indices,
        fromTriangles,
        toTriangles: compacted.indices.length / 3,
    };
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
function decimateToTriangleBudget(vertices, indices, maxTriangles) {
    const fromTriangles = indices.length / 3;
    if (!(maxTriangles > 0) || fromTriangles <= maxTriangles) {
        return {
            vertices,
            indices,
            reduced: false,
            fromTriangles,
            toTriangles: fromTriangles,
            method: "none",
        };
    }
    // Weld first so simplify sees a continuous surface (UV seams otherwise
    // look like open borders and meshopt locks / fails quality).
    const welded = weldVerticesByPosition(vertices, indices);
    const srcV = welded.vertices;
    const srcI = welded.indices;
    const srcTris = srcI.length / 3;
    if (srcTris <= maxTriangles) {
        // Weld alone got us under budget (no collapse needed).
        return {
            vertices: srcV,
            indices: srcI,
            reduced: srcTris < fromTriangles,
            fromTriangles,
            toTriangles: srcTris,
            method: srcTris < fromTriangles ? "meshopt" : "none",
        };
    }
    const meshopt = decimateWithMeshopt(srcV, srcI, maxTriangles);
    if (meshopt && meshopt.indices.length / 3 < srcTris) {
        // Keep largest piece if simplify fragmented the mesh.
        const shell = selectLargestShells(meshopt.vertices, meshopt.indices, {
            maxParts: 1,
            minPartTriangles: 16,
        });
        const outV = shell.keptTriangles > 0 ? shell.vertices : meshopt.vertices;
        const outI = shell.keptTriangles > 0 ? shell.indices : meshopt.indices;
        return {
            vertices: outV,
            indices: outI,
            reduced: true,
            fromTriangles,
            toTriangles: outI.length / 3,
            method: "meshopt",
        };
    }
    const grid = decimateWithGridCluster(srcV, srcI, maxTriangles);
    return {
        vertices: grid.vertices,
        indices: grid.indices,
        reduced: true,
        fromTriangles: grid.fromTriangles,
        toTriangles: grid.toTriangles,
        method: "grid",
    };
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
function aspectRatioNormalize(vertices, targetSize = 2, rodThreshold = 2.0) {
    const box = meshBoundingBox(vertices);
    const extents = [
        Math.max(1e-12, box.max[0] - box.min[0]),
        Math.max(1e-12, box.max[1] - box.min[1]),
        Math.max(1e-12, box.max[2] - box.min[2]),
    ];
    const center = [
        (box.min[0] + box.max[0]) * 0.5,
        (box.min[1] + box.max[1]) * 0.5,
        (box.min[2] + box.max[2]) * 0.5,
    ];
    const sorted = [extents[0], extents[1], extents[2]].sort((a, b) => a - b);
    const rodScore = sorted[2] / sorted[1];
    const useNonUniform = rodScore >= rodThreshold;
    const maxExtent = sorted[2];
    const scale = useNonUniform
        ? [targetSize / extents[0], targetSize / extents[1], targetSize / extents[2]]
        : [targetSize / maxExtent, targetSize / maxExtent, targetSize / maxExtent];
    const out = new Float32Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
        out[i] = (vertices[i] - center[0]) * scale[0];
        out[i + 1] = (vertices[i + 1] - center[1]) * scale[1];
        out[i + 2] = (vertices[i + 2] - center[2]) * scale[2];
    }
    return { vertices: out, center, scale, applied: useNonUniform };
}
/** Inverse of {@link aspectRatioNormalize}. */
function aspectRatioRestore(vertices, transform) {
    const { center, scale } = transform;
    const out = new Float32Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
        out[i] = vertices[i] / scale[0] + center[0];
        out[i + 1] = vertices[i + 1] / scale[1] + center[1];
        out[i + 2] = vertices[i + 2] / scale[2] + center[2];
    }
    return out;
}
/**
 * Cheap post-remesh health check. The native extractor sometimes
 * "succeeds" with a collapsed fragment (handful of quads, near-zero
 * bbox) or a mesh full of holes — treat that as a failure so the
 * wrapper can retry denser, fill holes, or error.
 */
function assessRemeshQuality(sourceVertices, resultVertices, resultIndices, quadCount, options = {}) {
    const reasons = [];
    const holeReasons = [];
    const sourceBox = meshBoundingBox(sourceVertices);
    const resultBox = meshBoundingBox(resultVertices);
    const sourceVolume = boundingBoxVolume(sourceBox);
    const resultVolume = boundingBoxVolume(resultBox);
    const bboxVolumeRatio = sourceVolume > 0 ? resultVolume / sourceVolume : 0;
    // Volume ratio cubes linear error (0.26³ ≈ 0.018) and is harsh on flat
    // meshes. Prefer diagonal + per-axis extent ratios.
    const sourceDiag = boundingBoxDiagonal(sourceBox);
    const resultDiag = boundingBoxDiagonal(resultBox);
    const diagonalRatio = sourceDiag > 0 ? resultDiag / sourceDiag : 0;
    let minAxisRatio = 1;
    for (let k = 0; k < 3; ++k) {
        const se = Math.max(1e-12, sourceBox.max[k] - sourceBox.min[k]);
        const re = Math.max(0, resultBox.max[k] - resultBox.min[k]);
        minAxisRatio = Math.min(minAxisRatio, re / se);
    }
    const boundaryEdges = countBoundaryEdges(resultIndices);
    if (quadCount < 8)
        reasons.push(`too few faces (${quadCount} quads)`);
    // Collapsed / deformed if the result no longer matches the input shape.
    // A sphere remeshed with too-high intermediate density often keeps a
    // reasonable diagonal (~0.6) but flattens one axis (min ~0.22) and
    // loses volume (~0.12) — that must fail so retries can recover.
    const collapsed = diagonalRatio < 0.5
        || minAxisRatio < 0.35
        || bboxVolumeRatio < 0.2
        || (bboxVolumeRatio < 0.45 && minAxisRatio < 0.55);
    if (collapsed) {
        reasons.push(`collapsed bounds (diag ${diagonalRatio.toFixed(2)}, `
            + `min-axis ${minAxisRatio.toFixed(2)}, vol ${bboxVolumeRatio.toFixed(3)})`);
    }
    // Finite coordinate check.
    for (let i = 0; i < resultVertices.length; ++i) {
        if (!Number.isFinite(resultVertices[i])) {
            reasons.push("non-finite vertex coordinates");
            break;
        }
    }
    if (options.requireWatertight && boundaryEdges > 0) {
        holeReasons.push(`mesh has holes (${boundaryEdges} boundary edges) — not enough quads to close the surface`);
    }
    const allReasons = reasons.concat(holeReasons);
    return {
        ok: allReasons.length === 0,
        hasHolesOnly: reasons.length === 0 && holeReasons.length > 0,
        bboxVolumeRatio,
        boundaryEdges,
        quadCount,
        reasons: allReasons,
    };
}
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
function fillMeshHoles(vertices, indices) {
    // Count undirected edges; boundary = used once. Remember solid direction.
    const edgeCount = new Map();
    const solidDirected = new Map();
    for (let t = 0; t < indices.length; t += 3) {
        const tri = [indices[t], indices[t + 1], indices[t + 2]];
        for (let e = 0; e < 3; ++e) {
            const a = tri[e];
            const b = tri[(e + 1) % 3];
            if (a === b)
                continue;
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
            solidDirected.set(key, [a, b]);
        }
    }
    // Hole half-edges = reverse of unique solid edges.
    const outgoing = new Map();
    let boundaryEdgeTotal = 0;
    for (const [key, count] of edgeCount) {
        if (count !== 1)
            continue;
        boundaryEdgeTotal++;
        const [a, b] = solidDirected.get(key);
        // Solid uses a→b; hole continues b→a.
        const list = outgoing.get(b);
        if (list)
            list.push(a);
        else
            outgoing.set(b, [a]);
    }
    if (boundaryEdgeTotal === 0) {
        return {
            indices,
            filledTriangles: new Uint32Array(0),
            loopsFilled: 0,
            remainingBoundaryEdges: 0,
        };
    }
    const takeNext = (from) => {
        const list = outgoing.get(from);
        if (!list || list.length === 0)
            return undefined;
        return list.shift();
    };
    const peekHas = (from) => {
        const list = outgoing.get(from);
        return !!list && list.length > 0;
    };
    // A recovery cap is appropriate for a pinhole, not a failed extraction
    // spanning a significant portion of the model.
    const mayRepair = boundaryEdgeTotal <= 48;
    const fillTris = [];
    let loopsFilled = 0;
    const starts = [...outgoing.keys()];
    for (const start of starts) {
        if (!peekHas(start))
            continue;
        const loop = [start];
        let current = start;
        const seenInLoop = new Set([start]);
        let closed = false;
        const maxSteps = boundaryEdgeTotal + 2;
        for (let step = 0; step < maxSteps; ++step) {
            const next = takeNext(current);
            if (next === undefined)
                break;
            if (next === start) {
                closed = true;
                break;
            }
            // Self-intersection of the walk — abort this loop, put edge back.
            if (seenInLoop.has(next)) {
                const list = outgoing.get(current) ?? [];
                list.unshift(next);
                outgoing.set(current, list);
                break;
            }
            loop.push(next);
            seenInLoop.add(next);
            current = next;
        }
        if (!closed || loop.length < 3 || !mayRepair || !isSafeFanHole(vertices, loop))
            continue;
        // Fan-triangulate the simple cycle (winding follows hole half-edges).
        for (let i = 1; i < loop.length - 1; ++i)
            fillTris.push(loop[0], loop[i], loop[i + 1]);
        loopsFilled++;
    }
    let merged = indices;
    if (fillTris.length > 0) {
        merged = new Uint32Array(indices.length + fillTris.length);
        merged.set(indices, 0);
        merged.set(fillTris, indices.length);
    }
    // Hole repair is deliberately transactional. A locally planar fan can
    // still overlap an existing triangle at a pole or at a non-manifold
    // junction. Never return a mesh that is "closed" only because the repair
    // introduced duplicate or non-manifold triangles.
    if (fillTris.length > 0) {
        const repairedTopology = assessTriangleTopology(vertices, merged);
        if (!repairedTopology.ok) {
            return {
                indices,
                filledTriangles: new Uint32Array(0),
                loopsFilled: 0,
                remainingBoundaryEdges: boundaryEdgeTotal,
            };
        }
    }
    const remaining = countBoundaryEdges(merged);
    return {
        indices: merged,
        filledTriangles: Uint32Array.from(fillTris),
        loopsFilled,
        remainingBoundaryEdges: remaining,
    };
}
/** True only for a small, locally planar loop where a fan is safe. */
function isSafeFanHole(vertices, loop) {
    if (loop.length > 16)
        return false;
    const first = loop[0] * 3;
    let nx = 0, ny = 0, nz = 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < loop.length; ++i) {
        const a = loop[i] * 3;
        const b = loop[(i + 1) % loop.length] * 3;
        const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
        const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
        nx += (ay - by) * (az + bz);
        ny += (az - bz) * (ax + bx);
        nz += (ax - bx) * (ay + by);
        cx += ax;
        cy += ay;
        cz += az;
    }
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12)
        return false;
    nx /= length;
    ny /= length;
    nz /= length;
    cx /= loop.length;
    cy /= loop.length;
    cz /= loop.length;
    const diagonal = Math.max(1e-12, boundingBoxDiagonal(meshBoundingBox(vertices)));
    const maxDistance = diagonal * 0.015;
    for (const vertex of loop) {
        const i = vertex * 3;
        const distance = Math.abs((vertices[i] - cx) * nx + (vertices[i + 1] - cy) * ny + (vertices[i + 2] - cz) * nz);
        if (distance > maxDistance)
            return false;
    }
    // Referencing first ensures TypeScript and readers both retain that this
    // predicate is about the original loop vertices, not a generated center.
    return Number.isFinite(vertices[first]);
}
/**
 * Appends triangle faces as repeated-last-index quads so exporters that
 * only look at `quads` stay in sync after hole filling.
 */
function appendTriangleQuads(quads, triangles) {
    if (triangles.length === 0)
        return quads;
    const out = new Uint32Array(quads.length + (triangles.length / 3) * 4);
    out.set(quads, 0);
    let o = quads.length;
    for (let i = 0; i < triangles.length; i += 3) {
        out[o++] = triangles[i];
        out[o++] = triangles[i + 1];
        out[o++] = triangles[i + 2];
        out[o++] = triangles[i + 2];
    }
    return out;
}
/**
 * Clamps the engine's targetTriangleCount so the derived voxel size
 * stays in a range where isotropic remesh + MIQ extraction is stable.
 * Very high targets relative to surface area produce tiny voxels and
 * empty/fragmented output on modest meshes.
 */
function clampTargetTriangleCount(requested, area, diagonal, inputTriangleCount) {
    if (!(area > 0) || !(diagonal > 0))
        return Math.max(100, Math.round(requested));
    // voxel = sqrt((area / target) / 0.433013)  (matches the C++ formula)
    // Keep voxels roughly in [diagonal/60, diagonal/8].
    const voxelFactor = 0.86602540378 * 0.5;
    const minVoxel = diagonal / 60;
    const maxVoxel = diagonal / 8;
    const maxTarget = Math.floor(area / (minVoxel * minVoxel * voxelFactor));
    const minTarget = Math.max(80, Math.floor(area / (maxVoxel * maxVoxel * voxelFactor)));
    // Soft densify ceiling — don't crush small clean meshes.
    const densifyCap = Math.min(20000, Math.max(inputTriangleCount * 4, 4000));
    let target = Math.round(requested);
    target = Math.min(target, maxTarget, densifyCap);
    target = Math.max(target, Math.min(minTarget, densifyCap));
    return Math.max(80, target);
}
