import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(rootDir, "../..");

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            // Local package root (uses package.json "exports" → lib/esm + wasm).
            "@autoremesher/wasm": packageRoot,
            // geometry.js imports meshoptimizer; resolve from this demo's install.
            meshoptimizer: path.join(rootDir, "node_modules/meshoptimizer"),
        },
    },
    worker: {
        format: "es",
    },
    server: {
        fs: {
            // Allow importing WASM glue from the package root.
            allow: [packageRoot, rootDir],
        },
        headers: {
            // Not required for single-thread remesh; handy if you switch to pthreads.
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        },
    },
    optimizeDeps: {
        exclude: ["@autoremesher/wasm"],
    },
    build: {
        target: "esnext",
    },
});
