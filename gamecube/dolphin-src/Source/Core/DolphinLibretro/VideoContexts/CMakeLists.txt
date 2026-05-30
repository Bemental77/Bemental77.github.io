add_library(dolphin_libretro_videocontexts STATIC
  GLContextLR.cpp
  GLContextLR.h
  ContextStatus.cpp
  ContextStatus.h
)

target_include_directories(dolphin_libretro_videocontexts PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(dolphin_libretro_videocontexts PRIVATE
  dolphin_libretro_common
)
