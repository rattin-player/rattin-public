cmake_minimum_required(VERSION 3.16)
project(rattin-shell VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

# Qt6 modules
find_package(Qt6 REQUIRED COMPONENTS Quick WebEngineQuick WebChannel Network)

# libmpv via pkg-config
find_package(PkgConfig REQUIRED)
pkg_check_modules(MPV REQUIRED IMPORTED_TARGET mpv)

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

# Install
install(TARGETS rattin-shell DESTINATION bin)
