# Browser demo — `@autoremesher/wasm`

Vite + React + Three.js playground for trying `@autoremesher/wasm` in the browser.

## Run

```bash
# from package root
npm run demo:install
npm run demo
```

```bash
# or here
npm install
npm run dev
```

Open http://localhost:5173

## Features

- Sphere sample + upload (GLB / glTF / FBX / OBJ / STL)
- Pre-decimate large meshes in a worker
- Remesh via `@autoremesher/wasm` (single-thread, deterministic)
- Original / quads view, download OBJ

## Notes

- Depends on the parent package: `"@autoremesher/wasm": "file:../.."`
- Parent `lib/` and `wasm/` must exist (committed in the repo)
- Dev server enables COOP/COEP headers (optional pthreads experiments)
