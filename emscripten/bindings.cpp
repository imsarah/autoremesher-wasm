/*
 * WebAssembly binding layer for AutoRemesher.
 *
 * Exposes a small C ABI around AutoRemesher::AutoRemesher that the
 * TypeScript wrapper drives through cwrap/HEAP views:
 *
 *   ar_remesh(...)          run remeshing synchronously, returns 0 on success
 *   ar_get_vertices()       pointer to result vertex buffer (xyz doubles -> f32)
 *   ar_get_vertex_count()
 *   ar_get_quads()          pointer to result quad index buffer (4 per face)
 *   ar_get_quad_count()
 *   ar_get_error()          human readable error for the last ar_remesh call
 *   ar_release()            free result buffers
 *   ar_malloc/ar_free       scratch allocations for input buffers
 *
 * Faces are always emitted as quads (4 indices). A triangle produced by
 * the extractor is encoded with its last index repeated (i2 == i3), the
 * common convention consumers can detect cheaply.
 *
 * Progress is reported through the ar_emit_progress EM_JS hook, which
 * forwards to Module.onRemeshProgress if the embedder installed one.
 */

#include <AutoRemesher/AutoRemesher>
#include <geogram/basic/common.h>
#include <geogram/basic/process.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iostream>
#include <streambuf>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

std::vector<float> g_resultVertices;
std::vector<std::uint32_t> g_resultQuads;
std::string g_lastError;
bool g_geogramInitialized = false;

#ifdef __EMSCRIPTEN_PTHREADS__
/*
 * In the pthreads build every stdout/stderr write from a worker thread
 * is a synchronous proxied call to the main browser/Node thread — which
 * sits inside ar_remesh and cannot service it until its own island is
 * done. The engine logs thousands of diagnostic lines per island, so
 * proxied logging serializes the whole parallel phase (measured ~20x
 * slowdown). Discard C++ stream output inside WASM instead; it never
 * reaches the JS boundary.
 */
class NullStreamBuffer : public std::streambuf {
protected:
    int overflow(int ch) override { return ch; }
    std::streamsize xsputn(const char*, std::streamsize count) override { return count; }
};
NullStreamBuffer g_nullStreamBuffer;
#endif

void ensureGeogramInitialized()
{
    if (g_geogramInitialized)
        return;
    // Skip signal/FPE handler installation: not meaningful inside a
    // WASM sandbox and Emscripten only partially emulates signals.
    GEO::initialize(GEO::GEOGRAM_NO_HANDLER);
#ifdef __EMSCRIPTEN_PTHREADS__
    // Parallelism comes from the island-level thread pool (tbb shim).
    // Letting geogram spawn its own worker threads on top would exceed
    // the preallocated Emscripten pthread pool while the calling thread
    // is blocked inside ar_remesh, deadlocking or crashing worker boot.
    GEO::Process::enable_multithreading(false);
    std::cout.rdbuf(&g_nullStreamBuffer);
    std::cerr.rdbuf(&g_nullStreamBuffer);
    std::clog.rdbuf(&g_nullStreamBuffer);
#endif
    g_geogramInitialized = true;
}

}

#ifdef __EMSCRIPTEN__
EM_JS(void, ar_emit_progress, (float progress, const char* status), {
    if (typeof Module !== "undefined" && typeof Module.onRemeshProgress === "function") {
        Module.onRemeshProgress(progress, status ? UTF8ToString(status) : "");
    }
});
#else
static void ar_emit_progress(float, const char*) { }
#endif

namespace {

void progressHandler(void* /*tag*/, float progress, const char* status)
{
    ar_emit_progress(progress, status);
}

}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* ar_malloc(std::uint32_t size)
{
    return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void ar_free(void* ptr)
{
    std::free(ptr);
}

EMSCRIPTEN_KEEPALIVE
void ar_release()
{
    g_resultVertices.clear();
    g_resultVertices.shrink_to_fit();
    g_resultQuads.clear();
    g_resultQuads.shrink_to_fit();
}

EMSCRIPTEN_KEEPALIVE
const char* ar_get_error()
{
    return g_lastError.c_str();
}

EMSCRIPTEN_KEEPALIVE
const float* ar_get_vertices()
{
    return g_resultVertices.data();
}

EMSCRIPTEN_KEEPALIVE
std::uint32_t ar_get_vertex_count()
{
    return static_cast<std::uint32_t>(g_resultVertices.size() / 3);
}

EMSCRIPTEN_KEEPALIVE
const std::uint32_t* ar_get_quads()
{
    return g_resultQuads.data();
}

EMSCRIPTEN_KEEPALIVE
std::uint32_t ar_get_quad_count()
{
    return static_cast<std::uint32_t>(g_resultQuads.size() / 4);
}

/*
 * Runs quad remeshing.
 *
 * vertices:        xyz triples, vertexCount * 3 floats
 * triangles:       vertex indices, triangleCount * 3 uint32
 * targetTriangleCount: approximate output density; 0 keeps the
 *                  remesher's automatic default
 * scaling:         edge scaling factor; <= 0 keeps the default
 * adaptivity:      curvature adaptivity in [0, 1]
 * sharpEdgeDegrees: dihedral angle threshold treated as a sharp edge
 * smoothNormalDegrees: threshold for normal smoothing (0 disables)
 * modelType:       0 = organic, 1 = hard surface
 *
 * Returns 0 on success, negative error code otherwise.
 */
EMSCRIPTEN_KEEPALIVE
int ar_remesh(const float* vertices, std::uint32_t vertexCount,
    const std::uint32_t* triangles, std::uint32_t triangleCount,
    std::uint32_t targetTriangleCount,
    float scaling,
    float adaptivity,
    float sharpEdgeDegrees,
    float smoothNormalDegrees,
    int modelType)
{
    g_lastError.clear();
    ar_release();

    if (vertices == nullptr || vertexCount == 0) {
        g_lastError = "Input vertex buffer is empty";
        return -1;
    }
    if (triangles == nullptr || triangleCount == 0) {
        g_lastError = "Input triangle buffer is empty";
        return -1;
    }

    try {
        ensureGeogramInitialized();

        std::vector<AutoRemesher::Vector3> inputVertices;
        inputVertices.reserve(vertexCount);
        for (std::uint32_t i = 0; i < vertexCount; ++i) {
            inputVertices.emplace_back(
                static_cast<double>(vertices[i * 3 + 0]),
                static_cast<double>(vertices[i * 3 + 1]),
                static_cast<double>(vertices[i * 3 + 2]));
        }

        std::vector<std::vector<size_t>> inputTriangles;
        inputTriangles.reserve(triangleCount);
        for (std::uint32_t i = 0; i < triangleCount; ++i) {
            const std::uint32_t a = triangles[i * 3 + 0];
            const std::uint32_t b = triangles[i * 3 + 1];
            const std::uint32_t c = triangles[i * 3 + 2];
            if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
                g_lastError = "Triangle index out of range";
                return -2;
            }
            inputTriangles.push_back({ a, b, c });
        }

        AutoRemesher::AutoRemesher remesher(inputVertices, inputTriangles);
        // A zero scaling collapses the parameterization (the core passes it
        // to the parameterizer unconditionally); the upstream CLI default
        // is 1.0. Likewise a zero target triangle count would divide by
        // zero in the voxel-size computation, so default to keeping the
        // input density.
        remesher.setScaling(scaling > 0.0f ? static_cast<double>(scaling) : 1.0);
        remesher.setTargetTriangleCount(
            targetTriangleCount > 0 ? targetTriangleCount : triangleCount);
        remesher.setModelType(modelType == 1
                ? AutoRemesher::ModelType::HardSurface
                : AutoRemesher::ModelType::Organic);
        remesher.setGradientAdaptivity(static_cast<double>(adaptivity));
        if (sharpEdgeDegrees >= 0.0f)
            remesher.setSharpEdgeDegrees(static_cast<double>(sharpEdgeDegrees));
        if (smoothNormalDegrees > 0.0f)
            remesher.setSmoothNormalDegrees(static_cast<double>(smoothNormalDegrees));
        remesher.setProgressHandler(progressHandler);

        if (!remesher.remesh()) {
            g_lastError = "Remeshing failed; the input mesh may be degenerate or non-manifold";
            return -3;
        }

        const auto& outVertices = remesher.remeshedVertices();
        const auto& outQuads = remesher.remeshedQuads();

        if (outVertices.empty() || outQuads.empty()) {
            g_lastError = "Remeshing produced an empty mesh";
            return -4;
        }

        g_resultVertices.reserve(outVertices.size() * 3);
        for (const auto& v : outVertices) {
            g_resultVertices.push_back(static_cast<float>(v.x()));
            g_resultVertices.push_back(static_cast<float>(v.y()));
            g_resultVertices.push_back(static_cast<float>(v.z()));
        }

        g_resultQuads.reserve(outQuads.size() * 4);
        for (const auto& face : outQuads) {
            if (face.size() == 4) {
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[0]));
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[1]));
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[2]));
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[3]));
            } else if (face.size() == 3) {
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[0]));
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[1]));
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[2]));
                g_resultQuads.push_back(static_cast<std::uint32_t>(face[2]));
            }
        }

        ar_emit_progress(1.0f, "Done");
        return 0;
    } catch (const std::exception& e) {
        g_lastError = std::string("Remeshing threw an exception: ") + e.what();
        ar_release();
        return -5;
    } catch (...) {
        g_lastError = "Remeshing threw an unknown exception";
        ar_release();
        return -5;
    }
}

}
