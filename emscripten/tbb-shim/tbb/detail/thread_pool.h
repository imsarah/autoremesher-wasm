/*
 * Minimal fixed-size thread pool backing the tbb shim's parallel_for in
 * the pthreads (-pthread) WASM build.
 *
 * Deadlock rule: a parallel_for issued from inside a pool worker runs
 * sequentially on that worker instead of enqueuing (nested waits could
 * otherwise exhaust the pool). This mirrors how the upstream code uses
 * TBB: one outer loop over mesh islands, inner loops over vertices.
 */
#ifndef AUTOREMESHER_WASM_TBB_SHIM_THREAD_POOL_H
#define AUTOREMESHER_WASM_TBB_SHIM_THREAD_POOL_H

#if defined(__EMSCRIPTEN_PTHREADS__) || AUTOREMESHER_TBB_SHIM_FORCE_THREADS

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace tbb {
namespace shim_detail {

class ThreadPool {
public:
    static ThreadPool& instance()
    {
        static ThreadPool pool;
        return pool;
    }

    static bool onPoolThread()
    {
        return s_onPoolThread;
    }

    unsigned concurrency() const { return m_concurrency; }

    /* Runs fn(chunkIndex) for chunkIndex in [0, chunkCount) across the
     * pool, blocking until every chunk finished.
     *
     * The chunk state is shared-owned by every enqueued task: a task
     * may only get picked up by a worker AFTER all chunks were already
     * drained by faster lanes (runChunks has returned by then). Such a
     * straggler must find valid state and no work, not a dangling stack
     * frame. */
    void runChunks(unsigned chunkCount, const std::function<void(unsigned)>& fn)
    {
        struct ChunkState {
            std::atomic<unsigned> nextChunk { 0 };
            std::atomic<unsigned> doneChunks { 0 };
            std::mutex doneMutex;
            std::condition_variable doneCondition;
            std::function<void(unsigned)> fn;
            unsigned chunkCount = 0;
        };
        auto state = std::make_shared<ChunkState>();
        state->fn = fn;
        state->chunkCount = chunkCount;

        auto worker = [state]() {
            for (;;) {
                const unsigned chunk = state->nextChunk.fetch_add(1);
                if (chunk >= state->chunkCount)
                    break;
                state->fn(chunk);
                if (state->doneChunks.fetch_add(1) + 1 == state->chunkCount) {
                    std::lock_guard<std::mutex> lock(state->doneMutex);
                    state->doneCondition.notify_all();
                }
            }
        };

        {
            std::lock_guard<std::mutex> lock(m_taskMutex);
            for (unsigned i = 0; i + 1 < m_concurrency && i + 1 < chunkCount; ++i)
                m_tasks.push_back(worker);
        }
        m_taskCondition.notify_all();

        // The calling thread participates too, so a pool of N threads
        // gives N+1 lanes and the caller never just idles.
        worker();

        std::unique_lock<std::mutex> lock(state->doneMutex);
        state->doneCondition.wait(lock, [&]() {
            return state->doneChunks.load() >= state->chunkCount;
        });
    }

private:
    ThreadPool()
    {
        unsigned hardware = std::thread::hardware_concurrency();
        if (hardware < 2)
            hardware = 2;
        // Threads beyond the caller's lane; keep one core for the
        // embedder's event loop.
        m_concurrency = hardware;
        const unsigned workerCount = hardware > 1 ? hardware - 1 : 1;
        std::atomic<unsigned> started(0);
        for (unsigned i = 0; i < workerCount; ++i) {
            m_threads.emplace_back([this, &started]() {
                s_onPoolThread = true;
                started.fetch_add(1);
                for (;;) {
                    std::function<void()> task;
                    {
                        std::unique_lock<std::mutex> lock(m_taskMutex);
                        m_taskCondition.wait(lock, [this]() {
                            return m_shutdown || !m_tasks.empty();
                        });
                        if (m_shutdown && m_tasks.empty())
                            return;
                        task = std::move(m_tasks.front());
                        m_tasks.pop_front();
                    }
                    task();
                }
            });
        }
        // Barrier: never leave a pool thread half-booted. A worker that
        // is still starting when the embedder's process exits would be
        // torn down mid-boot (observed as "null function" crashes in
        // Emscripten worker teardown).
        while (started.load() < workerCount)
            std::this_thread::yield();
    }

    ~ThreadPool()
    {
        {
            std::lock_guard<std::mutex> lock(m_taskMutex);
            m_shutdown = true;
        }
        m_taskCondition.notify_all();
        for (auto& thread : m_threads)
            thread.join();
    }

    static thread_local bool s_onPoolThread;

    unsigned m_concurrency = 2;
    std::vector<std::thread> m_threads;
    std::deque<std::function<void()>> m_tasks;
    std::mutex m_taskMutex;
    std::condition_variable m_taskCondition;
    bool m_shutdown = false;
};

inline thread_local bool ThreadPool::s_onPoolThread = false;

}
}

#endif

#endif
