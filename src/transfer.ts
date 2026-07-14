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

interface BvhNode {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    /** Leaf: index into triangle order array; -1 for inner nodes. */
    start: number;
    count: number;
    left: number;
    right: number;
}

const LEAF_SIZE = 4;

class TriangleBvh {
    private readonly positions: Float32Array;
    private readonly indices: Uint32Array;
    private readonly order: Uint32Array;
    private readonly nodes: BvhNode[] = [];
    private readonly centroids: Float32Array;

    constructor(positions: Float32Array, indices: Uint32Array) {
        this.positions = positions;
        this.indices = indices;
        const triangleCount = indices.length / 3;
        this.order = new Uint32Array(triangleCount);
        for (let i = 0; i < triangleCount; ++i)
            this.order[i] = i;
        this.centroids = new Float32Array(triangleCount * 3);
        for (let t = 0; t < triangleCount; ++t) {
            const a = indices[t * 3] * 3;
            const b = indices[t * 3 + 1] * 3;
            const c = indices[t * 3 + 2] * 3;
            this.centroids[t * 3] = (positions[a] + positions[b] + positions[c]) / 3;
            this.centroids[t * 3 + 1] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
            this.centroids[t * 3 + 2] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
        }
        this.build(0, triangleCount);
    }

    private build(start: number, count: number): number {
        const nodeIndex = this.nodes.length;
        const node: BvhNode = {
            minX: Infinity, minY: Infinity, minZ: Infinity,
            maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
            start, count, left: -1, right: -1,
        };
        this.nodes.push(node);

        for (let i = start; i < start + count; ++i) {
            const t = this.order[i];
            for (let corner = 0; corner < 3; ++corner) {
                const v = this.indices[t * 3 + corner] * 3;
                const x = this.positions[v];
                const y = this.positions[v + 1];
                const z = this.positions[v + 2];
                if (x < node.minX) node.minX = x;
                if (y < node.minY) node.minY = y;
                if (z < node.minZ) node.minZ = z;
                if (x > node.maxX) node.maxX = x;
                if (y > node.maxY) node.maxY = y;
                if (z > node.maxZ) node.maxZ = z;
            }
        }

        if (count <= LEAF_SIZE)
            return nodeIndex;

        // Split at the median centroid along the widest axis.
        const spanX = node.maxX - node.minX;
        const spanY = node.maxY - node.minY;
        const spanZ = node.maxZ - node.minZ;
        const axis = spanX >= spanY && spanX >= spanZ ? 0 : spanY >= spanZ ? 1 : 2;

        const slice = Array.from(this.order.subarray(start, start + count));
        const centroids = this.centroids;
        slice.sort((ta, tb) => centroids[ta * 3 + axis] - centroids[tb * 3 + axis]);
        this.order.set(slice, start);

        const half = count >> 1;
        node.count = 0; // inner node
        node.left = this.build(start, half);
        node.right = this.build(start + half, count - half);
        return nodeIndex;
    }

    /**
     * Finds the closest point on the mesh to (px, py, pz).
     * Returns triangle index and barycentric weights.
     */
    closestPoint(px: number, py: number, pz: number): {
        triangle: number; u: number; v: number; w: number;
    } {
        let bestDistSq = Infinity;
        let bestTriangle = 0;
        let bestU = 1;
        let bestV = 0;
        let bestW = 0;

        const stack = [0];
        while (stack.length > 0) {
            const node = this.nodes[stack.pop()!];
            if (boxDistanceSq(node, px, py, pz) >= bestDistSq)
                continue;
            if (node.count > 0) {
                for (let i = node.start; i < node.start + node.count; ++i) {
                    const t = this.order[i];
                    const result = closestPointOnTriangle(
                        this.positions, this.indices, t, px, py, pz);
                    if (result.distSq < bestDistSq) {
                        bestDistSq = result.distSq;
                        bestTriangle = t;
                        bestU = result.u;
                        bestV = result.v;
                        bestW = result.w;
                    }
                }
            } else {
                // Visit the nearer child first for tighter pruning.
                const leftDist = boxDistanceSq(this.nodes[node.left], px, py, pz);
                const rightDist = boxDistanceSq(this.nodes[node.right], px, py, pz);
                if (leftDist < rightDist) {
                    stack.push(node.right, node.left);
                } else {
                    stack.push(node.left, node.right);
                }
            }
        }

        return { triangle: bestTriangle, u: bestU, v: bestV, w: bestW };
    }
}

function boxDistanceSq(node: BvhNode, x: number, y: number, z: number): number {
    const dx = x < node.minX ? node.minX - x : x > node.maxX ? x - node.maxX : 0;
    const dy = y < node.minY ? node.minY - y : y > node.maxY ? y - node.maxY : 0;
    const dz = z < node.minZ ? node.minZ - z : z > node.maxZ ? z - node.maxZ : 0;
    return dx * dx + dy * dy + dz * dz;
}

/** Ericson, "Real-Time Collision Detection", closest point on triangle. */
function closestPointOnTriangle(
    positions: Float32Array,
    indices: Uint32Array,
    triangle: number,
    px: number, py: number, pz: number
): { distSq: number; u: number; v: number; w: number } {
    const ia = indices[triangle * 3] * 3;
    const ib = indices[triangle * 3 + 1] * 3;
    const ic = indices[triangle * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;

    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0)
        return distanceResult(px, py, pz, ax, ay, az, 1, 0, 0);

    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3)
        return distanceResult(px, py, pz, bx, by, bz, 0, 1, 0);

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3);
        return distanceResult(px, py, pz,
            ax + abx * t, ay + aby * t, az + abz * t, 1 - t, t, 0);
    }

    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6)
        return distanceResult(px, py, pz, cx, cy, cz, 0, 0, 1);

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const t = d2 / (d2 - d6);
        return distanceResult(px, py, pz,
            ax + acx * t, ay + acy * t, az + acz * t, 1 - t, 0, t);
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return distanceResult(px, py, pz,
            bx + (cx - bx) * t, by + (cy - by) * t, bz + (cz - bz) * t, 0, 1 - t, t);
    }

    const denominator = 1 / (va + vb + vc);
    const v = vb * denominator;
    const w = vc * denominator;
    return distanceResult(px, py, pz,
        ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w,
        1 - v - w, v, w);
}

function distanceResult(
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number,
    u: number, v: number, w: number
): { distSq: number; u: number; v: number; w: number } {
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return { distSq: dx * dx + dy * dy + dz * dz, u, v, w };
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
export function transferAttribute(
    source: TransferSource,
    values: Float32Array,
    itemSize: number,
    targetPositions: Float32Array
): Float32Array {
    if (values.length < (source.vertices.length / 3) * itemSize)
        throw new Error("Attribute buffer is smaller than the source vertex count");

    const bvh = new TriangleBvh(source.vertices, source.indices);
    const targetCount = targetPositions.length / 3;
    const out = new Float32Array(targetCount * itemSize);

    for (let i = 0; i < targetCount; ++i) {
        const hit = bvh.closestPoint(
            targetPositions[i * 3],
            targetPositions[i * 3 + 1],
            targetPositions[i * 3 + 2]
        );
        const a = source.indices[hit.triangle * 3] * itemSize;
        const b = source.indices[hit.triangle * 3 + 1] * itemSize;
        const c = source.indices[hit.triangle * 3 + 2] * itemSize;
        for (let k = 0; k < itemSize; ++k) {
            out[i * itemSize + k] =
                values[a + k] * hit.u + values[b + k] * hit.v + values[c + k] * hit.w;
        }
    }
    return out;
}

/** Convenience wrapper: transfers 2-component UVs. */
export function transferUVs(
    source: TransferSource & { uvs: Float32Array },
    targetPositions: Float32Array
): Float32Array {
    return transferAttribute(source, source.uvs, 2, targetPositions);
}
