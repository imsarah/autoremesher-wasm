import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import {
    ACCEPTED_FILES,
    makeAdvancedEditorSphere,
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
const DECIMATE_PRESETS = [10000, 25000, 50000, 100000, 250000, 500000];
const MAX_SOURCE_WIREFRAME_TRIANGLES = 100000;

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
    const [source, setSource] = useState<MeshData>(() => makeAdvancedEditorSphere());
    const [label, setLabel] = useState("Sample UV sphere");
    const [result, setResult] = useState<RemeshResult | null>(null);
    const [target, setTarget] = useState(1000);
    const [adaptivity, setAdaptivity] = useState(0.5);
    const [modelType, setModelType] = useState<"organic" | "hardSurface">("organic");
    const [sharpEdgeThreshold, setSharpEdgeThreshold] = useState(90);
    const [decimateTarget, setDecimateTarget] = useState(25000);
    const [viewResult, setViewResult] = useState(true);
    const [running, setRunning] = useState(false);
    const [busyAction, setBusyAction] = useState<"remesh" | "decimate" | null>(null);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("Ready");
    const [error, setError] = useState<string | null>(null);
    const inputTriangles = source.indices.length / 3;

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
        setSource(normalize ? normalizeMesh(mesh) : mesh);
        setLabel(name);
        setResult(null);
        setViewResult(false);
        setError(null);
        setStatus("Ready");
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
        setRunning(true);
        setBusyAction("decimate");
        setError(null);
        setProgress(0);
        setStatus(`Preparing ${decimateTarget.toLocaleString()} polygon target…`);

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
            setSource(normalizeMesh({ vertices: reduced.vertices, indices: reduced.indices }));
            setLabel((current) => `${current.replace(/ \(pre-decimated.*\)$/i, "")} (pre-decimated)`);
            setResult(null);
            setViewResult(false);
            setProgress(100);
            setStatus(`${reduced.toTriangles.toLocaleString()} polygons ready for remesh (${reduced.method})`);
        };
        instance.addEventListener("message", receive);
        const vertices = source.vertices.slice();
        const indices = source.indices.slice();
        instance.postMessage({
            id,
            type: "decimate",
            vertices,
            indices,
            maxTriangles: Math.max(1000, Math.floor(decimateTarget)),
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
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Remesh</p>
                    <h1 className="mt-2 text-2xl font-semibold">Clean quad topology</h1>
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

                    <div className="rounded-xl border border-amber-300/20 bg-amber-950/20 p-4">
                        <div className="text-sm font-semibold text-amber-100">Pre-decimate large model</div>
                        <p className="mt-1 text-xs leading-5 text-amber-100/60">Reduce million-polygon uploads in the worker before remeshing. This keeps the original shape while making the solver practical.</p>
                        <label className="mt-3 block text-xs font-medium text-amber-50">
                            Target triangles <span className="float-right text-amber-100/70">{decimateTarget.toLocaleString()}</span>
                            <select className="mt-2 w-full rounded-lg border border-amber-200/20 bg-black/20 px-3 py-2 text-sm text-zinc-100" value={decimateTarget} onChange={(event) => setDecimateTarget(Number(event.target.value))} disabled={running}>
                                {DECIMATE_PRESETS.map((preset) => <option key={preset} value={preset}>{preset.toLocaleString()} triangles (polygons)</option>)}
                            </select>
                        </label>
                        <button className="mt-3 w-full rounded-lg border border-amber-200/25 px-3 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-100/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={running || inputTriangles <= decimateTarget} onClick={preDecimate}>
                            {busyAction === "decimate" ? `Reducing… ${progress}%` : inputTriangles <= decimateTarget ? "Already below target" : "Pre-decimate model"}
                        </button>
                        <p className="mt-2 text-[11px] text-amber-100/50">Current: {inputTriangles.toLocaleString()} triangles. The reduced mesh becomes the new remesh source.</p>
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