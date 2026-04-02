cmake_minimum_required(VERSION 3.16)
project(rattin-shell VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

# Qt6 modules
find_package(Qt6 REQUIRED COMPONENTS Quick WebEngineQuick WebChannel Network)

# libmpv — platform-specific discovery
if(WIN32)
    find_path(MPV_INCLUDE_DIR mpv/client.h
        HINTS ${MPV_PREFIX}/include $ENV{MPV_PREFIX}/include)
    # shinchiro builds ship libmpv.dll.a (GNU import lib) — find it directly
    find_file(MPV_IMPLIB NAMES libmpv.dll.a mpv.lib
        HINTS ${MPV_PREFIX} ${MPV_PREFIX}/lib $ENV{MPV_PREFIX} $ENV{MPV_PREFIX}/lib)
    find_file(MPV_DLL NAMES libmpv-2.dll
        HINTS ${MPV_PREFIX} $ENV{MPV_PREFIX})
    if(NOT MPV_INCLUDE_DIR OR NOT MPV_IMPLIB)
        message(FATAL_ERROR "libmpv not found. Set MPV_PREFIX to the mpv dev directory.")
    endif()
    add_library(PkgConfig::MPV IMPORTED SHARED)
    set_target_properties(PkgConfig::MPV PROPERTIES
        IMPORTED_IMPLIB "${MPV_IMPLIB}"
        IMPORTED_LOCATION "${MPV_DLL}"
        INTERFACE_INCLUDE_DIRECTORIES "${MPV_INCLUDE_DIR}")
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(MPV REQUIRED IMPORTED_TARGET mpv)
endif()

set(SOURCES
    main.cpp
    mpvobject.cpp
    mpvbridge.cpp
    resources.qrc
)

if(WIN32)
    list(APPEND SOURCES rattin.rc)
endif()

add_executable(rattin-shell ${SOURCES})

target_link_libraries(rattin-shell PRIVATE
    Qt6::Quick
    Qt6::WebEngineQuick
    Qt6::WebChannel
    Qt6::Network
    PkgConfig::MPV
)

if(WIN32)
    target_link_libraries(rattin-shell PRIVATE dwmapi)
    set_target_properties(rattin-shell PROPERTIES WIN32_EXECUTABLE TRUE)
endif()

# Install
install(TARGETS rattin-shell DESTINATION bin)
