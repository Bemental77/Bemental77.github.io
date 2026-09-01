// Copyright 2015 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "Common/Logging/ConsoleListener.h"

#include <cstdio>
#include <cstring>

#ifndef _WIN32
#include <unistd.h>
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include "Common/Logging/Log.h"

ConsoleListener::ConsoleListener()
{
  m_use_color = !!isatty(fileno(stdout));
}

ConsoleListener::~ConsoleListener()
{
  fflush(nullptr);
}

void ConsoleListener::Log(Common::Log::LogLevel level, const char* text)
{
#ifdef __EMSCRIPTEN__
  // Bridge to JS console via postMessage. Direct console.{log,warn,error}
  // from a worker isn't captured by puppeteer's page.on('console') and the
  // user's DevTools shows worker logs anyway. postMessage({cmd:'print',...})
  // routes through the page's worker.onmessage handler (which logs to
  // console), matching how worker_funcs.js does its own prints. fprintf
  // (stderr) under PROXY_TO_PTHREAD is silently dropped, so this is the
  // only reliable bridge.
  EM_ASM({
    var lvl = $1;
    var tag = (lvl === 2) ? '[dolphin:E] ' : (lvl === 3) ? '[dolphin:W] ' : '[dolphin] ';
    try { postMessage({ cmd: 'print', txt: tag + UTF8ToString($0) }); } catch (e) {
      // Fallback to console if not in a worker (unit test, etc.).
      console.log(tag + UTF8ToString($0));
    }
  }, text, static_cast<int>(level));
  return;
#else
  char color_attr[16] = "";
  char reset_attr[16] = "";

  if (m_use_color)
  {
    strcpy(reset_attr, "\x1b[0m");
    switch (level)
    {
    case Common::Log::LogLevel::LNOTICE:
      // light green
      strcpy(color_attr, "\x1b[92m");
      break;
    case Common::Log::LogLevel::LERROR:
      // light red
      strcpy(color_attr, "\x1b[91m");
      break;
    case Common::Log::LogLevel::LWARNING:
      // light yellow
      strcpy(color_attr, "\x1b[93m");
      break;
    default:
      break;
    }
  }
  fprintf(stderr, "%s%s%s", color_attr, text, reset_attr);
#endif
}
