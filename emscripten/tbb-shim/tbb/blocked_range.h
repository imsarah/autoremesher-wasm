/*
 * Sequential drop-in replacement for <tbb/blocked_range.h>.
 *
 * The WASM build runs single-threaded, so a blocked_range simply
 * describes the whole iteration space at once.
 */
#ifndef AUTOREMESHER_WASM_TBB_SHIM_BLOCKED_RANGE_H
#define AUTOREMESHER_WASM_TBB_SHIM_BLOCKED_RANGE_H

#include <cstddef>

namespace tbb {

template <typename Value>
class blocked_range {
public:
    typedef Value const_iterator;
    typedef std::size_t size_type;

    blocked_range(Value begin, Value end, size_type grainsize = 1)
        : m_begin(begin)
        , m_end(end)
        , m_grainsize(grainsize)
    {
    }

    const_iterator begin() const { return m_begin; }
    const_iterator end() const { return m_end; }
    size_type size() const { return static_cast<size_type>(m_end - m_begin); }
    size_type grainsize() const { return m_grainsize; }
    bool empty() const { return !(m_begin < m_end); }

private:
    Value m_begin;
    Value m_end;
    size_type m_grainsize;
};

}

#endif
