/*
 * Sequential drop-in replacement for <tbb/mutex.h>.
 * Backed by std::mutex (a no-op cost in the single-threaded WASM build).
 */
#ifndef AUTOREMESHER_WASM_TBB_SHIM_MUTEX_H
#define AUTOREMESHER_WASM_TBB_SHIM_MUTEX_H

#include <mutex>

namespace tbb {

class mutex {
public:
    void lock() { m_mutex.lock(); }
    void unlock() { m_mutex.unlock(); }
    bool try_lock() { return m_mutex.try_lock(); }

    class scoped_lock {
    public:
        scoped_lock()
            : m_mutex(nullptr)
        {
        }
        explicit scoped_lock(mutex& m)
            : m_mutex(&m)
        {
            m_mutex->lock();
        }
        ~scoped_lock()
        {
            if (m_mutex)
                m_mutex->unlock();
        }
        void acquire(mutex& m)
        {
            if (m_mutex)
                m_mutex->unlock();
            m_mutex = &m;
            m_mutex->lock();
        }
        void release()
        {
            if (m_mutex) {
                m_mutex->unlock();
                m_mutex = nullptr;
            }
        }

    private:
        mutex* m_mutex;
    };

private:
    std::mutex m_mutex;
};

}

#endif
