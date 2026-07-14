import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(rootDir, "../..");

/**
 * Keep Emscripten glue's `import("node:…")` as real external imports.
 * Without this, Vite rewrites them to unrelated app chunks (e.g. the
 * remesh worker) and the WASM factory breaks in the browser.
 */
function externalizeNodeBuiltins(): Plugin {
    return {
        name: "externalize-node-builtins",
        enforce: "pre",
        resolveId(id) {
            if (id.startsWith("node:"))
                return { id, external: true };
            return null;
        },
    };
}

const coopCoepHeaders = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    // Same-origin WASM/workers under COEP.
    "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
    plugins: [react(), tailwindcss(), externalizeNodeBuiltins()],
    resolve: {
        alias: [
            // Short export form: @autoremesher/wasm/autoremesher.wasm → wasm/…
            {
                find: /^@autoremesher\/wasm\/(autoremesher(?:-mt)?\.(?:mjs|wasm))$/,
                replacement: path.join(packageRoot, "wasm", "$1"),
            },
            // Long form must not become packageRoot/wasm/wasm/…
            {
                find: /^@autoremesher\/wasm\/wasm\/(.*)$/,
                replacement: path.join(packageRoot, "wasm", "$1"),
            },
            // Package root (main entry / subpaths via package.json exports).
            {
                find: "@autoremesher/wasm",
                replacement: packageRoot,
            },
            // geometry.js imports meshoptimizer; resolve from this demo's install.
            {
                find: "meshoptimizer",
                replacement: path.join(rootDir, "node_modules/meshoptimizer"),
            },
        ],
    },
    worker: {
        format: "es",
        plugins: () => [externalizeNodeBuiltins()],
    },
    assetsInclude: ["**/*.wasm"],
    server: {
        fs: {
            // Allow importing WASM glue from the package root.
            allow: [packageRoot, rootDir],
        },
        headers: coopCoepHeaders,
    },
    preview: {
        headers: coopCoepHeaders,
    },
    optimizeDeps: {
        exclude: ["@autoremesher/wasm"],
    },
    build: {
        target: "esnext",
    },
});
