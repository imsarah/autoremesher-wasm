/**
 * Node example: remesh an OBJ file from disk and write the quad OBJ back.
 *
 *   node examples/node-remesh.mjs input.obj output.obj [targetQuads]
 */
import { readFile, writeFile } from "node:fs/promises";
import { remesh, resultToObj } from "../lib/esm/index.js";

const [inputPath, outputPath, targetQuadsArg] = process.argv.slice(2);
if (!inputPath || !outputPath) {
    console.error("usage: node examples/node-remesh.mjs input.obj output.obj [targetQuads]");
    process.exit(1);
}

const objText = await readFile(inputPath, "utf8");
const result = await remesh(objText, {
    targetQuads: targetQuadsArg ? parseInt(targetQuadsArg, 10) : 2000,
    onProgress: (progress, status) => {
        process.stdout.write(`\r${(progress * 100).toFixed(0).padStart(3)}% ${status}          `);
    },
});
process.stdout.write("\n");

console.log(`vertices: ${result.vertices.length / 3}`);
console.log(`quads: ${result.quadCount}`);
console.log(`time: ${result.processingTimeMs.toFixed(0)} ms`);

await writeFile(outputPath, resultToObj(result));
console.log(`wrote ${outputPath}`);
