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
    find_library(MPV_LIBRARY NAMES mpv mpv.dll
        HINTS ${MPV_PREFIX}/lib $ENV{MPV_PREFIX}/lib)
    if(NOT MPV_INCLUDE_DIR OR NOT MPV_LIBRARY)
        message(FATAL_ERROR "libmpv not found. Set MPV_PREFIX to the mpv dev directory.")
    endif()
    add_library(PkgConfig::MPV IMPORTED UNKNOWN)
    set_target_properties(PkgConfig::MPV PROPERTIES
        IMPORTED_LOCATION "${MPV_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${MPV_INCLUDE_DIR}")
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(MPV REQUIRED IMPORTED_TARGET mpv)
endif()

add_executable(rattin-shell
    main.cpp
    mpvobject.cpp
    mpvbridge.cpp
    resources.qrc
)

target_link_libraries(rattin-shell PRIVATE
    Qt6::Quick
    Qt6::WebEngineQuick
    Qt6::WebChannel
    Qt6::Network
    PkgConfig::MPV
)

if(WIN32)
    target_link_libraries(rattin-shell PRIVATE dwmapi)
endif()

# Install
install(TARGETS rattin-shell DESTINATION bin)
