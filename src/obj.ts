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

export function parseObj(text: string): ParsedObj {
    const vertices: number[] = [];
    const indices: number[] = [];
    const rawUvs: number[] = [];
    /** vertexUv[v] = index into rawUvs (per-corner mapping, last wins). */
    const vertexUv: number[] = [];
    let sawUv = false;

    const length = text.length;
    let lineStart = 0;
    while (lineStart < length) {
        let lineEnd = text.indexOf("\n", lineStart);
        if (lineEnd === -1)
            lineEnd = length;
        const c0 = text.charCodeAt(lineStart);
        const c1 = text.charCodeAt(lineStart + 1);
        if (c0 === 118 /* v */ && c1 === 32) {
            const parts = text.slice(lineStart + 2, lineEnd).trim().split(/\s+/);
            vertices.push(
                parseFloat(parts[0]),
                parseFloat(parts[1]),
                parseFloat(parts[2])
            );
        } else if (c0 === 118 /* v */ && c1 === 116 /* t */) {
            const parts = text.slice(lineStart + 3, lineEnd).trim().split(/\s+/);
            rawUvs.push(parseFloat(parts[0]), parseFloat(parts[1] ?? "0"));
        } else if (c0 === 102 /* f */ && c1 === 32) {
            const parts = text.slice(lineStart + 2, lineEnd).trim().split(/\s+/);
            const vertexCountSoFar = vertices.length / 3;
            const uvCountSoFar = rawUvs.length / 2;
            const face: number[] = [];
            for (const part of parts) {
                if (!part)
                    continue;
                const firstSlash = part.indexOf("/");
                const rawV = parseInt(firstSlash === -1 ? part : part.slice(0, firstSlash), 10);
                if (Number.isNaN(rawV))
                    continue;
                // OBJ indices are 1-based; negative counts from the end.
                const v = rawV > 0 ? rawV - 1 : vertexCountSoFar + rawV;
                face.push(v);
                if (firstSlash !== -1) {
                    const secondSlash = part.indexOf("/", firstSlash + 1);
                    const uvToken = secondSlash === -1
                        ? part.slice(firstSlash + 1)
                        : part.slice(firstSlash + 1, secondSlash);
                    if (uvToken) {
                        const rawT = parseInt(uvToken, 10);
                        if (!Number.isNaN(rawT)) {
                            vertexUv[v] = rawT > 0 ? rawT - 1 : uvCountSoFar + rawT;
                            sawUv = true;
                        }
                    }
                }
            }
            for (let i = 2; i < face.length; ++i)
                indices.push(face[0], face[i - 1], face[i]);
        }
        lineStart = lineEnd + 1;
    }

    if (vertices.length === 0 || indices.length === 0)
        throw new Error("OBJ input contains no triangles");

    const parsed: ParsedObj = {
        vertices: Float32Array.from(vertices),
        indices: Uint32Array.from(indices),
    };
    if (sawUv && rawUvs.length > 0) {
        const uvs = new Float32Array((vertices.length / 3) * 2);
        for (let v = 0; v < vertices.length / 3; ++v) {
            const t = vertexUv[v];
            if (t !== undefined && t * 2 + 1 < rawUvs.length) {
                uvs[v * 2] = rawUvs[t * 2];
                uvs[v * 2 + 1] = rawUvs[t * 2 + 1];
            }
        }
        parsed.uvs = uvs;
    }
    return parsed;
}

/**
 * Serializes a remeshed result to OBJ text with native quad faces
 * (triangles are written as 3-index faces). Includes vt records when
 * the result carries UVs.
 */
export function resultToObj(result: RemeshedResult): string {
    const chunks: string[] = [];
    const v = result.vertices;
    for (let i = 0; i < v.length; i += 3)
        chunks.push(`v ${v[i]} ${v[i + 1]} ${v[i + 2]}`);

    const uv = result.uvs;
    const writeUvs = uv !== undefined && uv.length === (v.length / 3) * 2;
    if (writeUvs) {
        for (let i = 0; i < uv.length; i += 2)
            chunks.push(`vt ${uv[i]} ${uv[i + 1]}`);
    }

    const face = (index: number) =>
        writeUvs ? `${index + 1}/${index + 1}` : `${index + 1}`;

    const q = result.quads;
    for (let i = 0; i < q.length; i += 4) {
        const a = q[i];
        const b = q[i + 1];
        const c = q[i + 2];
        const d = q[i + 3];
        chunks.push(c === d
            ? `f ${face(a)} ${face(b)} ${face(c)}`
            : `f ${face(a)} ${face(b)} ${face(c)} ${face(d)}`);
    }
    chunks.push("");
    return chunks.join("\n");
}
