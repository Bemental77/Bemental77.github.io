// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#ifdef __EMSCRIPTEN__
// Wasm target: SI_DeviceGBA.cpp is gated off in Source/Core/Core/CMakeLists.txt
// (SFML socket transport unavailable under emcc). SI.cpp's transitive #include
// of this header expects SI_Device.h for the ISIDevice complete type and the
// free function GBAConnectionWaiter_Shutdown() at SI.cpp:328 — both stubbed.
#include "Core/HW/SI/SI_Device.h"
namespace SerialInterface {
inline void GBAConnectionWaiter_Shutdown() {}
}  // namespace SerialInterface
#else

#include <array>
#include <memory>

#include <SFML/Network.hpp>

#include "Common/CommonTypes.h"
#include "Core/HW/SI/SI_Device.h"

// GameBoy Advance "Link Cable"

namespace SerialInterface
{
void GBAConnectionWaiter_Shutdown();

class GBASockServer
{
public:
  GBASockServer();
  ~GBASockServer();

  bool Connect();
  bool IsConnected();
  void ClockSync(Core::System& system);
  void Send(const u8* si_buffer);
  int Receive(u8* si_buffer, u8 bytes);
  void Flush();

private:
  void Disconnect();

  std::unique_ptr<sf::TcpSocket> m_client;
  std::unique_ptr<sf::TcpSocket> m_clock_sync;

  u64 m_last_time_slice = 0;
  bool m_booted = false;
};

class CSIDevice_GBA final : public ISIDevice
{
public:
  CSIDevice_GBA(Core::System& system, SIDevices device, int device_number);

  int RunBuffer(u8* buffer, int request_length) override;
  int TransferInterval() override;
  DataResponse GetData(u32& hi, u32& low) override;
  void SendCommand(u32 command, u8 poll) override;

private:
  enum class NextAction
  {
    SendCommand,
    WaitTransferTime,
    ReceiveResponse
  };

  GBASockServer m_sock_server;
  NextAction m_next_action = NextAction::SendCommand;
  EBufferCommands m_last_cmd = EBufferCommands::CMD_STATUS;
  u64 m_timestamp_sent = 0;
};
}  // namespace SerialInterface

#endif  // !__EMSCRIPTEN__
