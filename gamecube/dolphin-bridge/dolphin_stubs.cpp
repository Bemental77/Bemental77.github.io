// Stubs for symbols Dolphin references but Emscripten/SFMLCompat don't provide.
#include <cstdio>
#include <cstring>
#include "Common/SFMLCompat.h"

namespace sf {
const IpAddress IpAddress::Any{};
const IpAddress IpAddress::LocalHost{"127.0.0.1"};
}

extern "C" {

// Linux-only sysinfo() referenced by Common/MemoryUtil.cpp.
struct linux_sysinfo {
    long uptime;
    unsigned long loads[3];
    unsigned long totalram;
    unsigned long freeram;
    unsigned long sharedram;
    unsigned long bufferram;
    unsigned long totalswap;
    unsigned long freeswap;
    unsigned short procs;
    unsigned long totalhigh;
    unsigned long freehigh;
    unsigned int mem_unit;
    char _f[20 - 2 * sizeof(long) - sizeof(int)];
};

int sysinfo(struct linux_sysinfo* info) {
    if (info) {
        std::memset(info, 0, sizeof(*info));
        info->totalram = 1024UL * 1024UL * 1024UL;
        info->freeram  = 1024UL * 1024UL * 1024UL;
        info->mem_unit = 1;
    }
    return 0;
}

// Pad libusb backend reference with a 1024-byte zero buffer. libusb's
// usbi_os_backend is a struct of function pointers; we never call any of them
// because Dolphin's USB paths are never exercised under emcc.
char usbi_backend[1024] = {0};

// pthread_setname_np: Linux/macOS extension, not in emscripten's pthread lib.
// Common/Thread.cpp uses it to label threads in profilers — a no-op is fine.
int pthread_setname_np(unsigned long /*thread*/, const char* /*name*/) { return 0; }

// pipe2: Linux-specific pipe with flags. Emscripten lacks it. Fall back to
// regular pipe(); ignore the flags. Used by Dolphin's thread interrupt code.
extern int pipe(int fds[2]);
int pipe2(int fds[2], int /*flags*/) { return pipe(fds); }

} // extern "C"
