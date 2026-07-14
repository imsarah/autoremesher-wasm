import assert from "node:assert/strict";
import { test } from "node:test";

import {
    remesh,
    transferAttribute,
    threadsSupported,
    loadAutoRemesherModule,
} from "../lib/esm/index.js";
import { makeSphere, makeTorus } from "./fixtures.mjs";

test("transferAttribute reproduces a position-linear attribute", () => {
    const torus = makeTorus();
    // Attribute = linear function of position; closest-point sampling
    // with barycentric interpolation must reproduce it almost exactly
    // for query points on the surface itself.
    const vertexCount = torus.vertices.length / 3;
    const attribute = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; ++i) {
        attribute[i * 2] = 0.5 + 0.25 * torus.vertices[i * 3];
        attribute[i * 2 + 1] = 0.5 + 0.25 * torus.vertices[i * 3 + 1];
    }

    // Query at triangle midpoints (guaranteed on-surface, not just at vertices).
    const queryCount = 200;
    const queries = new Float32Array(queryCount * 3);
    for (let q = 0; q < queryCount; ++q) {
        const t = (q * 7) % (torus.indices.length / 3);
        for (let corner = 0; corner < 3; ++corner) {
            const v = torus.indices[t * 3 + corner] * 3;
            queries[q * 3] += torus.vertices[v] / 3;
            queries[q * 3 + 1] += torus.vertices[v + 1] / 3;
            queries[q * 3 + 2] += torus.vertices[v + 2] / 3;
        }
    }

    const out = transferAttribute(torus, attribute, 2, queries);
    for (let q = 0; q < queryCount; ++q) {
        const expectedU = 0.5 + 0.25 * queries[q * 3];
        const expectedV = 0.5 + 0.25 * queries[q * 3 + 1];
        assert.ok(Math.abs(out[q * 2] - expectedU) < 1e-4, `u mismatch at ${q}`);
        assert.ok(Math.abs(out[q * 2 + 1] - expectedV) < 1e-4, `v mismatch at ${q}`);
    }
});

test("remesh preserves UVs from raw input", async () => {
    const sphere = makeSphere();
    const result = await remesh(sphere, { targetQuads: 400 });

    assert.ok(result.uvs instanceof Float32Array, "result.uvs present");
    assert.equal(result.uvs.length, (result.vertices.length / 3) * 2);

    // The sphere's v coordinate is latitude: v = acos(y / r) mapped to
    // [0, 1] with v=1 at the north pole. Spot-check correlation.
    let checked = 0;
    for (let i = 0; i < result.vertices.length / 3; ++i) {
        const y = result.vertices[i * 3 + 1];
        const radius = Math.hypot(
            result.vertices[i * 3],
            result.vertices[i * 3 + 1],
            result.vertices[i * 3 + 2]
        );
        if (radius < 1e-6)
            continue;
        const expectedV = 1 - Math.acos(Math.max(-1, Math.min(1, y / radius))) / Math.PI;
        const v = result.uvs[i * 2 + 1];
        assert.ok(Math.abs(v - expectedV) < 0.08, `latitude uv off at vertex ${i}: ${v} vs ${expectedV}`);
        checked++;
    }
    assert.ok(checked > 100, "checked a meaningful number of vertices");
});

test("preserveUVs: false skips UV transfer", async () => {
    const sphere = makeSphere({ widthSegments: 24, heightSegments: 18 });
    const result = await remesh(sphere, { targetQuads: 300, preserveUVs: false });
    assert.equal(result.uvs, undefined);
});

test("threadsSupported reports a boolean", () => {
    assert.equal(typeof threadsSupported(), "boolean");
});

test("multi-threaded build remeshes when supported", { timeout: 120000 }, async (t) => {
    if (!threadsSupported()) {
        t.skip("SharedArrayBuffer/threads not available in this environment");
        return;
    }
    const module = await loadAutoRemesherModule({ threads: true });
    assert.ok(module, "MT module instantiated");

    const torus = makeTorus({ radialSegments: 24, tubularSegments: 48 });
    const result = await remesh(torus, {
        targetQuads: 500,
        moduleOptions: { threads: true },
    });
    assert.ok(result.quadCount > 100, `MT remesh produced ${result.quadCount} quads`);
    const vertexCount = result.vertices.length / 3;
    for (const index of result.quads)
        assert.ok(index < vertexCount);
});
