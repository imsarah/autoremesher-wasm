import assert from "node:assert/strict";
import { test } from "node:test";

import { parseObj, parseGlb } from "../lib/esm/index.js";
import { makeTorus, meshToObj } from "./fixtures.mjs";

test("parseObj handles polygons, comments, and negative indices", () => {
    const obj = [
        "# comment",
        "v 0 0 0",
        "v 1 0 0",
        "v 1 1 0",
        "v 0 1 0",
        "vn 0 0 1",
        "f 1/1/1 2/2/1 3/3/1 4/4/1", // quad -> 2 triangles
        "f -4 -3 -2",                 // negative indices
        "",
    ].join("\n");
    const parsed = parseObj(obj);
    assert.equal(parsed.vertices.length, 12);
    assert.equal(parsed.indices.length, 9);
    assert.deepEqual(Array.from(parsed.indices.slice(6)), [0, 1, 2]);
});

test("parseGlb extracts positions and indices", () => {
    const torus = makeTorus({ radialSegments: 8, tubularSegments: 12 });
    const glb = buildGlb(torus);
    const parsed = parseGlb(glb);
    assert.equal(parsed.vertices.length, torus.vertices.length);
    assert.deepEqual(Array.from(parsed.indices), Array.from(torus.indices));
});

test("CJS entry point loads", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const cjs = require("../lib/cjs/index.js");
    assert.equal(typeof cjs.remesh, "function");
    assert.equal(typeof cjs.parseObj, "function");
    // Exercise the CJS glue loader end-to-end.
    const objText = meshToObj(makeTorus({ radialSegments: 16, tubularSegments: 32 }));
    const result = await cjs.remesh(objText, { targetQuads: 300 });
    assert.ok(result.quadCount > 0);
});

/** Builds a minimal valid GLB from a raw mesh. */
function buildGlb({ vertices, indices }) {
    const positionBytes = new Uint8Array(vertices.buffer.slice(0));
    const indexBytes = new Uint8Array(indices.buffer.slice(0));
    const binLength = positionBytes.length + indexBytes.length;

    const json = {
        asset: { version: "2.0" },
        buffers: [{ byteLength: binLength }],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positionBytes.length },
            { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length },
        ],
        accessors: [
            { bufferView: 0, componentType: 5126, count: vertices.length / 3, type: "VEC3" },
            { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    };

    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
    if (jsonPadding) {
        const padded = new Uint8Array(jsonBytes.length + jsonPadding);
        padded.set(jsonBytes);
        padded.fill(0x20, jsonBytes.length);
        jsonBytes = padded;
    }
    const binPadding = (4 - (binLength % 4)) % 4;

    const total = 12 + 8 + jsonBytes.length + 8 + binLength + binPadding;
    const glb = new Uint8Array(total);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    let offset = 12;
    view.setUint32(offset, jsonBytes.length, true);
    view.setUint32(offset + 4, 0x4e4f534a, true);
    glb.set(jsonBytes, offset + 8);
    offset += 8 + jsonBytes.length;
    view.setUint32(offset, binLength + binPadding, true);
    view.setUint32(offset + 4, 0x004e4942, true);
    glb.set(positionBytes, offset + 8);
    glb.set(indexBytes, offset + 8 + positionBytes.length);
    return glb;
}
