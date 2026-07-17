// Stubs for symbols Dolphin references but emcc's sysroot doesn't provide.
// Prior fork carried sf::IpAddress::{Any,LocalHost} definitions here as ODR
// partners to a Common/SFMLCompat.h shim; both removed in the sanitization
// (df03d80). All SFML-touching sources are now CMake-gated, so the sf::
// symbols have no remaining references in the link.
#include <array>
#include <cstdio>
#include <cstring>
#include <functional>
#include <span>
#include <string>
#include "Common/CommonTypes.h"

// ---------------------------------------------------------------------------
// Link-time stubs for upstream symbols whose .cpp sources are CMake-gated off
// under emcc (SFML / host networking unavailable). These are not behavior;
// they are link satisfiers — every consumer's call returns the no-op default
// it would have gotten in a non-netplay / non-triforce / non-DSU configuration.
// Author them as upstream-PR-shaped patches if upstream ever supports emcc.
// ---------------------------------------------------------------------------

// Forward decls to avoid pulling the full headers (which transitively SFML).
class PointerWrap;
namespace DiscIO { class Volume; }
namespace NetPlay { struct NetSettings; }

namespace NetPlay {
bool IsNetPlayRunning() { return false; }
}

namespace ConfigLoaders {
struct ConfigLayerLoader;
std::unique_ptr<ConfigLayerLoader> GenerateNetPlayConfigLoader(const NetPlay::NetSettings&) {
  return nullptr;
}
}  // namespace ConfigLoaders

namespace AMMediaboard {
void Init() {}
void Shutdown() {}
void DoState(PointerWrap&) {}
unsigned int GetGameType() { return 0; }
bool GetTestMenu() { return false; }
void InitDIMM(const DiscIO::Volume&) {}
void InitKeys(unsigned int, unsigned int, unsigned int) {}
void FirmwareMap(bool) {}
unsigned int ExecuteCommand(std::array<unsigned int, 3>&, unsigned int*, unsigned int, unsigned int) {
  return 0;
}
}  // namespace AMMediaboard

struct GCPadStatus;

namespace NetPlay {
void SetSIPollBatching(bool) {}
}  // namespace NetPlay

namespace SerialInterface {
class CSIDevice_GCController {
public:
  static bool NetPlay_GetInput(int, GCPadStatus*);
  static int NetPlay_InGamePadToLocalPad(int);
};
bool CSIDevice_GCController::NetPlay_GetInput(int, GCPadStatus*) { return false; }
int CSIDevice_GCController::NetPlay_InGamePadToLocalPad(int pad) { return pad; }

class CSIDevice_AMBaseboard {
public:
  static int NetPlay_InGamePadToLocalPad(int);
};
int CSIDevice_AMBaseboard::NetPlay_InGamePadToLocalPad(int pad) { return pad; }
}  // namespace SerialInterface

namespace ExpansionInterface {
class CEXIIPL { public: static u64 NetPlay_GetEmulatedTime(); };
u64 CEXIIPL::NetPlay_GetEmulatedTime() { return 0; }
// TAPServerConnection ctor referenced by Modem/TAPServerModem.cpp (gated off,
// but the constructor symbol is referenced from its TU's tables).
class TAPServerConnection {
public:
  TAPServerConnection(const std::string&, std::function<void(std::string&&)>, unsigned long);
};
TAPServerConnection::TAPServerConnection(const std::string&, std::function<void(std::string&&)>,
                                         unsigned long) {}

// TAPServerNetworkInterface ctor referenced by EXI_DeviceModem.cpp (Modem
// build is gated off, but the device-list table references the constructor).
class CEXIModem;
class CEXIModem_TAPServerNetworkInterface_Stub {
public:
  CEXIModem_TAPServerNetworkInterface_Stub(CEXIModem*, const std::string&) {}
};
}  // namespace ExpansionInterface

// Direct-name mangling stub for ExpansionInterface::CEXIModem::TAPServerNetworkInterface::ctor.
// Linker wants the exact mangled name; defining the nested class inline here.
namespace ExpansionInterface {
class CEXIModem {
public:
  class TAPServerNetworkInterface {
  public:
    TAPServerNetworkInterface(CEXIModem*, const std::string&);
  };
};
CEXIModem::TAPServerNetworkInterface::TAPServerNetworkInterface(CEXIModem*, const std::string&) {}
}  // namespace ExpansionInterface

namespace NetPlay { class NetPlayClient; }
class NetPlayChatUI {
public:
  explicit NetPlayChatUI(std::function<void(const std::string&)>);
  ~NetPlayChatUI();
  void Display();
};
NetPlayChatUI::NetPlayChatUI(std::function<void(const std::string&)>) {}
NetPlayChatUI::~NetPlayChatUI() {}
void NetPlayChatUI::Display() {}
std::unique_ptr<NetPlayChatUI> g_netplay_chat_ui;

class NetPlayGolfUI {
public:
  explicit NetPlayGolfUI(std::shared_ptr<NetPlay::NetPlayClient>);
  ~NetPlayGolfUI();
  void Display();
};
NetPlayGolfUI::NetPlayGolfUI(std::shared_ptr<NetPlay::NetPlayClient>) {}
NetPlayGolfUI::~NetPlayGolfUI() {}
void NetPlayGolfUI::Display() {}
std::unique_ptr<NetPlayGolfUI> g_netplay_golf_ui;

// Bridge-side Phase-IV publishers that EmscriptenWorker.cpp calls. Prior fork
// defined these in JitWasm.cpp; sanitized away. No-op until canonical
// CoreTiming-publish wiring lands as its own commit.
extern "C" {
unsigned dolphin_ct_drain_pending_mask() { return 0; }
// [ppc-bridge cutover 2026-06-28] Read the phase flags the page publishes into the
// SAB CT queue header (CT_QUEUE 0x02680000 + CT_OFF_PHASE_FLAGS 0x2C). Engages
// Phase IV (dolphin runs event-only dolphin_service_iter, the ppc-worker is sole
// PPC dispatcher) when the page sets CT_PHASE4|PHASE5 under ?ppcbootdispatch=1
// (gamecube.html:1628). The cutover is completed by the in-process mailbox drain
// in dolphin_service_iter (EmscriptenWorker.cpp). The default single-worker build
// never writes the flag (SAB zero-init) -> 0 -> retro_run, so it is unaffected.
unsigned dolphin_ct_get_phase_flags() {
    // [dual-core handover fence 2026-06-30] ACQUIRE load to pair with the page's release/seq-cst
    // Atomics.store of the Phase IV flag, so when dolphin observes the flag flip it also observes
    // the worker's prior shared-ppc_state writes (happens-before). A plain volatile load lowers to
    // a bare i32.load with no acquire barrier and does NOT form that edge -> stale-ppc_state risk.
    // The ppc-worker side already does __ATOMIC_ACQUIRE (ppc_worker_main.cpp:825-830).
    return __atomic_load_n(
        reinterpret_cast<volatile unsigned*>(static_cast<uintptr_t>(0x0268002Cu)),
        __ATOMIC_ACQUIRE);
}
void dolphin_set_ppc_state_external_storage(unsigned) {}
}  // extern "C"

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
