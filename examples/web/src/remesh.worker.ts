import {
    decimateToTriangleBudget,
    ensureDecimatorReady,
    remesh,
    type RemeshOptions,
} from "@autoremesher/wasm";

interface RequestMessage {
    id: number;
    type: "remesh" | "decimate";
    vertices: Float32Array;
    indices: Uint32Array;
    options?: Pick<RemeshOptions, "targetQuads" | "adaptivity" | "modelType" | "sharpEdgeThreshold">;
    maxTriangles?: number;
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
    const { id, type, vertices, indices, options } = event.data;
    try {
        if (type === "decimate") {
            if (!event.data.maxTriangles || event.data.maxTriangles < 1)
                throw new Error("Choose a valid polygon target.");
            self.postMessage({ id, type: "progress", progress: 0.05, status: "Preparing simplifier…" });
            await ensureDecimatorReady();
            self.postMessage({ id, type: "progress", progress: 0.2, status: "Reducing mesh…" });
            const reduced = decimateToTriangleBudget(vertices, indices, event.data.maxTriangles);
            self.postMessage({ id, type: "progress", progress: 1, status: "Pre-decimate complete" });
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
        const result = await remesh(
            { vertices, indices },
            {
                ...options,
                edgeScaling: 1,
                allowHoles: false,
                maxParts: 1,
                moduleOptions: { threads: false },
                onProgress: (progress, status) =>
                    self.postMessage({ id, type: "progress", progress, status }),
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
