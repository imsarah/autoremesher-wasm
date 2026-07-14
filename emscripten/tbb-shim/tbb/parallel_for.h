/*
 * Drop-in replacement for <tbb/parallel_for.h>.
 *
 * Single-threaded build: invokes the body once over the full range.
 * Pthreads build (__EMSCRIPTEN_PTHREADS__): splits the range into
 * chunks executed on a shared thread pool. Nested calls degrade to
 * sequential execution (see detail/thread_pool.h).
 *
 * Works with both lambda bodies and functor classes that implement
 * operator()(const blocked_range<T>&) const.
 */
#ifndef AUTOREMESHER_WASM_TBB_SHIM_PARALLEL_FOR_H
#define AUTOREMESHER_WASM_TBB_SHIM_PARALLEL_FOR_H

#include <tbb/blocked_range.h>

#if defined(__EMSCRIPTEN_PTHREADS__) || AUTOREMESHER_TBB_SHIM_FORCE_THREADS
#include <tbb/detail/thread_pool.h>
#endif

namespace tbb {

#if defined(__EMSCRIPTEN_PTHREADS__) || AUTOREMESHER_TBB_SHIM_FORCE_THREADS

template <typename Range, typename Body>
void parallel_for(const Range& range, const Body& body)
{
    if (range.empty())
        return;

    auto& pool = shim_detail::ThreadPool::instance();
    const auto size = range.size();
    unsigned chunkCount = pool.concurrency();
    if (shim_detail::ThreadPool::onPoolThread() || size < 2 || chunkCount < 2) {
        body(range);
        return;
    }
    if (static_cast<decltype(size)>(chunkCount) > size)
        chunkCount = static_cast<unsigned>(size);

    const auto begin = range.begin();
    const auto chunkSize = (size + chunkCount - 1) / chunkCount;
    pool.runChunks(chunkCount, [&](unsigned chunk) {
        const auto chunkBegin = begin + static_cast<decltype(size)>(chunk) * chunkSize;
        auto chunkEnd = chunkBegin + chunkSize;
        const auto end = begin + size;
        if (chunkEnd > end)
            chunkEnd = end;
        if (chunkBegin < chunkEnd)
            body(Range(chunkBegin, chunkEnd));
    });
}

template <typename Index, typename Function>
void parallel_for(Index first, Index last, const Function& function)
{
    parallel_for(blocked_range<Index>(first, last), [&](const blocked_range<Index>& r) {
        for (Index i = r.begin(); i < r.end(); ++i)
            function(i);
    });
}

#else

template <typename Range, typename Body>
void parallel_for(const Range& range, const Body& body)
{
    if (!range.empty())
        body(range);
}

template <typename Index, typename Function>
void parallel_for(Index first, Index last, const Function& function)
{
    for (Index i = first; i < last; ++i)
        function(i);
}

#endif

}

#endif
