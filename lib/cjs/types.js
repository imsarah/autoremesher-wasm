"use strict";
/**
 * Public types for @autoremesher/wasm.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoRemesherError = void 0;
/** Error thrown when the native remesher reports a failure. */
class AutoRemesherError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "AutoRemesherError";
        this.code = code;
    }
}
exports.AutoRemesherError = AutoRemesherError;
