#pragma once
//
// Minimal BitSet template — ported from Dolphin's Common/BitSet.h (CC0-1.0).
// Bit-exact API subset used by PPCAnalyst (CodeOp regsIn/regsOut/etc.).

#include <bit>
#include <cstddef>
#include <initializer_list>
#include <type_traits>

#include "bementalJIT/types.h"

namespace bemental::powerpc {

template <typename IntTy>
class BitSet {
    static_assert(!std::is_signed<IntTy>::value, "BitSet requires unsigned type");

public:
    class Ref {
    public:
        constexpr Ref(BitSet* bs, IntTy mask) : m_bs(bs), m_mask(mask) {}
        constexpr operator bool() const { return (m_bs->m_val & m_mask) != 0; }
        bool operator=(bool set) {
            m_bs->m_val = (m_bs->m_val & ~m_mask) | (set ? m_mask : 0);
            return set;
        }
    private:
        BitSet* m_bs;
        IntTy m_mask;
    };

    class Iterator {
    public:
        constexpr Iterator(IntTy val, int bit) : m_val(val), m_bit(bit) {}
        Iterator& operator++() {
            if (m_val == 0) { m_bit = -1; }
            else {
                int bit = std::countr_zero(m_val);
                m_val &= ~(IntTy{1} << bit);
                m_bit = bit;
            }
            return *this;
        }
        constexpr int operator*() const { return m_bit; }
        constexpr bool operator==(Iterator other) const { return m_bit == other.m_bit; }
        constexpr bool operator!=(Iterator other) const { return m_bit != other.m_bit; }
    private:
        IntTy m_val;
        int m_bit;
    };

    constexpr BitSet() = default;
    constexpr explicit BitSet(IntTy val) : m_val(val) {}
    constexpr BitSet(std::initializer_list<int> init) {
        for (int bit : init) m_val |= IntTy{1} << bit;
    }

    Ref operator[](size_t bit) { return Ref(this, IntTy{1} << bit); }
    constexpr bool operator[](size_t bit) const { return (m_val & (IntTy{1} << bit)) != 0; }
    constexpr bool operator==(BitSet other) const { return m_val == other.m_val; }
    constexpr bool operator!=(BitSet other) const { return m_val != other.m_val; }
    constexpr BitSet operator|(BitSet other) const { return BitSet(m_val | other.m_val); }
    constexpr BitSet operator&(BitSet other) const { return BitSet(m_val & other.m_val); }
    constexpr BitSet operator^(BitSet other) const { return BitSet(m_val ^ other.m_val); }
    constexpr BitSet operator~() const { return BitSet(~m_val); }
    BitSet& operator|=(BitSet other) { return *this = *this | other; }
    BitSet& operator&=(BitSet other) { return *this = *this & other; }
    BitSet& operator^=(BitSet other) { return *this = *this ^ other; }
    constexpr explicit operator bool() const { return m_val != 0; }
    constexpr unsigned Count() const { return std::popcount(m_val); }
    constexpr Iterator begin() const { return ++Iterator(m_val, 0); }
    constexpr Iterator end() const { return Iterator(m_val, -1); }

    IntTy m_val{};
};

using BitSet8  = BitSet<u8>;
using BitSet32 = BitSet<u32>;

}  // namespace bemental::powerpc
