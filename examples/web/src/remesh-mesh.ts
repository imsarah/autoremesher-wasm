import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

export interface MeshData {
    vertices: Float32Array;
    indices: Uint32Array;
}

export const ACCEPTED_FILES = ".glb,.gltf,.fbx,.obj,.stl";

/**
 * Sample torus knot (closed organic curve). Indexed topology is preserved
 * for the source wireframe preview.
 */
export function makeTorusKnotSample(): MeshData {
    const geometry = new THREE.TorusKnotGeometry(0.5, 0.16, 128, 24);
    try {
        return geometryToMeshPreserveTopology(geometry);
    } finally {
        geometry.dispose();
    }
}

/** Default playground sample. */
export function makeSample(): MeshData {
    return makeTorusKnotSample();
}

export async function readMeshFile(file: File): Promise<MeshData> {
    const name = file.name.toLowerCase();
    const data = await file.arrayBuffer();
    let geometries: THREE.BufferGeometry[] = [];

    if (name.endsWith(".glb") || name.endsWith(".gltf")) {
        const gltf = await new GLTFLoader().parseAsync(data, "");
        geometries = collectGeometries(gltf.scene);
    } else if (name.endsWith(".fbx")) {
        geometries = collectGeometries(new FBXLoader().parse(data, ""));
    } else if (name.endsWith(".obj")) {
        geometries = collectGeometries(new OBJLoader().parse(new TextDecoder().decode(data)));
    } else if (name.endsWith(".stl")) {
        geometries = [new STLLoader().parse(data)];
    } else {
        throw new Error("Choose a .glb, .gltf, .fbx, .obj, or .stl file.");
    }

    if (geometries.length === 0)
        throw new Error("The file does not contain a mesh.");

    const merged = mergeGeometries(geometries);
    const mesh = geometryToMesh(merged);
    merged.dispose();
    for (const geometry of geometries)
        geometry.dispose();
    return mesh;
}

export function normalizeMesh(mesh: MeshData): MeshData {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.vertices.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], mesh.vertices[i + axis]);
            max[axis] = Math.max(max[axis], mesh.vertices[i + axis]);
        }
    }
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    if (!(size > 0) || !Number.isFinite(size))
        return mesh;

    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const vertices = new Float32Array(mesh.vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
        vertices[i] = ((mesh.vertices[i] - center[0]) / size) * 2;
        vertices[i + 1] = ((mesh.vertices[i + 1] - center[1]) / size) * 2;
        vertices[i + 2] = ((mesh.vertices[i + 2] - center[2]) / size) * 2;
    }
    return { vertices, indices: mesh.indices };
}

export function geometryToMesh(geometry: THREE.BufferGeometry): MeshData {
    const position = geometry.getAttribute("position");
    if (!position)
        throw new Error("The mesh has no positions.");
    const index = geometry.getIndex();
    const sourceCount = index?.count ?? position.count;
    const vertices: number[] = [];
    const remap = new Uint32Array(position.count);
    const lookup = new Map<string, number>();

    for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
        let next = lookup.get(key);
        if (next === undefined) {
            next = vertices.length / 3;
            lookup.set(key, next);
            vertices.push(x, y, z);
        }
        remap[i] = next;
    }

    const indices: number[] = [];
    for (let i = 0; i < sourceCount; i += 3) {
        const a = remap[index ? index.getX(i) : i];
        const b = remap[index ? index.getX(i + 1) : i + 1];
        const c = remap[index ? index.getX(i + 2) : i + 2];
        if (a === b || b === c || a === c)
            continue;
        indices.push(a, b, c);
    }
    if (indices.length === 0)
        throw new Error("The mesh has no non-degenerate triangles.");
    return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

/** Copy an indexed BufferGeometry exactly, including render-only seam/pole vertices. */
export function geometryToMeshPreserveTopology(geometry: THREE.BufferGeometry): MeshData {
    const position = geometry.getAttribute("position");
    if (!position)
        throw new Error("The mesh has no positions.");
    const vertices = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
        vertices[i * 3] = position.getX(i);
        vertices[i * 3 + 1] = position.getY(i);
        vertices[i * 3 + 2] = position.getZ(i);
    }
    const index = geometry.getIndex();
    const indices = index
        ? Uint32Array.from({ length: index.count }, (_, i) => index.getX(i))
        : Uint32Array.from({ length: position.count }, (_, i) => i);
    return { vertices, indices };
}

/** Remove zero-area faces before native processing without changing the preview source. */
export function prepareMeshForRemesh(mesh: MeshData): MeshData {
    const kept: number[] = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = mesh.indices[i] * 3;
        const b = mesh.indices[i + 1] * 3;
        const c = mesh.indices[i + 2] * 3;
        const abx = mesh.vertices[b] - mesh.vertices[a];
        const aby = mesh.vertices[b + 1] - mesh.vertices[a + 1];
        const abz = mesh.vertices[b + 2] - mesh.vertices[a + 2];
        const acx = mesh.vertices[c] - mesh.vertices[a];
        const acy = mesh.vertices[c + 1] - mesh.vertices[a + 1];
        const acz = mesh.vertices[c + 2] - mesh.vertices[a + 2];
        const crossX = aby * acz - abz * acy;
        const crossY = abz * acx - abx * acz;
        const crossZ = abx * acy - aby * acx;
        if (crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-18)
            kept.push(mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]);
    }
    return kept.length === mesh.indices.length
        ? mesh
        : { vertices: mesh.vertices, indices: Uint32Array.from(kept) };
}

function collectGeometries(root: THREE.Object3D): THREE.BufferGeometry[] {
    const result: THREE.BufferGeometry[] = [];
    root.updateMatrixWorld(true);
    root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry)
            return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
        result.push(geometry);
    });
    return result;
}

function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const vertexCount = geometries.reduce((sum, geometry) =>
        sum + geometry.getAttribute("position").count, 0);
    const indexCount = geometries.reduce((sum, geometry) => {
        const position = geometry.getAttribute("position");
        return sum + (geometry.getIndex()?.count ?? position.count);
    }, 0);
    const positions = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;

    for (const geometry of geometries) {
        const position = geometry.getAttribute("position");
        for (let i = 0; i < position.count; i++) {
            positions[(vertexOffset + i) * 3] = position.getX(i);
            positions[(vertexOffset + i) * 3 + 1] = position.getY(i);
            positions[(vertexOffset + i) * 3 + 2] = position.getZ(i);
        }
        const index = geometry.getIndex();
        const count = index?.count ?? position.count;
        for (let i = 0; i < count; i++)
            indices[indexOffset + i] = (index ? index.getX(i) : i) + vertexOffset;
        vertexOffset += position.count;
        indexOffset += count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
    return merged;
}
