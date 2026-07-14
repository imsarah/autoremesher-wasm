/**
 * Public types for @autoremesher/wasm.
 */
/** Error thrown when the native remesher reports a failure. */
export class AutoRemesherError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "AutoRemesherError";
        this.code = code;
    }
}
