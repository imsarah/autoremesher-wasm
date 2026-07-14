/**
 * @autoremesher/wasm — automatic quad remeshing in WebAssembly.
 *
 * Port of https://github.com/huxingyi/autoremesher (MIT) to the web.
 */

import {
    appendTriangleQuads,
    aspectRatioNormalize,
    aspectRatioRestore,
    assessRemeshQuality,
    assessTriangleTopology,
    boundingBoxDiagonal,
    clampTargetTriangleCount,
    computeVertexNormals,
    countBoundaryEdges,
    fillMeshHoles,
    meshBoundingBox,
    meshSurfaceArea,
    quadsToTriangles,
    sanitizeTriangleIndices,
    selectLargestShells,
    decimateToTriangleBudget,
    ensureDecimatorReady,
    weldVerticesByPosition,
} from "./geometry.js";
import { isGlb, parseGlb, parseGltfJson } from "./gltf.js";
import { loadAutoRemesherModule, runNativeRemesh } from "./module.js";
import { parseObj } from "./obj.js";
import { transferAttribute } from "./transfer.js";
import { AutoRemesherError } from "./types.js";
import type {
    BufferGeometryLike,
    RawMesh,
    RemeshInput,
    RemeshOptions,
    RemeshedResult,
} from "./types.js";

export { loadAutoRemesherModule, threadsSupported } from "./module.js";
export type { AutoRemesherWasmModule } from "./module.js";
export { transferAttribute, transferUVs } from "./transfer.js";
export type { TransferSource } from "./transfer.js";
export { parseObj, resultToObj } from "./obj.js";
export { parseGlb, parseGltfJson } from "./gltf.js";
export {
    quadsToTriangles,
    computeVertexNormals,
    sanitizeTriangleIndices,
    aspectRatioNormalize,
    aspectRatioRestore,
    assessRemeshQuality,
    assessTriangleTopology,
    countBoundaryEdges,
    fillMeshHoles,
    makeFaceWindingConsistent,
    pairTriangleFacesIntoQuads,
    extractConnectedShells,
    extractManifoldShells,
    selectLargestShells,
    decimateToTriangleBudget,
    ensureDecimatorReady,
    weldVerticesByPosition,
} from "./geometry.js";
export { AutoRemesherError } from "./types.js";
export type {
    BufferGeometryLike,
    ModelType,
    ModuleLoadOptions,
    RawMesh,
    RemeshInput,
    RemeshOptions,
    RemeshedResult,
} from "./types.js";

const DEFAULT_SHARP_EDGE_DEGREES = 90;

interface AttemptParams {
    scaling: number;
    adaptivity: number;
    target: number;
    /** Why this attempt exists (for progress / debugging). */
    label: string;
}

/**
 * Remeshes a triangle mesh into a quad-dominant mesh.
 *
 * Accepts raw vertex/index buffers, OBJ text, GLB/glTF data, or a
 * Three.js BufferGeometry. The heavy lifting runs synchronously inside
 * WASM — for interactive apps, call this from a Web Worker.
 *
 * By default, the pipeline retries denser settings and fills residual
 * boundary loops. If only a small, safe residual loop remains, the native
 * remesh is returned as `quality: "near-sealed"`; larger failures throw
 * instead of pretending that the source mesh was remeshed.
 */
export async function remesh(
    input: RemeshInput,
    options: RemeshOptions = {}
): Promise<RemeshedResult> {
    const normalized = normalizeInput(input);
    let { vertices, indices } = normalized;
    const sourceUvs = normalized.uvs;

    // Keep the original (pre-transform) mesh for UV transfer + quality.
    const sourceVertices = vertices;
    const sourceIndices = indices;

    if (vertices.length === 0 || vertices.length % 3 !== 0)
        throw new AutoRemesherError("vertices must contain xyz triples", -101);
    if (indices.length === 0 || indices.length % 3 !== 0)
        throw new AutoRemesherError("indices must contain triangles (3 per face)", -101);

    const vertexCount = vertices.length / 3;
    for (let i = 0; i < indices.length; ++i) {
        if (indices[i] >= vertexCount) {
            throw new AutoRemesherError("Triangle index out of range", -2);
        }
    }

    // Edge-collapse simplifier WASM (used if we need to pre-decimate).
    await ensureDecimatorReady();

    // Weld by position first: UV/normal seams otherwise become manifold
    // islands and remesh keeps only a strip (ugly/collapsed output).
    const welded = weldVerticesByPosition(vertices, indices);
    vertices = welded.vertices;
    indices = welded.indices;
    if (indices.length === 0)
        throw new AutoRemesherError("Mesh has no non-degenerate triangles", -101);
    if (welded.weldedFrom > vertices.length / 3) {
        options.onProgress?.(
            0.02,
            `Welded ${welded.weldedFrom.toLocaleString()} → ${(vertices.length / 3).toLocaleString()} verts`
        );
    }

    // Default: never return a holey mesh. Open shells must opt in with allowHoles.
    const requireWatertight = options.allowHoles !== true;

    const originalTriangleCount = indices.length / 3;
    // Only force-simplify truly large meshes. Samples (~1–5k) and small
    // uploads should remesh at full fidelity — over-simplifying is what
    // made sphere/torus look ugly.
    const defaultMaxInput = originalTriangleCount > 20000
        ? 10000
        : originalTriangleCount > 12000
            ? 12000
            : 50000; // effectively no cap for normal sample-sized meshes
    const maxInputTriangles = options.maxInputTriangles ?? defaultMaxInput;

    options.onProgress?.(0.03, `Checking density (${originalTriangleCount.toLocaleString()} tris)…`);
    if (originalTriangleCount > maxInputTriangles) {
        const decimated = decimateToTriangleBudget(vertices, indices, maxInputTriangles);
        if (decimated.reduced) {
            options.onProgress?.(
                0.05,
                `Simplified ${decimated.fromTriangles.toLocaleString()} → `
                    + `${decimated.toTriangles.toLocaleString()} tris for speed…`
            );
            vertices = decimated.vertices;
            indices = decimated.indices;
        }
        if (indices.length / 3 > maxInputTriangles) {
            const forced = decimateToTriangleBudget(vertices, indices, maxInputTriangles);
            vertices = forced.vertices;
            indices = forced.indices;
        }
        if (indices.length < 3)
            throw new AutoRemesherError("Mesh empty after density cap", -101);
    }

    // Topology cleanup: fix winding + keep largest manifold shell(s).
    // Safe on clean samples (single shell, no change).
    const maxParts = options.maxParts ?? 1;
    const minPartTriangles = options.minPartTriangles ?? 32;
    const shellPick = selectLargestShells(vertices, indices, {
        maxParts,
        minPartTriangles,
    });
    if (shellPick.keptTriangles === 0)
        throw new AutoRemesherError("No usable mesh shells after part filtering", -101);
    vertices = shellPick.vertices;
    indices = shellPick.indices;

    if (shellPick.manifoldIslands > 1 || shellPick.droppedShells > 0) {
        options.onProgress?.(
            0.06,
            `Topology: ${shellPick.manifoldIslands} islands → largest ${shellPick.keptShells} `
                + `(${shellPick.keptTriangles} tris`
                + (shellPick.droppedTriangles > 0
                    ? `, dropped ${shellPick.droppedTriangles}`
                    : "")
                + ")"
        );
    }

    // Only re-simplify if the kept shell is still huge.
    if (indices.length / 3 > maxInputTriangles) {
        const again = decimateToTriangleBudget(vertices, indices, maxInputTriangles);
        if (again.reduced) {
            options.onProgress?.(
                0.07,
                `Re-simplified shell ${again.fromTriangles.toLocaleString()} → `
                    + `${again.toTriangles.toLocaleString()} tris…`
            );
            vertices = again.vertices;
            indices = again.indices;
        }
    }

    const remeshSourceVertices = vertices;

    const transform = aspectRatioNormalize(vertices);
    vertices = transform.vertices;

    const wasmModule = await loadAutoRemesherModule(options.moduleOptions);

    const area = meshSurfaceArea(vertices, indices);
    const diagonal = boundingBoxDiagonal(meshBoundingBox(vertices));
    const inputTriangleCount = indices.length / 3;

    // Intermediate isotropic density feeds the MIQ solver. Rules (measured):
    // - intermediate ≈ full input on tiny meshes can collapse (sphere 1472→1472)
    // - intermediate too LOW on pre-decimated ~3k meshes yields only ~200 quads
    //   after holey dense attempts are discarded
    // Sweet spot: ~70–85% of input for already-small meshes; never densify past input.
    const desiredQuads = options.targetQuads
        ?? (options.targetTriangleCount !== undefined
            ? Math.round(options.targetTriangleCount / 2)
            : 1000);
    const speedCap = originalTriangleCount > maxInputTriangles
        ? Math.floor(maxInputTriangles * 0.9)
        : Number.POSITIVE_INFINITY;

    // Intermediate density band (fraction of input tris):
    // - too close to 1.0 on small meshes → collapse
    // - too low (old 0.55 on 3k) → remesh seals at ~200 faces
    // Measured on pre-decimated Miffy 3k: ~0.70–0.75 × input is usable.
    const stableFraction =
        inputTriangleCount <= 2500
            ? 0.62
            : inputTriangleCount <= 8000
                ? 0.75
                : 0.72;
    const stableCap = Math.max(
        240,
        Math.min(inputTriangleCount, Math.floor(inputTriangleCount * stableFraction))
    );

    // Intermediate target: enough to support desiredQuads (≈2–3× faces).
    const requestedTarget = options.targetTriangleCount
        ?? Math.round(desiredQuads * 2.8);
    let targetTriangleCount = Math.round(
        Math.min(requestedTarget, stableCap, speedCap)
    );
    targetTriangleCount = Math.max(
        Math.min(300, inputTriangleCount),
        targetTriangleCount
    );
    targetTriangleCount = clampTargetTriangleCount(
        targetTriangleCount,
        area,
        diagonal,
        inputTriangleCount
    );
    // Never densify past input; stay in stable band.
    targetTriangleCount = Math.min(targetTriangleCount, stableCap, inputTriangleCount);
    // Do not force small meshes up to a fixed fraction of their input. The
    // native extractor becomes unstable when a 1k-quad request is silently
    // raised to 4k+ intermediate triangles (especially on UV spheres). That
    // produced malformed native output, after which the old fallback paired
    // the original triangles and displayed a dense, diagonal source grid.
    // Keep the requested target when it is already inside the safe range.

    const modelType = options.modelType === "hardSurface" || options.preserveSharpFeatures ? 1 : 0;

    // Face count is driven mainly by edgeScaling (1.0 = finest). Keep it at the
    // user value — do NOT invent a high auto scale (that produced ~200 quads).
    const relativeScale = options.edgeScaling ?? 1.0;
    const userScaling = clamp(Math.max(1.0, relativeScale), 1.0, 2.0);
    const userAdaptivity = clamp(options.adaptivity ?? 0.5, 0, 1);
    const sharpEdgeDegrees = options.sharpEdgeThreshold ?? DEFAULT_SHARP_EDGE_DEGREES;
    const smoothNormalDegrees = options.smoothNormalDegrees ?? 0;

    const midTarget = targetTriangleCount;
    const highTarget = Math.min(stableCap, Math.round(inputTriangleCount * stableFraction));
    // Only mild coarsening for recovery — stay near scale 1.0 so face count
    // tracks targetQuads. Coarse scale (1.5+) on 3k inputs → ~200 quads.
    const attempts: AttemptParams[] = [
        {
            scaling: userScaling,
            adaptivity: userAdaptivity,
            target: midTarget,
            label: `scale ${userScaling.toFixed(2)}, intermediate ${midTarget} → ~${desiredQuads} quads`,
        },
        {
            scaling: 1.0,
            adaptivity: Math.min(userAdaptivity, 0.5),
            target: highTarget,
            label: `recover (scale 1.0, intermediate ${highTarget})`,
        },
        {
            scaling: 1.1,
            adaptivity: 0.45,
            target: highTarget,
            label: `recover (scale 1.1, intermediate ${highTarget})`,
        },
        {
            scaling: 1.2,
            adaptivity: 0.4,
            target: midTarget,
            label: `recover (scale 1.2, intermediate ${midTarget})`,
        },
        {
            // The native extractor can produce a valid dense torus-knot result
            // at a coarser edge scale even when its first pass returns malformed
            // connectivity. This is a recovery attempt, not a source fallback.
            scaling: 2.0,
            adaptivity: 0.35,
            target: midTarget,
            label: `topology recovery (scale 2.0, intermediate ${midTarget})`,
        },
        {
            // Some dense curved meshes hit a single bad MIQ cell at the normal
            // target band. A lower intermediate density gives the extractor
            // enough room to form a valid field; it is still a native remesh,
            // never the removed source-topology fallback.
            scaling: 1.0,
            adaptivity: Math.min(userAdaptivity, 0.35),
            target: Math.max(300, Math.round(midTarget * 0.5)),
            label: `topology recovery (lower intermediate ${Math.max(300, Math.round(midTarget * 0.5))})`,
        },
    ];

    const started = now();
    let lastError: unknown = null;
    let lastQualityReasons = "unknown failure";

    /**
     * Score favors proximity to targetQuads heavily. Under-dense sealed meshes
     * (~300–500 faces when target is 1000) must lose to denser near-target
     * meshes even with a few residual boundary edges.
     */
    const scoreCandidate = (
        quadCount: number,
        volRatio: number,
        boundaryEdges: number
    ): number => {
        const ratio = quadCount / Math.max(1, desiredQuads);
        // Peak at ratio≈1; harsh penalty below 0.65 and above 2.0.
        let densityFit: number;
        if (ratio < 0.65)
            densityFit = 0.15 * (ratio / 0.65); // 0–0.15
        else if (ratio <= 1.4)
            densityFit = 0.5 + 0.5 * (1 - Math.abs(ratio - 1) / 0.4);
        else
            densityFit = Math.max(0.2, 1 - (ratio - 1.4) / 2);

        // Few holes are fine; dozens are not. Don't let 0 holes outrank density.
        const holePen = boundaryEdges <= 8
            ? 1
            : boundaryEdges <= 48
                ? 0.92
                : 1 / (1 + (boundaryEdges - 48) / 60);

        return Math.max(0.05, volRatio)
            * (0.25 + 0.75 * densityFit)
            * holePen
            * Math.log2(2 + quadCount);
    };

    const isAcceptableNearSealed = (quadCount: number, boundaryEdges: number): boolean => {
        // On pre-decimated character meshes, dense remesh often leaves residual
        // boundaries after fill. Prefer that over a sealed ~200-face scrap.
        if (boundaryEdges <= 24)
            return true;
        if (boundaryEdges <= 48 && quadCount >= desiredQuads * 0.8)
            return true;
        return false;
    };
    // Best watertight (or near-watertight) candidate by density-aware score.
    let bestGood: {
        vertices: Float32Array;
        quads: Uint32Array;
        triangles: Uint32Array;
        quadCount: number;
        boundaryEdges: number;
        score: number;
    } | null = null;
    // Keep the best non-collapsed holey result in case fill can salvage it.
    let bestHoley: {
        vertices: Float32Array;
        quads: Uint32Array;
        triangles: Uint32Array;
        quadCount: number;
        boundaryEdges: number;
        score: number;
    } | null = null;
    // Best attempt by diagonal fit even if slightly under thresholds.
    let bestAny: {
        vertices: Float32Array;
        quads: Uint32Array;
        triangles: Uint32Array;
        quadCount: number;
        score: number;
    } | null = null;
    const report = (progress: number, status: string) => {
        options.onProgress?.(progress, status);
    };

    for (let attempt = 0; attempt < attempts.length; ++attempt) {
        const params = attempts[attempt];
        try {
            if (attempt > 0)
                report(0.05 + attempt * 0.05, `Retrying: ${params.label}…`);

            if (attempt === 0) {
                report(
                    0.08,
                    `Remeshing ${inputTriangleCount.toLocaleString()} tris `
                        + `(mixed-integer solve is the slow step — usually under a few minutes)…`
                );
            }

            const native = runNativeRemesh(wasmModule, vertices, indices, {
                targetTriangleCount: params.target,
                scaling: params.scaling,
                adaptivity: params.adaptivity,
                sharpEdgeDegrees,
                smoothNormalDegrees,
                modelType,
                onProgress: attempt === 0 ? options.onProgress : undefined,
            });

            let restoredVertices = aspectRatioRestore(native.vertices, transform);
            let quads = native.quads;
            let triangles = quadsToTriangles(quads);
            let quadCount = quads.length / 4;

            // Do this before scoring or attempting repair. Native success only
            // means extraction completed; malformed connectivity here renders
            // as the long crossing sheets seen on otherwise simple primitives.
            let topology = assessTriangleTopology(restoredVertices, triangles);
            if (!topology.ok) {
                lastQualityReasons = `invalid topology: ${topology.reasons.join("; ")}`;
                continue;
            }

            // Collapse / garbage check first (without watertight demand).
            let quality = assessRemeshQuality(
                remeshSourceVertices,
                restoredVertices,
                triangles,
                quadCount,
                { requireWatertight: false }
            );

            // Track best diagonal fit for last-resort return.
            const rawScore = quality.bboxVolumeRatio * Math.log2(2 + quadCount);
            if (
                quadCount >= 8
                && Number.isFinite(rawScore)
                && (!bestAny || rawScore > bestAny.score)
                && !quality.reasons.some((r) => r.startsWith("collapsed") || r.startsWith("too few") || r.startsWith("non-finite"))
            ) {
                bestAny = {
                    vertices: restoredVertices,
                    quads,
                    triangles,
                    quadCount,
                    score: rawScore,
                };
            } else if (
                quadCount >= 12
                && quality.bboxVolumeRatio >= 0.08
                && (!bestAny || quality.bboxVolumeRatio > bestAny.score)
            ) {
                bestAny = {
                    vertices: restoredVertices,
                    quads,
                    triangles,
                    quadCount,
                    score: quality.bboxVolumeRatio,
                };
            }

            if (!quality.ok) {
                lastQualityReasons = quality.reasons.join("; ");
                continue;
            }

            // Seal residual holes when the caller wants a closed mesh. Keep
            // the native result if a repair fan is rejected; a bad cap is
            // worse than a small, visible boundary and used to produce the
            // diagonal/crossing sheets in /remesher.
            if (requireWatertight) {
                const beforeHoles = countBoundaryEdges(triangles);
                if (beforeHoles > 0) {
                    report(0.92, "Filling surface holes…");
                    const filled = fillMeshHoles(restoredVertices, triangles);
                    if (filled.filledTriangles.length > 0) {
                        const repairedTopology = assessTriangleTopology(
                            restoredVertices,
                            filled.indices
                        );
                        if (repairedTopology.ok) {
                            triangles = filled.indices;
                            quads = appendTriangleQuads(quads, filled.filledTriangles);
                            quadCount = quads.length / 4;
                        }
                    }
                }
            }

            // A tiny, planar repair is acceptable, but never select a result
            // whose output topology became non-manifold or duplicate during a
            // repair attempt. Retry the native solve instead.
            topology = assessTriangleTopology(restoredVertices, triangles);
            if (!topology.ok) {
                lastQualityReasons = `invalid topology after repair: ${topology.reasons.join("; ")}`;
                continue;
            }

            const boundaryAfter = topology.boundaryEdges;
            quality = assessRemeshQuality(
                remeshSourceVertices,
                restoredVertices,
                triangles,
                quadCount,
                { requireWatertight }
            );

            const candScore = scoreCandidate(
                quadCount,
                quality.bboxVolumeRatio,
                boundaryAfter
            );

            if (!quality.ok) {
                lastQualityReasons = quality.reasons.join("; ");
                if (quality.hasHolesOnly) {
                    // Prefer denser near-target meshes over tiny sealed scraps.
                    if (!bestHoley || candScore > bestHoley.score) {
                        bestHoley = {
                            vertices: restoredVertices,
                            quads,
                            triangles,
                            quadCount,
                            boundaryEdges: boundaryAfter,
                            score: candScore,
                        };
                    }
                }
                continue;
            }

            // Watertight (or non-required) success — keep best by density score.
            // Do NOT return the first success: scale-2.0 often seals first with
            // ~300 quads while a later/prior moderate scale hits the target.
            if (!bestGood || candScore > bestGood.score) {
                bestGood = {
                    vertices: restoredVertices,
                    quads,
                    triangles,
                    quadCount,
                    boundaryEdges: boundaryAfter,
                    score: candScore,
                };
            }

            // Early exit only when density is solidly on target (not half-count).
            if (
                boundaryAfter <= 8
                && quadCount >= desiredQuads * 0.75
                && quadCount <= desiredQuads * 1.5
            ) {
                report(1, "Done");
                return finishResult({
                    vertices: restoredVertices,
                    quads,
                    triangles,
                    quadCount,
                    processingTimeMs: now() - started,
                    watertight: boundaryAfter === 0,
                    quality: boundaryAfter === 0 ? "remeshed" : "near-sealed",
                    sourceVertices,
                    sourceIndices,
                    sourceUvs,
                    options,
                });
            }
            lastQualityReasons = `density ${quadCount} vs target ${desiredQuads}`;
        } catch (error) {
            lastError = error;
            // Native empty/fail — try next attempt.
            continue;
        }
    }

    // Pick among watertight + near-sealed denser candidates by density score.
    // Critical: a sealed 339-face scrap must NOT beat a 1000-face mesh with 4 holes.
    type Pick = {
        vertices: Float32Array;
        quads: Uint32Array;
        triangles: Uint32Array;
        quadCount: number;
        boundaryEdges: number;
        score: number;
        label: string;
    };
    const finalists: Pick[] = [];
    if (bestGood && bestGood.quadCount >= 12) {
        finalists.push({ ...bestGood, label: "watertight" });
    }
    if (
        bestHoley
        && bestHoley.quadCount >= 12
        && isAcceptableNearSealed(bestHoley.quadCount, bestHoley.boundaryEdges)
    ) {
        finalists.push({ ...bestHoley, label: "near-sealed" });
    }

    if (finalists.length > 0) {
        finalists.sort((a, b) => b.score - a.score);
        const win = finalists[0];
        // HARD RULE: never pick a ~half-target sealed scrap when a denser
        // near-target candidate exists (this was the "200–500 polygons" bug).
        const denseEnough = finalists.filter((c) => c.quadCount >= desiredQuads * 0.55);
        const pool = denseEnough.length > 0 ? denseEnough : finalists;
        // Prefer closest to targetQuads among dense-enough, then score.
        const pick = pool.slice().sort((a, b) => {
            const da = Math.abs(a.quadCount - desiredQuads);
            const db = Math.abs(b.quadCount - desiredQuads);
            if (Math.abs(da - db) > desiredQuads * 0.15)
                return da - db;
            return b.score - a.score;
        })[0] ?? win;

        if (pick.boundaryEdges > 0)
            report(0.95, `Accepting ${pick.label} result (${pick.boundaryEdges} open edges)…`);
        report(1, "Done");
        return finishResult({
            vertices: pick.vertices,
            quads: pick.quads,
            triangles: pick.triangles,
            quadCount: pick.quadCount,
            processingTimeMs: now() - started,
            watertight: pick.boundaryEdges === 0,
            quality: pick.boundaryEdges === 0 ? "remeshed" : "near-sealed",
            sourceVertices,
            sourceIndices,
            sourceUvs,
            options,
        });
    }

    if (bestHoley && requireWatertight) {
        throw new AutoRemesherError(
            `Remeshing left holes (${bestHoley.boundaryEdges} open edges, `
            + `${bestHoley.quadCount} faces; target ~${desiredQuads}). `
            + "Pre-decimate less aggressively (keep ≥8–12k tris), set Target quads "
            + `≈ ${Math.max(300, Math.round(inputTriangleCount * 0.3))}, or lower Quad size slightly. `
            + `(${lastQualityReasons})`,
            -7
        );
    }

    // Last resort is allowed for intentionally open inputs only. For a closed
    // input, returning an arbitrary holey candidate would turn a failed
    // remesh into an apparently successful export; only the explicitly
    // admitted near-sealed finalist above may pass the watertight policy.
    if (bestAny && bestAny.quadCount >= 12) {
        const bestAnyBoundary = countBoundaryEdges(bestAny.triangles);
        const q = assessRemeshQuality(
            remeshSourceVertices,
            bestAny.vertices,
            bestAny.triangles,
            bestAny.quadCount,
            { requireWatertight: false }
        );
        if (
            (!requireWatertight || isAcceptableNearSealed(bestAny.quadCount, bestAnyBoundary))
            && !q.reasons.some((r) => r.startsWith("collapsed") || r.startsWith("non-finite"))
        ) {
            report(1, "Done");
            return finishResult({
                vertices: bestAny.vertices,
                quads: bestAny.quads,
                triangles: bestAny.triangles,
                quadCount: bestAny.quadCount,
                processingTimeMs: now() - started,
                watertight: bestAnyBoundary === 0,
                quality: bestAnyBoundary === 0 ? "remeshed" : "near-sealed",
                sourceVertices,
                sourceIndices,
                sourceUvs,
                options,
            });
        }
    }

    if (lastError instanceof AutoRemesherError)
        throw lastError;
    if (lastError instanceof Error)
        throw new AutoRemesherError(lastError.message, -5);
    throw new AutoRemesherError(
        `Remeshing failed after retries (${lastQualityReasons}). `
        + "The solver produced a collapsed fragment. Try: lower Target quads (400–800), "
        + "Speed → Balanced, weld/clean the mesh in Blender, or remesh only the largest solid part.",
        -6
    );
}

function finishResult(args: {
    vertices: Float32Array;
    quads: Uint32Array;
    triangles: Uint32Array;
    quadCount: number;
    processingTimeMs: number;
    watertight: boolean;
    quality: "remeshed" | "near-sealed";
    sourceVertices: Float32Array;
    sourceIndices: Uint32Array;
    sourceUvs?: Float32Array;
    options: RemeshOptions;
}): RemeshedResult {
    const {
        vertices,
        quads,
        triangles,
        quadCount,
        processingTimeMs,
        watertight,
        quality,
        sourceVertices,
        sourceIndices,
        sourceUvs,
        options,
    } = args;

    const result: RemeshedResult = {
        vertices,
        indices: triangles,
        quads,
        quadCount,
        watertight,
        quality,
        processingTimeMs,
    };
    if (options.smoothNormals !== false)
        result.normals = computeVertexNormals(vertices, triangles);
    if (sourceUvs && options.preserveUVs !== false) {
        result.uvs = transferAttribute(
            { vertices: sourceVertices, indices: sourceIndices },
            sourceUvs,
            2,
            vertices
        );
    }
    return result;
}

interface NormalizedInput {
    vertices: Float32Array;
    indices: Uint32Array;
    uvs?: Float32Array;
}

function normalizeInput(input: RemeshInput): NormalizedInput {
    if (typeof input === "string") {
        const trimmed = input.trimStart();
        if (trimmed.startsWith("{"))
            return parseGltfJson(input);
        return parseObj(input);
    }

    if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        if (isGlb(bytes))
            return parseGlb(bytes);
        // Not a GLB: assume UTF-8 text (OBJ or glTF JSON).
        return normalizeInput(new TextDecoder().decode(bytes));
    }

    if (isBufferGeometryLike(input))
        return fromBufferGeometryLike(input);

    if (isRawMesh(input)) {
        const vertices = input.vertices instanceof Float32Array
            ? input.vertices
            : Float32Array.from(input.vertices);
        const indices = input.indices instanceof Uint32Array
            ? input.indices
            : Uint32Array.from(input.indices);
        const normalized: NormalizedInput = { vertices, indices };
        if (input.uvs && input.uvs.length >= (vertices.length / 3) * 2) {
            normalized.uvs = input.uvs instanceof Float32Array
                ? input.uvs
                : Float32Array.from(input.uvs);
        }
        return normalized;
    }

    throw new AutoRemesherError(
        "Unsupported input: pass {vertices, indices}, OBJ text, GLB/glTF data, or a BufferGeometry",
        -101
    );
}

function isRawMesh(input: unknown): input is RawMesh {
    return typeof input === "object" && input !== null
        && "vertices" in input && "indices" in input;
}

function isBufferGeometryLike(input: unknown): input is BufferGeometryLike {
    if (typeof input !== "object" || input === null)
        return false;
    const candidate = input as BufferGeometryLike;
    return candidate.attributes?.position?.array !== undefined;
}

function fromBufferGeometryLike(geometry: BufferGeometryLike): NormalizedInput {
    const position = geometry.attributes.position;
    const vertices = position.array instanceof Float32Array
        ? position.array
        : Float32Array.from(position.array as ArrayLike<number>);
    let indices: Uint32Array;
    if (geometry.index) {
        indices = geometry.index.array instanceof Uint32Array
            ? geometry.index.array
            : Uint32Array.from(geometry.index.array as ArrayLike<number>);
    } else {
        // Non-indexed geometry: consecutive triangles.
        indices = new Uint32Array(position.count);
        for (let i = 0; i < indices.length; ++i)
            indices[i] = i;
    }
    const normalized: NormalizedInput = { vertices, indices };
    const uv = geometry.attributes.uv;
    if (uv && uv.itemSize === 2 && uv.count === position.count) {
        normalized.uvs = uv.array instanceof Float32Array
            ? uv.array
            : Float32Array.from(uv.array as ArrayLike<number>);
    }
    return normalized;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
