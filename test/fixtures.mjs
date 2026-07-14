/**
 * Programmatic test meshes (no binary fixtures in the repo).
 */

/** Indexed torus mesh, similar to THREE.TorusGeometry. */
export function makeTorus({
    radius = 1.0,
    tube = 0.4,
    radialSegments = 24,
    tubularSegments = 48,
} = {}) {
    const vertices = [];
    const indices = [];

    for (let j = 0; j <= radialSegments; j++) {
        for (let i = 0; i <= tubularSegments; i++) {
            const u = (i / tubularSegments) * Math.PI * 2;
            const v = (j / radialSegments) * Math.PI * 2;
            vertices.push(
                (radius + tube * Math.cos(v)) * Math.cos(u),
                (radius + tube * Math.cos(v)) * Math.sin(u),
                tube * Math.sin(v)
            );
        }
    }
    for (let j = 1; j <= radialSegments; j++) {
        for (let i = 1; i <= tubularSegments; i++) {
            const a = (tubularSegments + 1) * j + i - 1;
            const b = (tubularSegments + 1) * (j - 1) + i - 1;
            const c = (tubularSegments + 1) * (j - 1) + i;
            const d = (tubularSegments + 1) * j + i;
            indices.push(a, b, d, b, c, d);
        }
    }

    return {
        vertices: Float32Array.from(vertices),
        indices: Uint32Array.from(indices),
    };
}

/** UV sphere mesh (includes spherical texture coordinates). */
export function makeSphere({ radius = 1.0, widthSegments = 32, heightSegments = 24 } = {}) {
    const vertices = [];
    const indices = [];
    const uvs = [];

    for (let y = 0; y <= heightSegments; y++) {
        const v = y / heightSegments;
        const phi = v * Math.PI;
        for (let x = 0; x <= widthSegments; x++) {
            const u = x / widthSegments;
            const theta = u * Math.PI * 2;
            vertices.push(
                -radius * Math.cos(theta) * Math.sin(phi),
                radius * Math.cos(phi),
                radius * Math.sin(theta) * Math.sin(phi)
            );
            uvs.push(u, 1 - v);
        }
    }
    for (let y = 0; y < heightSegments; y++) {
        for (let x = 0; x < widthSegments; x++) {
            const a = y * (widthSegments + 1) + x + 1;
            const b = y * (widthSegments + 1) + x;
            const c = (y + 1) * (widthSegments + 1) + x;
            const d = (y + 1) * (widthSegments + 1) + x + 1;
            if (y !== 0)
                indices.push(a, b, d);
            if (y !== heightSegments - 1)
                indices.push(b, c, d);
        }
    }

    return {
        vertices: Float32Array.from(vertices),
        indices: Uint32Array.from(indices),
        uvs: Float32Array.from(uvs),
    };
}

/** Serializes a raw mesh to OBJ text (triangles). */
export function meshToObj({ vertices, indices }) {
    const lines = [];
    for (let i = 0; i < vertices.length; i += 3)
        lines.push(`v ${vertices[i]} ${vertices[i + 1]} ${vertices[i + 2]}`);
    for (let i = 0; i < indices.length; i += 3)
        lines.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`);
    lines.push("");
    return lines.join("\n");
}
