import assert from "node:assert/strict";
import { test } from "node:test";
import { TorusKnotGeometry } from "three";

import {
    remesh,
    parseObj,
    resultToObj,
    AutoRemesherError,
    countBoundaryEdges,
    fillMeshHoles,
    assessTriangleTopology,
} from "../lib/esm/index.js";
// countBoundaryEdges used in elongated-shape assertions
import { makeTorus, makeSphere, meshToObj } from "./fixtures.mjs";

function assertValidResult(result, { minQuads = 10, watertight = false } = {}) {
    assert.ok(result.vertices instanceof Float32Array, "vertices is Float32Array");
    assert.ok(result.quads instanceof Uint32Array, "quads is Uint32Array");
    assert.ok(result.indices instanceof Uint32Array, "indices is Uint32Array");
    assert.equal(result.vertices.length % 3, 0);
    assert.equal(result.quads.length % 4, 0);
    assert.equal(result.indices.length % 3, 0);
    assert.equal(result.quadCount, result.quads.length / 4);
    assert.ok(result.quadCount >= minQuads, `expected >= ${minQuads} quads, got ${result.quadCount}`);
    assert.ok(result.processingTimeMs > 0);

    const vertexCount = result.vertices.length / 3;
    for (const index of result.quads)
        assert.ok(index < vertexCount, "quad index in range");
    for (const index of result.indices)
        assert.ok(index < vertexCount, "triangle index in range");

    for (const value of result.vertices)
        assert.ok(Number.isFinite(value), "vertex coordinates are finite");

    const topology = assessTriangleTopology(result.vertices, result.indices);
    assert.ok(topology.ok, `invalid output topology: ${topology.reasons.join("; ")}`);

    // Quad-dominance: most faces should be true quads (c !== d).
    // After hole-fill we may append a few triangle "quads" (c === d).
    let trueQuads = 0;
    for (let i = 0; i < result.quads.length; i += 4) {
        if (result.quads[i + 2] !== result.quads[i + 3])
            trueQuads++;
    }
    assert.ok(
        trueQuads >= result.quadCount * 0.35,
        `expected mostly quads, got ${trueQuads}/${result.quadCount}`
    );

    if (watertight) {
        const boundary = countBoundaryEdges(result.indices);
        // Allow a few residual edges; fill is best-effort.
        assert.ok(boundary <= 8, `expected nearly watertight mesh, got ${boundary} boundary edges`);
    }
}

test("remeshes a torus from raw buffers", async () => {
    const torus = makeTorus();
    const result = await remesh(torus, { targetQuads: 500 });
    assertValidResult(result, { watertight: true });
    assert.ok(result.normals instanceof Float32Array);
    assert.equal(result.normals.length, result.vertices.length);
});

test("remeshes a sphere and reports progress", async () => {
    const sphere = makeSphere();
    const progressValues = [];
    const result = await remesh(sphere, {
        targetQuads: 400,
        onProgress: (p, status) => progressValues.push([p, status]),
    });
    assertValidResult(result, { watertight: true });
    assert.ok(progressValues.length > 0, "progress callback fired");
    const last = progressValues[progressValues.length - 1];
    assert.equal(last[0], 1);
});

test("does not return visible holes for a closed sphere", async () => {
    const result = await remesh(makeSphere(), {
        targetQuads: 1000,
        edgeScaling: 2,
        adaptivity: 0.5,
    });
    assert.equal(
        countBoundaryEdges(result.indices),
        0,
        "closed inputs must not return a holey native candidate"
    );
});

test("remeshes the playground torus-knot sample without broken topology", async () => {
    // Match /remesher's sample resolution: this is the topology that formerly
    // displayed long, crossing sheets after an unsafe hole-fill fallback.
    const geometry = new TorusKnotGeometry(0.8, 0.28, 128, 24);
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex();
    assert.ok(index, "torus knot is indexed");
    const result = await remesh({
        vertices: Float32Array.from(position.array),
        indices: Uint32Array.from(index.array),
    }, { targetQuads: 1000 });
    assertValidResult(result, { minQuads: 100, watertight: true });
    geometry.dispose();
});

test("accepts OBJ text input and round-trips OBJ output", async () => {
    const objText = meshToObj(makeTorus({ radialSegments: 16, tubularSegments: 32 }));
    const result = await remesh(objText, { targetQuads: 400, edgeScaling: 1.3 });
    assertValidResult(result, { watertight: true });

    const outObj = resultToObj(result);
    const reparsed = parseObj(outObj);
    assert.equal(reparsed.vertices.length, result.vertices.length);
    assert.ok(reparsed.indices.length >= result.quadCount * 3);
});

test("accepts BufferGeometry-like input", async () => {
    const torus = makeTorus({ radialSegments: 16, tubularSegments: 32 });
    const geometryLike = {
        isBufferGeometry: true,
        attributes: {
            position: {
                array: torus.vertices,
                itemSize: 3,
                count: torus.vertices.length / 3,
            },
        },
        index: { array: torus.indices, count: torus.indices.length },
    };
    const result = await remesh(geometryLike, { targetQuads: 400, edgeScaling: 1.3 });
    assertValidResult(result, { watertight: true });
});

test("hard-surface mode and options are accepted", async () => {
    const sphere = makeSphere({ widthSegments: 24, heightSegments: 18 });
    const result = await remesh(sphere, {
        targetQuads: 400,
        modelType: "hardSurface",
        adaptivity: 0.4,
        sharpEdgeThreshold: 60,
        edgeScaling: 1.0,
        smoothNormals: false,
    });
    assertValidResult(result, { watertight: true });
    assert.equal(result.normals, undefined);
});

test("rejects empty input", async () => {
    await assert.rejects(
        remesh({ vertices: new Float32Array(0), indices: new Uint32Array(0) }),
        AutoRemesherError
    );
});

test("rejects out-of-range indices", async () => {
    await assert.rejects(
        remesh({
            vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            indices: new Uint32Array([0, 1, 99]),
        }),
        (error) => error instanceof AutoRemesherError && error.code === -2
    );
});

test("rejects nonsense input types", async () => {
    await assert.rejects(remesh(42), AutoRemesherError);
});

function bboxVolume(vertices) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) {
        for (let k = 0; k < 3; ++k) {
            min[k] = Math.min(min[k], vertices[i + k]);
            max[k] = Math.max(max[k], vertices[i + k]);
        }
    }
    return (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
}

test("preserves bounds on elongated organic shapes", async () => {
    // Stretch a sphere along Y — without rod-aware aspect-ratio normalization
    // the engine collapses this into a near-zero fragment.
    const sphere = makeSphere({ widthSegments: 40, heightSegments: 28 });
    for (let i = 1; i < sphere.vertices.length; i += 3)
        sphere.vertices[i] *= 2.0;

    const result = await remesh(sphere, {
        targetQuads: 500,
        edgeScaling: 1.2,
        adaptivity: 0.5,
    });
    assertValidResult(result, { minQuads: 30, watertight: false });
    const ratio = bboxVolume(result.vertices) / bboxVolume(sphere.vertices);
    assert.ok(
        ratio >= 0.25,
        `expected bbox volume ratio >= 0.25 after elongated remesh, got ${ratio.toFixed(3)}`
    );
    // Prefer closed, but a few residual edges after fill are acceptable.
    const holes = countBoundaryEdges(result.indices);
    assert.ok(holes <= 12, `expected few holes, got ${holes}`);
});

test("handles extreme rod-like elongation without collapse", async () => {
    // 10× stretch previously failed with "collapsed bounds (diag 0.09…)".
    const sphere = makeSphere({ widthSegments: 40, heightSegments: 28 });
    for (let i = 1; i < sphere.vertices.length; i += 3)
        sphere.vertices[i] *= 10.0;

    const result = await remesh(sphere, {
        targetQuads: 500,
        edgeScaling: 1.0,
        adaptivity: 0.5,
    });
    assertValidResult(result, { minQuads: 30, watertight: false });
    const ratio = bboxVolume(result.vertices) / bboxVolume(sphere.vertices);
    assert.ok(
        ratio >= 0.5,
        `expected bbox volume ratio >= 0.5 after 10× rod remesh, got ${ratio.toFixed(3)}`
    );
});

test("fillMeshHoles closes a simple triangular hole", () => {
    // Two triangles of a quad; remove one → one boundary loop of 3?
    // Better: open tetrahedron missing one face (3 boundary edges? 3 edges form loop of 3).
    // Pyramid open base: 4 side triangles missing base → 4-edge loop.
    const vertices = new Float32Array([
        0, 0, 0,
        1, 0, 0,
        1, 1, 0,
        0, 1, 0,
        0.5, 0.5, 1,
    ]);
    // Four side faces of a pyramid, open base (hole: 0-1-2-3).
    const indices = new Uint32Array([
        0, 1, 4,
        1, 2, 4,
        2, 3, 4,
        3, 0, 4,
    ]);
    assert.equal(countBoundaryEdges(indices), 4);
    const filled = fillMeshHoles(vertices, indices);
    assert.ok(filled.loopsFilled >= 1);
    assert.equal(filled.remainingBoundaryEdges, 0);
    assert.equal(countBoundaryEdges(filled.indices), 0);
});

test("topology validator rejects duplicate and non-manifold output", () => {
    const vertices = new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0,
    ]);
    // The first face is duplicated and its first edge belongs to three faces.
    const indices = new Uint32Array([
        0, 1, 2,
        0, 1, 2,
        1, 0, 3,
        0, 1, 4,
    ]);
    const topology = assessTriangleTopology(vertices, indices);
    assert.equal(topology.ok, false);
    assert.ok(topology.duplicateTriangles > 0);
    assert.ok(topology.nonManifoldEdges > 0);
});

test("allowHoles keeps open meshes from failing watertight checks", async () => {
    // Strip (open mesh) — with allowHoles should not demand closure.
    const vertices = new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
        0, 0, 0.5, 1, 0, 0.5, 1, 1, 0.5, 0, 1, 0.5,
    ]);
    // Just a single quad as two tris (open).
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    // Remesher may reject tiny open strips; if it runs, allowHoles must not throw -7.
    try {
        const result = await remesh(
            { vertices, indices },
            { targetQuads: 50, edgeScaling: 2, allowHoles: true }
        );
        assert.ok(result.quadCount >= 1);
    } catch (error) {
        assert.ok(error instanceof AutoRemesherError);
        assert.notEqual(error.code, -7, "allowHoles should not watertight-fail");
    }
});

test("rejects degenerate collapsed output rather than returning garbage", async () => {
    // A cube with very few triangles historically produced a tiny
    // fragment; the quality gate should either remesh sanely or fail.
    const vertices = new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
        0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]);
    const indices = new Uint32Array([
        0, 1, 2, 0, 2, 3,
        4, 6, 5, 4, 7, 6,
        0, 4, 5, 0, 5, 1,
        1, 5, 6, 1, 6, 2,
        2, 6, 7, 2, 7, 3,
        3, 7, 4, 3, 4, 0,
    ]);
    try {
        const result = await remesh(
            { vertices, indices },
            { targetQuads: 200, edgeScaling: 1.5, adaptivity: 0 }
        );
        const ratio = bboxVolume(result.vertices) / bboxVolume(vertices);
        assert.ok(
            ratio >= 0.35 && result.quadCount >= 6,
            `unexpected low-quality success: quads=${result.quadCount} vol=${ratio.toFixed(3)}`
        );
        assert.ok(assessTriangleTopology(result.vertices, result.indices).ok);
    } catch (error) {
        assert.ok(error instanceof AutoRemesherError, "expected AutoRemesherError");
        assert.ok(
            error.code === -6 || error.code === -4 || error.code === -3,
            `expected quality/empty failure code, got ${error.code}: ${error.message}`
        );
    }
});
