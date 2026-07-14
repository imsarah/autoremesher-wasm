# @autoremesher/wasm

**Automatic quad remeshing in the browser and Node.js** — powered by WebAssembly.

This project ports [AutoRemesher](https://github.com/huxingyi/autoremesher) (Jeremy Hu) to WebAssembly and wraps it in a small TypeScript-first API. Give it a triangle mesh; get back a **quad-dominant** mesh suitable for subdivision, look-dev, and further modeling.

```bash
npm install @autoremesher/wasm
```

```ts
import { remesh } from "@autoremesher/wasm";

const result = await remesh(
  { vertices, indices }, // Float32Array xyz + Uint32Array triangles
  { targetQuads: 2000 }
);

// result.quads     — 4 indices per face (true quads + rare tris)
// result.indices   — triangulated for GPU / Three.js
// result.vertices  — remeshed positions
// result.quality   — "remeshed" | "near-sealed"
// result.watertight
```

> **Status:** `0.2.x` — open-source beta. Works well on clean, closed organic meshes. Hard-surface, scans, and multi-part exports are improving; expect retries or errors on pathological topology. Use a Web Worker in the browser so the UI stays responsive.

---

## Features

- **Quad-dominant remesh** — native AutoRemesher / MIQ pipeline in WASM  
- **TypeScript-first** — full `.d.ts` types, ESM + CommonJS  
- **Flexible inputs** — raw buffers, OBJ text, GLB / glTF, or a Three.js `BufferGeometry`-like object  
- **Self-contained** — ~1.1 MB single-thread WASM (+ optional pthreads build), no native install  
- **Browser + Node** — same API; Node example included  
- **UV re-projection** — closest-point transfer when the input has UVs  
- **Quality gates** — topology checks, density scoring, safe hole fill, explicit `quality` / `watertight` on the result  
- **Optional threads** — pthreads binary for multi-island speedups (needs COOP/COEP in browsers)

## Repository layout

This repository is the full open-source package:

```text
.
├── src/              TypeScript API (source of truth)
├── lib/              Built ESM + CJS + types
├── wasm/             Prebuilt .mjs + .wasm (st + mt)
├── emscripten/       Bindings, shims, build scripts
├── cpp/              Vendored AutoRemesher + third-party C++
├── test/             Node test suite
├── examples/
│   ├── node-remesh.mjs   CLI sample
│   └── web/              Browser playground (Vite + React + Three)
├── package.json      @autoremesher/wasm
└── README.md
```

Prebuilt `lib/` and `wasm/` are committed so consumers and CI can install without the Emscripten SDK. Rebuild with `npm run build` when you change C++ or TypeScript.

## Installation

```bash
npm install @autoremesher/wasm
```

| Package | Role |
| --- | --- |
| `@autoremesher/wasm` | Core remesher (this package) |
| `meshoptimizer` | Runtime dependency (input decimation helpers) |
| `three` | **Optional** peer — only if you use `@autoremesher/wasm/three` |

## Quick start

### Raw buffers

```ts
import { remesh } from "@autoremesher/wasm";

const result = await remesh(
  {
    vertices: /* Float32Array length % 3 === 0 */,
    indices: /* Uint32Array length % 3 === 0 */,
  },
  {
    targetQuads: 2000,
    adaptivity: 0.5,
    onProgress: (p, status) => console.log(Math.round(p * 100), status),
  }
);

console.log(result.quadCount, result.quality, result.watertight);
```

### Three.js

```ts
import { remesh } from "@autoremesher/wasm";
import { fromBufferGeometry, toBufferGeometry } from "@autoremesher/wasm/three";

const result = await remesh(fromBufferGeometry(sourceGeometry), {
  targetQuads: 4000,
  adaptivity: 0.8,
});
mesh.geometry = toBufferGeometry(result);
```

You can also pass a `BufferGeometry` (or any object with the same shape) straight to `remesh()`. The core package never imports `three`.

### OBJ

```ts
import { remesh, resultToObj } from "@autoremesher/wasm";

const objText = await fetch("model.obj").then((r) => r.text());
const result = await remesh(objText, { targetQuads: 3000 });
const out = resultToObj(result); // native quad faces in OBJ
```

### GLB / glTF

```ts
import { remesh } from "@autoremesher/wasm";

const glb = await fetch("model.glb").then((r) => r.arrayBuffer());
const result = await remesh(glb, { targetQuads: 5000 });
```

Triangle primitives are merged before remeshing. External `.bin` URIs are not fetched — use GLB or embedded / data-URI buffers.

### Node.js

```js
import { remesh, resultToObj } from "@autoremesher/wasm";
import { readFile, writeFile } from "node:fs/promises";

const result = await remesh(await readFile("input.obj", "utf8"), {
  targetQuads: 2000,
  onProgress: (p, status) => console.log(`${(p * 100) | 0}% ${status}`),
});
await writeFile("output.obj", resultToObj(result));
```

See [`examples/node-remesh.mjs`](examples/node-remesh.mjs).

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `targetQuads` | `number` | ~1000 if unset | Approximate output face count. |
| `targetTriangleCount` | `number` | — | Raw engine density target; overrides `targetQuads`. |
| `edgeScaling` | `number` | `1.0` | Edge scale (CLI-style). Larger → bigger / fewer quads. Useful range ~1.0–2.0. |
| `sharpEdgeThreshold` | `number` | `90` | Dihedral angle (°) treated as a sharp feature. |
| `adaptivity` | `number` | `0.5`–`1.0` in practice | Curvature adaptivity in `[0, 1]`. |
| `smoothNormals` | `boolean` | `true` | Fill `result.normals`. |
| `smoothNormalDegrees` | `number` | `0` | Resampling normal smooth; `0` disables. |
| `modelType` | `"organic" \| "hardSurface"` | `"organic"` | Matches the desktop app switch. |
| `preserveSharpFeatures` | `boolean` | `false` | Shortcut for `hardSurface`. |
| `preserveUVs` | `boolean` | `true` if input has UVs | Closest-point UV transfer → `result.uvs`. |
| `allowHoles` | `boolean` | `false` | Allow open shells. When `false`, the pipeline tries to seal; large residual holes throw. |
| `maxParts` | `number` | `1` | How many connected shells to keep (largest first). |
| `minPartTriangles` | `number` | `32` | Drop smaller islands before remesh. |
| `maxInputTriangles` | `number` | auto | Soft cap; dense meshes are decimated with meshoptimizer before the native solve. |
| `onProgress` | `(progress, status) => void` | — | `progress` in `[0, 1]`. |
| `moduleOptions` | `ModuleLoadOptions` | — | WASM URL / binary / threads (first load per variant). |

### Result shape

| Field | Description |
| --- | --- |
| `vertices` | `Float32Array` positions (xyz) |
| `quads` | `Uint32Array`, 4 indices per face. A triangle is encoded as `i2 === i3`. |
| `indices` | Triangulated index buffer for rendering |
| `normals` | Optional smooth vertex normals |
| `uvs` | Optional re-projected UVs |
| `quadCount` | `quads.length / 4` |
| `watertight` | `true` if no boundary edges remain |
| `quality` | `"remeshed"` (closed / ok) or `"near-sealed"` (native remesh with a small residual boundary) |
| `processingTimeMs` | Wall time for the remesh |

Prefer checking `quality` / `watertight` before exporting production assets.

## Web Worker (recommended in browsers)

`remesh()` runs heavy WASM on the calling thread. Offload it:

```ts
// remesh.worker.ts
import { remesh } from "@autoremesher/wasm";

self.onmessage = async (event) => {
  const { id, vertices, indices, options } = event.data;
  try {
    const result = await remesh(
      { vertices, indices },
      {
        ...options,
        moduleOptions: { threads: false }, // deterministic single-thread path
        onProgress: (progress, status) =>
          self.postMessage({ id, type: "progress", progress, status }),
      }
    );
    const transfer = [
      result.vertices.buffer,
      result.indices.buffer,
      result.quads.buffer,
    ];
    if (result.normals) transfer.push(result.normals.buffer);
    self.postMessage({ id, type: "done", result }, { transfer });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
```

## Bundlers and WASM loading

The binary ships next to its glue:

- `wasm/autoremesher.mjs` + `wasm/autoremesher.wasm` (single-thread)
- `wasm/autoremesher-mt.mjs` + `wasm/autoremesher-mt.wasm` (pthreads)

Vite / webpack 5 usually resolve `new URL(..., import.meta.url)` inside the package. If assets are relocated:

```ts
import wasmUrl from "@autoremesher/wasm/autoremesher.wasm?url"; // Vite

await remesh(input, {
  targetQuads: 2000,
  moduleOptions: { wasmUrl },
});
```

`moduleOptions` also accepts `wasmBinary`, Emscripten `locateFile`, and `print` / `printErr`.

Warm the module early:

```ts
import { loadAutoRemesherModule } from "@autoremesher/wasm";
await loadAutoRemesherModule();
```

## Multithreading

```ts
await remesh(input, {
  moduleOptions: { threads: "auto" }, // or true / false
});
```

- **`"auto"`** — pthreads when `SharedArrayBuffer` is available (browsers need [COOP/COEP](https://web.dev/articles/coop-coep)).
- Use `threadsSupported()` to query the environment.
- Gains are mainly on multi-island meshes; single solids see less benefit.
- For a simple product path, prefer `threads: false`.

## UV / attribute transfer

When the source has UVs, `remesh()` fills `result.uvs` by default. For arbitrary attributes:

```ts
import { transferAttribute } from "@autoremesher/wasm";

const colors = transferAttribute(
  { vertices: srcPositions, indices: srcTriangles },
  srcColors,
  3,
  result.vertices
);
```

Closest-point sampling can smear UV islands at seams.

## Error handling

Failures reject with `AutoRemesherError` and a numeric `code`:

```ts
import { remesh, AutoRemesherError } from "@autoremesher/wasm";

try {
  await remesh(input, { targetQuads: 2000 });
} catch (error) {
  if (error instanceof AutoRemesherError) {
    console.error(error.code, error.message);
  }
}
```

Common cases: empty / invalid topology (`-101`, `-2`), collapsed or unusable solve (`-6`), residual holes when `allowHoles` is false (`-7`).

## Tips

- Prefer **closed** manifold meshes; weld UV seams before remesh when possible.  
- Start around **`targetQuads` 500–3000** for previews; raise carefully for density.  
- Very coarse targets on thin shapes can collapse — raise density or adjust `edgeScaling`.  
- Peak memory tracks the intermediate resample; terminate workers between large jobs.  
- Multi-object exports: keep `maxParts: 1` (default) unless you need several shells.

## Development

### Prerequisites

- **Node.js** ≥ 18  
- For WASM rebuilds: **CMake** ≥ 3.16 and the [Emscripten SDK](https://emscripten.org/)  
- TypeScript-only changes need only Node

### Scripts

```bash
npm install
npm run build:ts    # tsc → lib/ (ESM + CJS + types)
npm test            # node --test test/*.test.mjs
npm run build       # full: Emscripten WASM + TypeScript
```

Full native rebuild:

```bash
# Windows: use a bash-capable shell (Git Bash, WSL, etc.)
source /path/to/emsdk/emsdk_env.sh
npm run build:wasm
npm run build:ts
npm test
```

The Emscripten tree compiles AutoRemesher + a geogram 1.8.3 subset with Qt/TBB shims under `emscripten/`.

### Tests

```bash
npm test
```

Coverage includes remesh on closed primitives, UV transfer, format parsers, quality / hole policy, and CJS load.

## Contributing

Contributions are welcome.

1. Fork and clone this repository.  
2. `npm install` && `npm test`.  
3. Prefer small, focused PRs (API, quality gates, docs, or WASM build).  
4. Keep `npm test` green; add a test when you fix a failure mode.  
5. Do not commit local assets (`.stl` dumps, `test-out-*`, debug logs).

Please file issues with a short mesh description (closed/open, tri count, options) and, when possible, a minimal OBJ/GLB.

## Browser demo (included)

Full-viewport playground under [`examples/web`](examples/web): drag-and-drop mesh, pre-decimate large models, remesh in a Web Worker, inspect original vs quads, download OBJ.

```bash
# from the package root (lib/ is committed; rebuild with npm run build:ts if you change src/)
npm run demo:install
npm run demo
# → http://localhost:5173
```

Or:

```bash
cd examples/web
npm install
npm run dev
```

The demo links this package from the repo root (`file:../..`). Run it from a full clone of this repository.

## Roadmap

- [x] Single-thread WASM remesh + TypeScript API  
- [x] pthreads build behind COOP/COEP  
- [x] UV re-projection  
- [x] Topology / density quality gates + `quality` / `watertight`  
- [x] meshoptimizer pre-decimation for large inputs  
- [x] Browser demo playground (`examples/web`)  
- [ ] Better hard-surface / crease preservation  
- [ ] Feature curves / guide constraints (needs upstream engine support)  
- [ ] Smaller binary / streaming progress from native  

## License

MIT © Sarah Yung — see [LICENSE](LICENSE).

This package redistributes WebAssembly builds of third-party software. See **LICENSE** for full notices. Upstream projects include:

| Project | License | Link |
| --- | --- | --- |
| AutoRemesher | MIT | [huxingyi/autoremesher](https://github.com/huxingyi/autoremesher) |
| geogram | BSD-3-Clause | [BrunoLevy/geogram](https://github.com/BrunoLevy/geogram) |
| Eigen | MPL-2.0 | [eigen.tuxfamily.org](https://eigen.tuxfamily.org) |
| isotropicremesher | MIT | (vendored with AutoRemesher) |
| meshoptimizer | MIT | [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) |

## Acknowledgments

- [Jeremy Hu](https://github.com/huxingyi) — AutoRemesher  
- Geogram / OpenNL authors — parameterization and geometry kernels  
- Everyone who files issues and shares hard meshes  

---

**npm:** [`@autoremesher/wasm`](https://www.npmjs.com/package/@autoremesher/wasm)  
**Issues:** [GitHub Issues](https://github.com/imsarah/autoremesher-wasm/issues)
