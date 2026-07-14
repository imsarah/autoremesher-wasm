"use strict";
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
