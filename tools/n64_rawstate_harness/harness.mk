# used by build.sh: include the real Makefile (CFILES), replace its flags with port-free ones
include Makefile
MYFLAGS := -I. -I./src/glide2gl/src/Glide64 -I./src/mupen64plus-core/src -I./src/mupen64plus-core/src/api -I./src/include \
	-I./src/mupen64plus-core/src/plugin/audio_libretro -I./src/libretro-common/include -I./src/libretro \
	-I$(HDIR)/stub -I./zlib \
	-DHAVE_OPENGLES -DHAVE_OPENGLES2 -DHAVE_GLIDE64 -DHAVE_THR_AL -DNDEBUG -D__LIBRETRO__ -DM64P_PLUGIN_API \
	-DM64P_CORE_PROTOTYPES -D_ENDUSER_RELEASE -DSINC_LOWER_QUALITY -DNOSSE -DNO_ASM -DNO_LIBCO -DDISABLE_3POINT \
	-Wno-c++11-narrowing -DINLINE="inline" -O3 -flto
ZFILES := $(patsubst %.c,%.o,$(wildcard zlib/*.c))
HOBJ := $(patsubst %.c,%.o,$(CFILES)) $(ZFILES) $(HDIR)/harness.o
$(HDIR)/harness.o: $(HDIR)/harness.c
	emcc -c $< -o $@ $(MYFLAGS)
harness: $(HOBJ)
	emcc -o $(HDIR)/core.js $(HOBJ) -lGL -O3 -flto -s TOTAL_MEMORY=536870912 -s ASSERTIONS=0 -s EXIT_RUNTIME=0 \
	  -s MODULARIZE=1 -s EXPORT_NAME=Core -s ENVIRONMENT=node -s INVOKE_RUN=0 \
	  -s EXPORTED_RUNTIME_METHODS="['HEAPU8','HEAPU32','wasmMemory']" \
	  -s EXPORTED_FUNCTIONS="['_malloc','_free','_h_boot','_h_pad','_h_frame','_h_prescale','_neil_state_size','_neil_state_save_raw','_neil_state_save_raw_fast','_neil_state_load_raw','_neil_state_last_load_mode','_neil_state_last_load_pages','_neil_state_m64p_region','_neil_serialize','_neil_unserialize','_neil_last_fp','_neil_fp_always']" \
	  -s ERROR_ON_UNDEFINED_SYMBOLS=0 -s WARN_ON_UNDEFINED_SYMBOLS=1
zlib/%.o: zlib/%.c
	emcc -c $< -o $@ -O3 -flto -I./zlib -DZ_HAVE_UNISTD_H -include unistd.h -include fcntl.h -D_open=open -D_read=read -D_write=write -D_close=close -Wno-implicit-function-declaration -Wno-deprecated-non-prototype
