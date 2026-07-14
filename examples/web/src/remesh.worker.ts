import {
    decimateToTriangleBudget,
    ensureDecimatorReady,
    remesh,
    type RemeshOptions,
} from "@autoremesher/wasm";
// Vite emits a real asset URL. Pass it into the remesher so Emscripten's
// locateFile never invents a wrong/doubled path under the worker.
import wasmUrl from "../../../wasm/autoremesher.wasm?url";

interface RequestMessage {
    id: number;
    type: "remesh" | "decimate";
    vertices: Float32Array;
    indices: Uint32Array;
    options?: Pick<RemeshOptions, "targetQuads" | "adaptivity" | "modelType" | "sharpEdgeThreshold">;
    maxTriangles?: number;
}

let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function loadWasmBinary(): Promise<ArrayBuffer> {
    if (!wasmBinaryPromise) {
        wasmBinaryPromise = fetch(wasmUrl).then(async (response) => {
            if (!response.ok)
                throw new Error(`Failed to fetch WASM (${response.status}): ${wasmUrl}`);
            return response.arrayBuffer();
        });
        wasmBinaryPromise.catch(() => {
            wasmBinaryPromise = null;
        });
    }
    return wasmBinaryPromise;
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
    const { id, type, vertices, indices, options } = event.data;
    try {
        if (type === "decimate") {
            if (!event.data.maxTriangles || event.data.maxTriangles < 1)
                throw new Error("Choose a valid polygon target.");
            const fromTris = indices.length / 3;
            const budget = event.data.maxTriangles;
            self.postMessage({
                id,
                type: "progress",
                progress: 0.08,
                status: `Loading simplifier (${fromTris.toLocaleString()} tris)…`,
            });
            await ensureDecimatorReady();
            self.postMessage({
                id,
                type: "progress",
                progress: 0.25,
                status: `Edge-collapse → ${budget.toLocaleString()} tris…`,
            });
            const reduced = decimateToTriangleBudget(vertices, indices, budget);
            const pct = reduced.fromTriangles > 0
                ? Math.round((1 - reduced.toTriangles / reduced.fromTriangles) * 100)
                : 0;
            self.postMessage({
                id,
                type: "progress",
                progress: 1,
                status: `Done (−${pct}%, ${reduced.method})`,
            });
            const transfer: Transferable[] = [
                reduced.vertices.buffer,
                reduced.indices.buffer,
            ];
            self.postMessage({
                id,
                type: "decimated",
                result: {
                    vertices: reduced.vertices,
                    indices: reduced.indices,
                    fromTriangles: reduced.fromTriangles,
                    toTriangles: reduced.toTriangles,
                    method: reduced.method,
                },
            }, { transfer });
            return;
        }

        if (!options)
            throw new Error("Missing remesh options.");

        self.postMessage({ id, type: "progress", progress: 0.02, status: "Loading WASM…" });
        const wasmBinary = await loadWasmBinary();

        const result = await remesh(
            { vertices, indices },
            {
                ...options,
                edgeScaling: 1,
                allowHoles: false,
                maxParts: 1,
                moduleOptions: {
                    threads: false,
                    wasmUrl,
                    wasmBinary,
                },
                onProgress: (progress, status) =>
                    self.postMessage({
                        id,
                        type: "progress",
                        // Reserve 0–5% for asset load; map remesh onto 5–100%.
                        progress: 0.05 + progress * 0.95,
                        status,
                    }),
            }
        );
        const transfer: Transferable[] = [
            result.vertices.buffer,
            result.indices.buffer,
            result.quads.buffer,
        ];
        if (result.normals)
            transfer.push(result.normals.buffer);
        self.postMessage({ id, type: "done", result }, { transfer });
    } catch (error) {
        self.postMessage({
            id,
            type: "error",
            message: error instanceof Error ? error.message : String(error),
        });
    }
};
