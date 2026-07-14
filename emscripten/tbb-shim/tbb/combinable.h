/*
 * Drop-in replacement for <tbb/combinable.h>.
 *
 * Single-threaded build: exactly one slot.
 * Pthreads build: one slot per thread id, guarded by a mutex (the
 * upstream code only calls local() inside hot loops on a handful of
 * threads, so a map + mutex is plenty).
 */
#ifndef AUTOREMESHER_WASM_TBB_SHIM_COMBINABLE_H
#define AUTOREMESHER_WASM_TBB_SHIM_COMBINABLE_H

#include <utility>

#if defined(__EMSCRIPTEN_PTHREADS__) || AUTOREMESHER_TBB_SHIM_FORCE_THREADS
#include <functional>
#include <map>
#include <mutex>
#include <thread>
#endif

namespace tbb {

#if defined(__EMSCRIPTEN_PTHREADS__) || AUTOREMESHER_TBB_SHIM_FORCE_THREADS

template <typename T>
class combinable {
public:
    combinable()
        : m_init([]() { return T(); })
    {
    }

    template <typename FInit>
    explicit combinable(FInit finit)
        : m_init(finit)
    {
    }

    T& local()
    {
        const std::thread::id id = std::this_thread::get_id();
        std::lock_guard<std::mutex> lock(m_mutex);
        auto found = m_slots.find(id);
        if (found == m_slots.end())
            found = m_slots.emplace(id, m_init()).first;
        return found->second;
    }

    T& local(bool& exists)
    {
        const std::thread::id id = std::this_thread::get_id();
        std::lock_guard<std::mutex> lock(m_mutex);
        auto found = m_slots.find(id);
        exists = found != m_slots.end();
        if (!exists)
            found = m_slots.emplace(id, m_init()).first;
        return found->second;
    }

    template <typename FCombine>
    T combine(FCombine combineFn)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_slots.empty())
            return m_init();
        auto it = m_slots.begin();
        T result = it->second;
        for (++it; it != m_slots.end(); ++it)
            result = combineFn(result, it->second);
        return result;
    }

    template <typename Func>
    void combine_each(Func f)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        for (auto& entry : m_slots)
            f(entry.second);
    }

    void clear()
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_slots.clear();
    }

private:
    std::function<T()> m_init;
    std::map<std::thread::id, T> m_slots;
    std::mutex m_mutex;
};

#else

template <typename T>
class combinable {
public:
    combinable()
        : m_value()
    {
    }

    template <typename FInit>
    explicit combinable(FInit finit)
        : m_value(finit())
    {
    }

    T& local() { return m_value; }
    T& local(bool& exists)
    {
        exists = true;
        return m_value;
    }

    template <typename FCombine>
    T combine(FCombine)
    {
        return m_value;
    }

    template <typename Func>
    void combine_each(Func f)
    {
        f(m_value);
    }

    void clear() { m_value = T(); }

private:
    T m_value;
};

#endif

}

#endif
