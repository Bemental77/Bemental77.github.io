// stubs.cpp
//
// Smallest possible stub definitions so the Dolphin ubershader GLSL generators
// link & run natively. We only need correct STRING output, not a working
// backend, so globals get sane default-constructed values and any heavy
// subsystem functions referenced (but never executed by GenPixelShader /
// GenVertexShader) are stubbed to inert no-ops.
//
// The functions GenPixelShader / GenVertexShader / WritePixelShaderCommonHeader
// are the ones we actually execute. They consult host_config.* (passed in
// main()) and g_backend_info.* / g_ActiveConfig.* (capabilities). Everything
// here exists either because (a) a generator code path reads it at runtime
// [DriverDetails::HasBug, ASSERT_MSG -> MsgAlertFmtImpl], or (b) the linker
// pulls an UNUSED sibling function from the same TU [GetPixelShaderUid /
// GetVertexShaderUid -> bpmem/xfmem/BlendMode::UseLogicOp ;
// GetDiskShaderCacheFileName -> File::* / SConfig::*] and just needs the symbol
// to resolve.

#include <string>
#include <string_view>

#include "VideoCommon/VideoConfig.h"
#include "VideoCommon/BPMemory.h"
#include "VideoCommon/XFMemory.h"
#include "VideoCommon/DriverDetails.h"
#include "Common/MsgHandler.h"
#include "Common/FileUtil.h"
#include "Common/Logging/Log.h"
#include "Core/ConfigManager.h"
#include "VideoCommon/BoundingBox.h"
#include "VideoCommon/GraphicsModSystem/Config/GraphicsModGroup.h"

// ---------------------------------------------------------------------------
// (a) Globals the generators actually READ. Real Dolphin types with sane
//     default member initializers => default construction yields a sane
//     common-case capability set; host_config (passed in main) selects paths.
// ---------------------------------------------------------------------------
VideoConfig g_Config;
VideoConfig g_ActiveConfig;
BackendInfo g_backend_info;

// ---------------------------------------------------------------------------
// (b) Symbols pulled in by UNUSED sibling functions (GetPixelShaderUid /
//     GetVertexShaderUid live in the same TUs as Gen*Shader). Never executed.
// ---------------------------------------------------------------------------
BPMemory bpmem;
XFMemory xfmem;

// Pulled by the unused GetPixelShaderUid() (reads g_bounding_box for bbox uid).
// Default-null unique_ptr; never dereferenced on our path.
std::unique_ptr<BoundingBox> g_bounding_box;

// g_Config / g_ActiveConfig hold std::optional<GraphicsModGroupConfig>; their
// global destructors reference ~GraphicsModGroupConfig(). The optional is
// always nullopt on our path, so this destructor never RUNS -- it only needs to
// LINK. GraphicsModConfig (the vector element type) is only forward-declared in
// the public header and its full definition pulls picojson + a header chain we
// don't want; we give it a minimal complete definition purely so the vector
// member destructor compiles. Safe because the dtor is never executed and no
// other code in this binary uses GraphicsModConfig.
struct GraphicsModConfig
{
};
GraphicsModGroupConfig::~GraphicsModGroupConfig() = default;

// Used only by the unused GetPixelShaderUid().
bool BlendMode::UseLogicOp() const
{
  return false;
}

// ---------------------------------------------------------------------------
// Runtime-reached during GenPixelShader: report no driver bugs (clean GLSL).
// ---------------------------------------------------------------------------
namespace DriverDetails
{
bool HasBug(Bug bug)
{
  return false;
}
}  // namespace DriverDetails

// ---------------------------------------------------------------------------
// ASSERT_MSG in the generators expands to Common::MsgAlertFmt -> MsgAlertFmtImpl.
// For the common-case config no assert fires; return false (= "do not abort").
// ---------------------------------------------------------------------------
namespace Common
{
bool MsgAlertFmtImpl(bool /*yes_no*/, MsgType /*style*/, Common::Log::LogType /*log_type*/,
                     const char* /*file*/, int /*line*/, fmt::string_view /*format*/,
                     const fmt::format_args& /*args*/)
{
  return false;
}
}  // namespace Common

// DEBUG_LOG_FMT in WritePixelShaderCommonHeader / WriteFog expands to
// Common::Log::GenericLogFmt -> GenericLogFmtImpl. No-op (we don't want logs).
namespace Common::Log
{
void GenericLogFmtImpl(LogLevel /*level*/, LogType /*type*/, const char* /*file*/, int /*line*/,
                       fmt::string_view /*format*/, const fmt::format_args& /*args*/)
{
}
}  // namespace Common::Log

// ---------------------------------------------------------------------------
// Pulled by the unused GetDiskShaderCacheFileName() in ShaderGenCommon.cpp.
// Inert stubs -- never executed by our path.
// ---------------------------------------------------------------------------
namespace File
{
const std::string& GetUserPath(unsigned int /*dir_index*/)
{
  static const std::string empty;
  return empty;
}
bool Exists(const std::string& /*path*/)
{
  return false;
}
bool CreateDir(const std::string& /*filename*/)
{
  return false;
}
}  // namespace File

// SConfig::GetInstance() dereferences m_Instance; the unused
// GetDiskShaderCacheFileName() reads SConfig::GetInstance().GetGameID().
// Provide a real instance so the symbol resolves; never executed by our path.
SConfig* SConfig::m_Instance = nullptr;
const std::string SConfig::GetGameID() const
{
  return std::string();
}
