add_library(dolphin_libretro_common STATIC
  Globals.cpp
  Options.cpp
)

target_include_directories(dolphin_libretro_common PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${LIBRETRO_INCLUDE_DIR}
)

# needed for windows cmake compile
target_link_libraries(dolphin_libretro_common fmt)
