/*
 * Force-included (-include) compatibility header for the single-threaded
 * Emscripten build.
 *
 * libc++ hides std::this_thread::sleep_for when threads are disabled,
 * but autoremesher.cpp calls it inside a progress spinlock guard. With a
 * single thread the lock can never be contended, so the sleeping branch
 * is unreachable — a no-op implementation is safe and keeps the upstream
 * submodule unpatched.
 */
#ifndef AUTOREMESHER_WASM_COMPAT_H
#define AUTOREMESHER_WASM_COMPAT_H

#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__) && defined(__cplusplus)

#include <chrono>
#include <thread>

/* libc++ <= 19 spells it _LIBCPP_HAS_NO_THREADS; newer libc++ uses
 * _LIBCPP_HAS_THREADS with a 0/1 value. */
#if defined(_LIBCPP_HAS_NO_THREADS) || (defined(_LIBCPP_HAS_THREADS) && !_LIBCPP_HAS_THREADS)
namespace std {
namespace this_thread {
    template <class Rep, class Period>
    inline void sleep_for(const std::chrono::duration<Rep, Period>&)
    {
        // Unreachable in a single-threaded runtime; nothing to do.
    }
}
}
#endif

#endif

#endif
