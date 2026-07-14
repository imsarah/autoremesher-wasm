/**
 * Post-processes the dual tsc output in lib/:
 *  - marks lib/esm as ESM and lib/cjs as CommonJS (the package root is
 *    "type": "module")
 *  - replaces lib/cjs/glue-loader.js with a CJS-safe implementation:
 *    tsc downlevels import() to require(), which cannot load the ESM
 *    Emscripten glue on Node < 22, so the CJS build imports it through
 *    a file URL and an un-transpiled dynamic import.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

mkdirSync(join(root, "lib/esm"), { recursive: true });
mkdirSync(join(root, "lib/cjs"), { recursive: true });

writeFileSync(join(root, "lib/esm/package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
writeFileSync(join(root, "lib/cjs/package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");

const cjsGlueLoader = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadGlueFactory = loadGlueFactory;
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Evaluated import() so TypeScript/CommonJS tooling does not turn it
// into require(): the Emscripten glue is an ES module.
const dynamicImport = new Function("specifier", "return import(specifier)");

async function loadGlueFactory(threaded) {
    const basename = threaded ? "autoremesher-mt.mjs" : "autoremesher.mjs";
    const glueUrl = pathToFileURL(path.join(__dirname, "..", "..", "wasm", basename)).href;
    const glue = await dynamicImport(glueUrl);
    return glue.default ?? glue;
}
`;
writeFileSync(join(root, "lib/cjs/glue-loader.js"), cjsGlueLoader);

console.log("postbuild: wrote lib/{esm,cjs}/package.json and CJS glue loader");
