// Copyright 2015 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <optional>

namespace Common
{
template <typename Callable>
class ScopeGuard final
{
public:
  ScopeGuard(Callable&& finalizer) : m_finalizer(std::forward<Callable>(finalizer)) {}

  ScopeGuard(ScopeGuard&& other) : m_finalizer(std::move(other.m_finalizer))
  {
#ifdef __LIBRETRO__
    other.m_finalizer.reset();
#else
    other.Dismiss();
#endif
  }

  ~ScopeGuard() { Exit(); }
  void Dismiss() { m_finalizer.reset(); }
  void Exit()
  {
    if (!m_finalizer.has_value())
      return;

    auto fn = std::move(*m_finalizer);
    m_finalizer.reset();
    fn();  // must not throw
  }

  ScopeGuard(const ScopeGuard&) = delete;

  void operator=(const ScopeGuard&) = delete;

private:
  std::optional<Callable> m_finalizer;
};

}  // Namespace Common
