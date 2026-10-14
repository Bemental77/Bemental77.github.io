// serialize.cpp : save states
#include "serialize.h"
#include "types.h"
#include "hw/aica/aica_if.h"
#include "hw/holly/sb.h"
#include "hw/flashrom/nvmem.h"
#include "hw/gdrom/gdrom_if.h"
#include "hw/maple/maple_cfg.h"
#include "hw/modem/modem.h"
#include "hw/pvr/pvr.h"
#include "hw/sh4/sh4_sched.h"
#include "hw/sh4/sh4_mmr.h"
#include "reios/reios.h"
#include "hw/naomi/naomi.h"
#include "hw/naomi/naomi_cart.h"
#include "hw/bba/bba.h"
#include "cfg/option.h"
#include "imgread/common.h"
#include "achievements/achievements.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// Where each subsystem starts in the last serialized state (diagnostic: lets a
// byte diff of two states be attributed to its owner). [0] = number of marks.
static u32 g_ser_sec[24];
extern "C" EMSCRIPTEN_KEEPALIVE u32* flycast_ser_sections(void) { return g_ser_sec; }
#define SER_MARK(i) do { if (!ser.dryrun()) { g_ser_sec[(i) + 1] = (u32)ser.size(); g_ser_sec[0] = (i) + 1; } } while (0)
#else
#define SER_MARK(i) do {} while (0)
#endif
void dc_serialize(Serializer& ser)
{
	SER_MARK(0);  aica::serialize(ser);
	SER_MARK(1);  sb_serialize(ser);
	SER_MARK(2);  nvmem::serialize(ser);
	SER_MARK(3);  gdrom::serialize(ser);
	SER_MARK(4);  mcfg_SerializeDevices(ser);
	SER_MARK(5);  pvr::serialize(ser);
	SER_MARK(6);  sh4::serialize(ser);
	SER_MARK(7);
	ser << config::EmulateBBA.get();
	if (config::EmulateBBA)
		bba_Serialize(ser);
	ModemSerialize(ser);
	SER_MARK(8);  sh4::serialize2(ser);
	SER_MARK(9);  libGDR_serialize(ser);
	SER_MARK(10); naomi_Serialize(ser);
	SER_MARK(11);
	ser << config::Broadcast.get();
	ser << config::Cable.get();
	ser << config::Region.get();

	naomi_cart_serialize(ser);
	SER_MARK(12); reios_serialize(ser);
	SER_MARK(13); achievements::serialize(ser);
	SER_MARK(14);

	DEBUG_LOG(SAVESTATE, "Saved %d bytes", (u32)ser.size());
}

void dc_deserialize(Deserializer& deser)
{
	DEBUG_LOG(SAVESTATE, "Loading state version %d", deser.version());

	aica::deserialize(deser);

	sb_deserialize(deser);

	nvmem::deserialize(deser);

	gdrom::deserialize(deser);

	mcfg_DeserializeDevices(deser);

	pvr::deserialize(deser);

	sh4::deserialize(deser);

	deser >> config::EmulateBBA.get();
	if (config::EmulateBBA)
		bba_Deserialize(deser);
	ModemDeserialize(deser);

	sh4::deserialize2(deser);

	libGDR_deserialize(deser);

	naomi_Deserialize(deser);

	deser >> config::Broadcast.get();
	verify(config::Broadcast >= 0 && config::Broadcast <= 4);
	deser >> config::Cable.get();
	verify(config::Cable >= 0 && config::Cable <= 3);
	deser >> config::Region.get();
	verify(config::Region >= 0 && config::Region <= 3);

	naomi_cart_deserialize(deser);
	reios_deserialize(deser);
	achievements::deserialize(deser);
	sh4_sched_ffts();

	DEBUG_LOG(SAVESTATE, "Loaded %d bytes", (u32)deser.size());
}

Deserializer::Deserializer(const void *data, size_t limit, bool rollback)
	: SerializeBase(limit, rollback), data((const u8 *)data)
{
	if (!memcmp(data, "RASTATE\001", 8))
	{
		// RetroArch savestates now have several sections: MEM, ACHV, RPLY, etc.
		const u8 *p = this->data + 8;
		limit -= 8;
		while (limit > 8)
		{
			const u8 *section = p;
			u32 sectionSize = *(const u32 *)&p[4];
			p += 8;
			limit -= 8;
			if (!memcmp(section, "MEM ", 4))
			{
				// That's the part we're interested in
				this->data = p;
				this->limit = sectionSize;
				break;
			}
			sectionSize = (sectionSize + 7) & ~7;	// align to 8 bytes
			if (limit < sectionSize) {
				limit = 0;
				break;
			}
			p += sectionSize;
			limit -= sectionSize;
		}
		if (limit <= 8)
			throw Exception("Can't find MEM section in RetroArch savestate");
	}
	deserialize(_version);
	if (_version < V16)
		throw Exception("Unsupported version");
	if (_version > Current)
		throw Exception("Version too recent");

	if(_version >= V42 && settings.platform.isConsole())
	{
		u32 ramSize;
		deserialize(ramSize);
		if (ramSize != settings.platform.ram_size)
			throw Exception("Selected RAM Size doesn't match Save State");
	}
}

Serializer::Serializer(void *data, size_t limit, bool rollback)
	: SerializeBase(limit, rollback), data((u8 *)data)
{
	Version v = Current;
	serialize(v);
	if (settings.platform.isConsole())
		serialize(settings.platform.ram_size);
}
