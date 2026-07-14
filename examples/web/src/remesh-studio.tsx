import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import {
    ACCEPTED_FILES,
    makeTorusKnotSample,
    normalizeMesh,
    prepareMeshForRemesh,
    readMeshFile,
    type MeshData,
} from "./remesh-mesh";

interface RemeshResult {
    vertices: Float32Array;
    indices: Uint32Array;
    quads: Uint32Array;
    normals?: Float32Array;
    quadCount: number;
    processingTimeMs: number;
    watertight: boolean;
    quality: "remeshed" | "near-sealed";
}

interface DecimatedResult {
    vertices: Float32Array;
    indices: Uint32Array;
    fromTriangles: number;
    toTriangles: number;
    method: "meshopt" | "grid" | "none";
}

type WorkerMessage =
    | { id: number; type: "progress"; progress: number; status: string }
    | { id: number; type: "done"; result: RemeshResult }
    | { id: number; type: "decimated"; result: DecimatedResult }
    | { id: number; type: "error"; message: string };

const MAX_TARGET = 5000;
const GITHUB_REPO_URL = "https://github.com/imsarah/autoremesher-wasm";
/** Soft ceiling: remesh is practical below this without an extra pre-pass. */
const REMESH_COMFORT_TRIS = 40_000;
/** Strongly recommend pre-decimate above this. */
const REMESH_HEAVY_TRIS = 120_000;
const DECIMATE_PRESETS = [
    { value: 8_000, label: "Light", hint: "fast remesh" },
    { value: 15_000, label: "Balanced", hint: "good default" },
    { value: 25_000, label: "Detail", hint: "more shape" },
    { value: 50_000, label: "Heavy", hint: "large uploads" },
    { value: 100_000, label: "Max", hint: "multi‑M meshes" },
    { value: 250_000, label: "Ultra", hint: "keep density" },
] as const;
const MAX_SOURCE_WIREFRAME_TRIANGLES = 100000;

function formatTris(n: number): string {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 10_000)
        return `${Math.round(n / 1000)}k`;
    return n.toLocaleString();
}

/** Pick a sensible triangle budget from the current mesh size. */
function recommendDecimateTarget(triangleCount: number): number {
    if (triangleCount <= REMESH_COMFORT_TRIS)
        return Math.max(8_000, Math.floor(triangleCount * 0.6));
    if (triangleCount <= 80_000)
        return 15_000;
    if (triangleCount <= 200_000)
        return 25_000;
    if (triangleCount <= 600_000)
        return 50_000;
    if (triangleCount <= 2_000_000)
        return 100_000;
    return 250_000;
}

function decimateNeedLevel(triangleCount: number): "none" | "optional" | "recommended" | "required" {
    if (triangleCount <= REMESH_COMFORT_TRIS)
        return "none";
    if (triangleCount <= REMESH_HEAVY_TRIS)
        return "optional";
    if (triangleCount <= 500_000)
        return "recommended";
    return "required";
}

function makeGeometry(vertices: Float32Array, indices: Uint32Array, normals?: Float32Array) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    if (normals && normals.length === vertices.length)
        geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    else
        geometry.computeVertexNormals();
    return geometry;
}

function pushUniqueEdge(
    seen: Set<string>,
    linePositions: number[],
    vertices: Float32Array,
    a: number,
    b: number
) {
    if (a === b)
        return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key))
        return;
    seen.add(key);
    linePositions.push(
        vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2],
        vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]
    );
}

function linesFromPositions(linePositions: number[]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(linePositions), 3));
    return geometry;
}

/** Quad wireframe (triangles encoded as repeated last index). */
function makeQuadLines(vertices: Float32Array, quads: Uint32Array) {
    const seen = new Set<string>();
    const linePositions: number[] = [];
    for (let i = 0; i < quads.length; i += 4) {
        const a = quads[i], b = quads[i + 1], c = quads[i + 2], d = quads[i + 3];
        pushUniqueEdge(seen, linePositions, vertices, a, b);
        pushUniqueEdge(seen, linePositions, vertices, b, c);
        pushUniqueEdge(seen, linePositions, vertices, c, d);
        pushUniqueEdge(seen, linePositions, vertices, d, a);
    }
    return linesFromPositions(linePositions);
}

/**
 * Wireframe for the source mesh. Adjacent coplanar tris are paired so regular
 * grids (UV spheres, CAD quads) show as quads without diagonals; leftover faces
 * keep triangle edges.
 */
function makeSourceTopologyLines(vertices: Float32Array, indices: Uint32Array) {
    type EdgeRef = { face: number; a: number; b: number };
    const edgeToFace = new Map<string, EdgeRef[]>();
    const faceCount = indices.length / 3;
    for (let face = 0; face < faceCount; face++) {
        const offset = face * 3;
        for (let e = 0; e < 3; e++) {
            const a = indices[offset + e];
            const b = indices[offset + ((e + 1) % 3)];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            const refs = edgeToFace.get(key) ?? [];
            refs.push({ face, a, b });
            edgeToFace.set(key, refs);
        }
    }

    const pairedWith = new Int32Array(faceCount);
    pairedWith.fill(-1);
    const quads: number[] = [];
    for (const refs of edgeToFace.values()) {
        if (refs.length !== 2)
            continue;
        const [first, second] = refs;
        if (pairedWith[first.face] !== -1 || pairedWith[second.face] !== -1)
            continue;
        const fo = first.face * 3;
        const firstTri = [indices[fo], indices[fo + 1], indices[fo + 2]];
        const outerFirst = firstTri.find((v) => v !== first.a && v !== first.b);
        const so = second.face * 3;
        const secondTri = [indices[so], indices[so + 1], indices[so + 2]];
        const outerSecond = secondTri.find((v) => v !== first.a && v !== first.b);
        if (outerFirst === undefined || outerSecond === undefined || outerFirst === outerSecond)
            continue;
        const outerIndex = firstTri.indexOf(outerFirst);
        const next = firstTri[(outerIndex + 1) % 3];
        const previous = firstTri[(outerIndex + 2) % 3];
        quads.push(outerFirst, next, outerSecond, previous);
        pairedWith[first.face] = second.face;
        pairedWith[second.face] = first.face;
    }

    for (let face = 0; face < faceCount; face++) {
        if (pairedWith[face] !== -1)
            continue;
        const o = face * 3;
        quads.push(indices[o], indices[o + 1], indices[o + 2], indices[o + 2]);
    }

    return makeQuadLines(vertices, Uint32Array.from(quads));
}

/**
 * Render the source exactly like the Advanced Model Editor's wireframe mode:
 * every indexed triangle edge is visible, including the diagonal edges and
 * the UV-sphere pole fans. The previous topology pairing made the sample look
 * like a different mesh even when it used the same source geometry.
 */
function makeRawSourceWireframeLines(vertices: Float32Array, indices: Uint32Array) {
    const seen = new Set<string>();
    const linePositions: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        pushUniqueEdge(seen, linePositions, vertices, a, b);
        pushUniqueEdge(seen, linePositions, vertices, b, c);
        pushUniqueEdge(seen, linePositions, vertices, c, a);
    }
    return linesFromPositions(linePositions);
}

function faceCount(quads: Uint32Array) {
    let triangles = 0;
    for (let i = 0; i < quads.length; i += 4)
        triangles += quads[i + 2] === quads[i + 3] ? 1 : 0;
    return { quads: quads.length / 4 - triangles, triangles };
}

export default function RemeshStudio() {
    const worker = useRef<Worker | null>(null);
    const request = useRef(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [source, setSource] = useState<MeshData>(() => makeTorusKnotSample());
    const [label, setLabel] = useState("Sample torus knot");
    const [result, setResult] = useState<RemeshResult | null>(null);
    const [target, setTarget] = useState(1000);
    const [adaptivity, setAdaptivity] = useState(0.5);
    const [modelType, setModelType] = useState<"organic" | "hardSurface">("organic");
    const [sharpEdgeThreshold, setSharpEdgeThreshold] = useState(90);
    const [decimateTarget, setDecimateTarget] = useState(15_000);
    const [lastDecimate, setLastDecimate] = useState<DecimatedResult | null>(null);
    const [viewResult, setViewResult] = useState(true);
    const [running, setRunning] = useState(false);
    const [busyAction, setBusyAction] = useState<"remesh" | "decimate" | null>(null);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("Ready");
    const [error, setError] = useState<string | null>(null);
    const inputTriangles = source.indices.length / 3;
    const needLevel = decimateNeedLevel(inputTriangles);
    const needsDecimate = inputTriangles > decimateTarget;
    const recommendedTarget = useMemo(
        () => recommendDecimateTarget(inputTriangles),
        [inputTriangles]
    );
    const reductionPreview = needsDecimate
        ? Math.max(0, Math.round((1 - decimateTarget / inputTriangles) * 100))
        : 0;

    useEffect(() => {
        // Must be a module worker — remesh.worker.ts uses ESM imports.
        // Without { type: "module" } the browser loads type=classic and throws
        // "Cannot use import statement outside a module".
        const instance = new Worker(new URL("./remesh.worker.ts", import.meta.url), {
            type: "module",
        });
        worker.current = instance;
        return () => instance.terminate();
    }, []);

    const chooseSource = useCallback((mesh: MeshData, name: string, normalize = true) => {
        const next = normalize ? normalizeMesh(mesh) : mesh;
        const tris = next.indices.length / 3;
        setSource(next);
        setLabel(name);
        setResult(null);
        setLastDecimate(null);
        setViewResult(false);
        setError(null);
        setStatus("Ready");
        // Snap the budget to a sensible default for this mesh size.
        if (tris > REMESH_COMFORT_TRIS)
            setDecimateTarget(recommendDecimateTarget(tris));
    }, []);

    const upload = useCallback(async (file: File) => {
        try {
            setError(null);
            setStatus("Reading mesh…");
            chooseSource(await readMeshFile(file), file.name);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setStatus("Ready");
        }
    }, [chooseSource]);

    const run = useCallback(() => {
        if (!worker.current || running)
            return;
        const id = ++request.current;
        const instance = worker.current;
        setRunning(true);
        setBusyAction("remesh");
        setError(null);
        setProgress(0);
        setStatus("Starting…");

        const receive = (event: MessageEvent<WorkerMessage>) => {
            if (event.data.id !== id)
                return;
            if (event.data.type === "progress") {
                setProgress(Math.round(event.data.progress * 100));
                setStatus(event.data.status);
                return;
            }
            instance.removeEventListener("message", receive);
            setRunning(false);
            setBusyAction(null);
            if (event.data.type === "error") {
                setError(event.data.message);
                setStatus("Remesh failed");
                return;
            }
            if (event.data.type !== "done")
                return;
            setResult(event.data.result);
            setViewResult(true);
            setProgress(100);
            setStatus("Done");
        };
        instance.addEventListener("message", receive);
        const prepared = prepareMeshForRemesh(source);
        const vertices = prepared.vertices.slice();
        const indices = prepared.indices.slice();
        instance.postMessage({
            id,
            type: "remesh",
            vertices,
            indices,
            options: {
                targetQuads: Math.min(MAX_TARGET, Math.max(200, target)),
                adaptivity,
                modelType,
                sharpEdgeThreshold,
            },
        }, [vertices.buffer, indices.buffer]);
    }, [source, running, target, adaptivity, modelType, sharpEdgeThreshold]);

    const preDecimate = useCallback(() => {
        if (!worker.current || running || inputTriangles <= decimateTarget)
            return;
        const id = ++request.current;
        const instance = worker.current;
        const budget = Math.max(1_000, Math.floor(decimateTarget));
        setRunning(true);
        setBusyAction("decimate");
        setError(null);
        setProgress(0);
        setStatus(`Simplifying ${formatTris(inputTriangles)} → ${formatTris(budget)} tris…`);

        const receive = (event: MessageEvent<WorkerMessage>) => {
            if (event.data.id !== id)
                return;
            if (event.data.type === "progress") {
                setProgress(Math.round(event.data.progress * 100));
                setStatus(event.data.status);
                return;
            }
            instance.removeEventListener("message", receive);
            setRunning(false);
            setBusyAction(null);
            if (event.data.type === "error") {
                setError(event.data.message);
                setStatus("Pre-decimate failed");
                return;
            }
            if (event.data.type !== "decimated")
                return;
            const { result: reduced } = event.data;
            if (reduced.method === "none" || reduced.toTriangles >= reduced.fromTriangles) {
                setError(
                    `Could not reduce further (still ${reduced.toTriangles.toLocaleString()} tris). `
                    + "Try a lower target, or remesh as-is if the mesh is already small."
                );
                setStatus("No reduction");
                return;
            }
            setSource(normalizeMesh({ vertices: reduced.vertices, indices: reduced.indices }));
            setLastDecimate(reduced);
            const pct = Math.round((1 - reduced.toTriangles / reduced.fromTriangles) * 100);
            setLabel((current) => {
                const base = current.replace(/ \(pre-decimated.*\)$/i, "");
                return `${base} (pre-decimated −${pct}%)`;
            });
            setResult(null);
            setViewResult(false);
            setProgress(100);
            setStatus(
                `${formatTris(reduced.fromTriangles)} → ${formatTris(reduced.toTriangles)} tris `
                + `(−${pct}%, ${reduced.method}) — ready to remesh`
            );
        };
        instance.addEventListener("message", receive);
        const vertices = source.vertices.slice();
        const indices = source.indices.slice();
        instance.postMessage({
            id,
            type: "decimate",
            vertices,
            indices,
            maxTriangles: budget,
        }, [vertices.buffer, indices.buffer]);
    }, [source, running, inputTriangles, decimateTarget]);

    const display = useMemo(() => {
        if (viewResult && result) {
            return {
                geometry: makeGeometry(result.vertices, result.indices, result.normals),
                lines: makeQuadLines(result.vertices, result.quads),
                lineColor: "#252b55",
            };
        }
        return {
            geometry: makeGeometry(source.vertices, source.indices),
            // Building a line for every source edge is both unnecessary and
            // very expensive for million-polygon uploads. The solid preview
            // remains available while pre-decimation runs in the worker.
            lines: inputTriangles <= MAX_SOURCE_WIREFRAME_TRIANGLES
                ? makeRawSourceWireframeLines(source.vertices, source.indices)
                : null,
            lineColor: "#5c6478",
        };
    }, [viewResult, result, source, inputTriangles]);

    useEffect(() => () => {
        display.geometry.dispose();
        display.lines?.dispose();
    }, [display]);

    const outputFaces = result ? faceCount(result.quads) : null;
    const download = useCallback(() => {
        if (!result)
            return;
        const rows = [];
        for (let i = 0; i < result.vertices.length; i += 3)
            rows.push(`v ${result.vertices[i]} ${result.vertices[i + 1]} ${result.vertices[i + 2]}`);
        for (let i = 0; i < result.quads.length; i += 4) {
            const a = result.quads[i] + 1;
            const b = result.quads[i + 1] + 1;
            const c = result.quads[i + 2] + 1;
            const d = result.quads[i + 3] + 1;
            rows.push(c === d ? `f ${a} ${b} ${c}` : `f ${a} ${b} ${c} ${d}`);
        }
        const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/plain" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "remeshed.obj";
        anchor.click();
        URL.revokeObjectURL(url);
    }, [result]);

    return (
        <main className="flex h-screen flex-col bg-[#09090b] text-zinc-100 md:flex-row">
            <section
                className="relative min-h-[48vh] flex-1"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files?.[0];
                    if (file)
                        void upload(file);
                }}
            >
                <Canvas camera={{ position: [2.8, 1.8, 2.8], fov: 45 }}>
                    <color attach="background" args={["#09090b"]} />
                    <ambientLight intensity={0.65} />
                    <directionalLight position={[4, 5, 3]} intensity={1.6} />
                    <directionalLight position={[-3, -2, -4]} intensity={0.35} />
                    <mesh geometry={display.geometry}>
                        <meshStandardMaterial color={viewResult ? "#8792ff" : "#555b6d"} roughness={0.6} />
                    </mesh>
                    {display.lines && (
                        <lineSegments geometry={display.lines}>
                            <lineBasicMaterial color={display.lineColor} />
                        </lineSegments>
                    )}
                    <OrbitControls makeDefault enableDamping />
                </Canvas>
                <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-white/10 bg-black/60 px-4 py-3 text-xs shadow-xl backdrop-blur">
                    <div className="font-semibold text-white">{label}</div>
                    <div className="mt-1 text-zinc-400">
                        {inputTriangles.toLocaleString()} input triangles
                        {result && outputFaces ? ` → ${outputFaces.quads.toLocaleString()} quads` : ""}
                    </div>
                </div>
            </section>

            <aside className="w-full overflow-y-auto border-t border-white/10 bg-[#111113] p-5 md:w-[380px] md:border-l md:border-t-0">
                <div className="mb-6">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Remesh</p>
                            <h1 className="mt-2 text-2xl font-semibold">Clean quad topology</h1>
                        </div>
                        <a
                            href={GITHUB_REPO_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/10"
                            title="View source on GitHub"
                        >
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
                                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
                            </svg>
                            GitHub
                        </a>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">Browser demo for <code className="text-zinc-200">@autoremesher/wasm</code>. Upload a mesh, remesh in a Web Worker, inspect quads, download OBJ.</p>
                </div>

                <div className="space-y-4">
                    <input
                        ref={inputRef}
                        className="hidden"
                        type="file"
                        accept={ACCEPTED_FILES}
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file)
                                void upload(file);
                        }}
                    />
                    <button className="w-full rounded-lg bg-violet-600 px-4 py-3 text-sm font-semibold transition hover:bg-violet-500 disabled:opacity-50" disabled={running} onClick={() => inputRef.current?.click()}>
                        Upload model
                    </button>
                    <p className="text-xs text-zinc-500">GLB, glTF, FBX, OBJ, and STL. You can also drop a file on the viewport.</p>

                    <label className="block text-sm font-medium">
                        Target quads <span className="float-right text-zinc-400">{target.toLocaleString()}</span>
                        <input className="mt-3 w-full accent-violet-500" type="range" min={200} max={MAX_TARGET} step={100} value={target} onChange={(event) => setTarget(Number(event.target.value))} disabled={running} />
                    </label>
                    <label className="block text-sm font-medium">
                        Detail on curves <span className="float-right text-zinc-400">{adaptivity.toFixed(2)}</span>
                        <input className="mt-3 w-full accent-violet-500" type="range" min={0} max={1} step={0.05} value={adaptivity} onChange={(event) => setAdaptivity(Number(event.target.value))} disabled={running} />
                    </label>
                    <label className="block text-sm font-medium">
                        Shape style
                        <select className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-sm" value={modelType} onChange={(event) => setModelType(event.target.value as typeof modelType)} disabled={running}>
                            <option value="organic">Organic</option>
                            <option value="hardSurface">Hard surface</option>
                        </select>
                    </label>
                    <label className="block text-sm font-medium">
                        Keep hard edges <span className="float-right text-zinc-400">{sharpEdgeThreshold}°</span>
                        <input className="mt-3 w-full accent-violet-500" type="range" min={15} max={180} step={5} value={sharpEdgeThreshold} onChange={(event) => setSharpEdgeThreshold(Number(event.target.value))} disabled={running} />
                        <span className="mt-1 block text-xs font-normal text-zinc-500">Corners sharper than this are treated as creases in hard-surface mode.</span>
                    </label>

                    <div
                        className={`rounded-xl border p-4 ${
                            needLevel === "required" || needLevel === "recommended"
                                ? "border-amber-300/30 bg-amber-950/30"
                                : needLevel === "optional"
                                    ? "border-amber-300/15 bg-amber-950/15"
                                    : "border-white/10 bg-white/[0.03]"
                        }`}
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div>
                                <div className="text-sm font-semibold text-zinc-100">Pre-decimate</div>
                                <p className="mt-1 text-xs leading-5 text-zinc-400">
                                    Edge-collapse simplify in a worker before remesh. Keeps silhouette; drops poly count so the quad solver stays fast.
                                </p>
                            </div>
                            <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                    needLevel === "required"
                                        ? "bg-amber-400/20 text-amber-100"
                                        : needLevel === "recommended"
                                            ? "bg-amber-400/15 text-amber-200"
                                            : needLevel === "optional"
                                                ? "bg-white/10 text-zinc-300"
                                                : "bg-emerald-500/15 text-emerald-200"
                                }`}
                            >
                                {needLevel === "required"
                                    ? "Needed"
                                    : needLevel === "recommended"
                                        ? "Recommended"
                                        : needLevel === "optional"
                                            ? "Optional"
                                            : "OK as-is"}
                            </span>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                            <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Current</div>
                                <div className="mt-0.5 font-semibold text-zinc-100">{formatTris(inputTriangles)} tris</div>
                            </div>
                            <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-zinc-500">After</div>
                                <div className="mt-0.5 font-semibold text-zinc-100">
                                    {needsDecimate
                                        ? `~${formatTris(decimateTarget)} (−${reductionPreview}%)`
                                        : "No change"}
                                </div>
                            </div>
                        </div>

                        <div className="mt-3">
                            <div className="mb-2 flex items-center justify-between text-xs">
                                <span className="font-medium text-zinc-200">Target triangles</span>
                                <span className="tabular-nums text-zinc-400">{decimateTarget.toLocaleString()}</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {DECIMATE_PRESETS.map((preset) => {
                                    const tooHigh = preset.value >= inputTriangles;
                                    const isActive = decimateTarget === preset.value;
                                    const isRec = recommendedTarget === preset.value && needsDecimate;
                                    return (
                                        <button
                                            key={preset.value}
                                            type="button"
                                            disabled={running || tooHigh}
                                            onClick={() => setDecimateTarget(preset.value)}
                                            title={tooHigh ? "Already at or below this count" : `${preset.hint}`}
                                            className={`rounded-md border px-2.5 py-1.5 text-left text-[11px] transition disabled:cursor-not-allowed disabled:opacity-30 ${
                                                isActive
                                                    ? "border-amber-300/40 bg-amber-400/15 text-amber-50"
                                                    : "border-white/10 bg-black/20 text-zinc-300 hover:border-white/20 hover:bg-white/5"
                                            }`}
                                        >
                                            <span className="block font-semibold">{preset.label}</span>
                                            <span className="block text-[10px] opacity-70">
                                                {formatTris(preset.value)}
                                                {isRec ? " · rec" : ""}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            <input
                                className="mt-3 w-full accent-amber-400"
                                type="range"
                                min={5_000}
                                max={Math.max(5_000, Math.min(500_000, Math.floor(inputTriangles * 0.95) || 5_000))}
                                step={1_000}
                                value={Math.min(decimateTarget, Math.max(5_000, inputTriangles - 1))}
                                onChange={(event) => setDecimateTarget(Number(event.target.value))}
                                disabled={running || inputTriangles <= 5_000}
                            />
                            <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
                                <span>5k</span>
                                <button
                                    type="button"
                                    className="text-amber-200/80 underline-offset-2 hover:underline disabled:no-underline disabled:opacity-40"
                                    disabled={running || !needsDecimate}
                                    onClick={() => setDecimateTarget(recommendedTarget)}
                                >
                                    Use recommended ({formatTris(recommendedTarget)})
                                </button>
                                <span>dense</span>
                            </div>
                        </div>

                        {busyAction === "decimate" && (
                            <div className="mt-3">
                                <div className="mb-1 flex justify-between text-[11px] text-amber-100/80">
                                    <span>{status}</span>
                                    <span className="tabular-nums">{progress}%</span>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                                    <div
                                        className="h-full rounded-full bg-amber-400 transition-[width] duration-150"
                                        style={{ width: `${Math.min(100, progress)}%` }}
                                    />
                                </div>
                            </div>
                        )}

                        <button
                            className="mt-3 w-full rounded-lg border border-amber-200/30 bg-amber-400/10 px-3 py-2.5 text-sm font-semibold text-amber-50 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={running || !needsDecimate}
                            onClick={preDecimate}
                        >
                            {busyAction === "decimate"
                                ? `Reducing… ${progress}%`
                                : !needsDecimate
                                    ? "Already at or below target"
                                    : `Reduce to ${formatTris(decimateTarget)} tris`}
                        </button>

                        {lastDecimate && lastDecimate.method !== "none" && (
                            <p className="mt-2 text-[11px] leading-5 text-zinc-400">
                                Last pass: {formatTris(lastDecimate.fromTriangles)} → {formatTris(lastDecimate.toTriangles)}{" "}
                                via {lastDecimate.method === "meshopt" ? "meshoptimizer" : "grid fallback"}.
                                This mesh is now the remesh source.
                            </p>
                        )}
                        {!lastDecimate && needLevel !== "none" && (
                            <p className="mt-2 text-[11px] leading-5 text-zinc-500">
                                {needLevel === "required"
                                    ? "This mesh is large — pre-decimate before remesh or it may be slow or fail."
                                    : needLevel === "recommended"
                                        ? "Pre-decimate for faster, more reliable remesh on heavy inputs."
                                        : "Optional: lower density if remesh feels slow."}
                            </p>
                        )}
                        {needLevel === "none" && (
                            <p className="mt-2 text-[11px] leading-5 text-zinc-500">
                                Mesh is already in a comfortable range for remesh. Pre-decimate only if you want fewer tris.
                            </p>
                        )}
                    </div>

                    <button className="w-full rounded-lg bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40" disabled={running} onClick={run}>
                        {busyAction === "remesh" ? `Remeshing… ${progress}%` : "Remesh model"}
                    </button>
                    <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-zinc-400">{status}</div>
                    {error && <div className="rounded-lg border border-red-400/20 bg-red-950/30 p-3 text-xs leading-5 text-red-300">{error}</div>}

                    {result && outputFaces && (
                        <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
                            <div className="flex justify-between"><span className="text-zinc-500">Output</span><span>{outputFaces.quads.toLocaleString()} quads{outputFaces.triangles ? ` + ${outputFaces.triangles} triangles` : ""}</span></div>
                            <div className="flex justify-between"><span className="text-zinc-500">Time</span><span>{(result.processingTimeMs / 1000).toFixed(1)}s</span></div>
                            {result.quality === "near-sealed" && <div className="rounded-md border border-amber-300/20 bg-amber-950/30 p-2 text-xs leading-5 text-amber-200">Remeshed successfully, but {result.watertight ? "" : "a small boundary remains. "}Inspect the surface before export.</div>}
                            <div className="grid grid-cols-2 gap-2 pt-1">
                                <button className={`rounded-md px-3 py-2 text-xs ${!viewResult ? "bg-white text-black" : "bg-white/10"}`} onClick={() => setViewResult(false)}>Original</button>
                                <button className={`rounded-md px-3 py-2 text-xs ${viewResult ? "bg-white text-black" : "bg-white/10"}`} onClick={() => setViewResult(true)}>Quads</button>
                            </div>
                            <button className="w-full rounded-md border border-white/10 px-3 py-2 text-xs hover:bg-white/10" onClick={download}>Download OBJ</button>
                        </div>
                    )}
                </div>
            </aside>
        </main>
    );
}