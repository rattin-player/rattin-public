import QtQuick
import QtQuick.Window
import QtWebEngine
import QtWebChannel
import com.rattin.mpv 1.0

Window {
    id: root
    visible: true
    width: 1280
    height: 720
    title: "Rattin"
    color: "#000000"

    property double currentTime: 0
    property double duration: 0
    property bool paused: false
    property bool playing: false
    property int volume: 100
    property string mediaTitle: ""
    property var subTracks: []
    property var audioTracks: []
    property int activeSub: 0
    property int activeAudio: 1
    property int subSize: 55

    function togglePause() {
        if (root.paused) bridge.resume()
        else bridge.pause()
    }

    function toggleFullscreen() {
        if (root.visibility === Window.FullScreen) root.showNormal()
        else root.showFullScreen()
    }

    function formatTime(s) {
        var h = Math.floor(s / 3600)
        var m = Math.floor((s % 3600) / 60)
        var sec = Math.floor(s % 60)
        if (h > 0) return h + ":" + (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec
        return m + ":" + (sec < 10 ? "0" : "") + sec
    }

    function refreshTracks() {
        var tracks = bridge.getProperty("track-list")
        if (!tracks || tracks.length === undefined) return
        var subs = [], audios = []
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i]
            if (t.type === "sub") {
                var label = t.title || t.lang || ("Subtitle " + t.id)
                if (t.lang && t.title) label = t.title + " (" + t.lang + ")"
                subs.push({ id: t.id, label: label })
            } else if (t.type === "audio") {
                var alabel = t.title || t.lang || ("Audio " + t.id)
                if (t.lang && t.title) alabel = t.title + " (" + t.lang + ")"
                audios.push({ id: t.id, label: alabel })
            }
        }
        root.subTracks = subs
        root.audioTracks = audios
    }

    // Transport object exposed to JS via QWebChannel
    QtObject {
        id: transport

        signal timeChanged(double seconds)
        signal durationChanged(double seconds)
        signal eofReached()
        signal pauseChanged(bool paused)
        signal isPlayingChanged(bool playing)
        // JS↔QML state sync signals
        signal subtitleTrackChanged(int mpvId)  // JS→QML: JS changed sub
        signal audioTrackChanged(int mpvId)     // JS→QML: JS changed audio
        signal nativeSubChanged(int mpvId)      // QML→JS: native overlay changed sub
        signal nativeAudioChanged(int mpvId)    // QML→JS: native overlay changed audio
        signal nativeVolumeChanged(int percent)  // QML→JS: native overlay changed volume
        signal volumeChanged(int percent)        // JS→QML: JS changed volume
        signal nativeSubSizeChanged(int size)    // QML→JS: native overlay changed sub size

        function play(url) { bridge.play(url) }
        function pause() { bridge.pause() }
        function resume() { bridge.resume() }
        function seek(seconds) { bridge.seek(seconds) }
        function setVolume(percent) { bridge.setVolume(percent); transport.volumeChanged(percent) }
        function setAudioTrack(index) { bridge.setAudioTrack(index); transport.audioTrackChanged(index + 1) }
        function setSubtitleTrack(index) {
            bridge.setSubtitleTrack(index)
            // Notify QML so it updates its active track indicator
            // mpv uses 1-based IDs, index < 0 means off (sid=0 in QML)
            transport.subtitleTrackChanged(index < 0 ? 0 : index + 1)
        }
        function stop() { bridge.stop() }
        function setTitle(title) { root.mediaTitle = title }
        function setProperty(name, value) { bridge.setProperty(name, value) }
    }

    // Forward C++ bridge signals to transport + update local state
    Connections {
        target: bridge
        function onTimeChanged(seconds) {
            transport.timeChanged(seconds)
            root.currentTime = seconds
        }
        function onDurationChanged(seconds) {
            transport.durationChanged(seconds)
            root.duration = seconds
        }
        function onEofReached() { transport.eofReached() }
        function onPauseChanged(p) {
            transport.pauseChanged(p)
            root.paused = p
        }
        function onIsPlayingChanged(p) {
            transport.isPlayingChanged(p)
            root.playing = p
            mpvPlayer.visible = p
            controlsOverlay.visible = p
            if (p) trackRefreshTimer.start()
        }
    }

    // Sync QML state when JS changes state (phone remote → QML overlay)
    Connections {
        target: transport
        function onSubtitleTrackChanged(mpvId) { root.activeSub = mpvId }
        function onAudioTrackChanged(mpvId) { root.activeAudio = mpvId }
        function onVolumeChanged(percent) { root.volume = percent }
    }

    MpvObject {
        id: mpvPlayer
        anchors.fill: parent
        visible: false
        z: 3
    }

    WebEngineView {
        id: webView
        anchors.fill: parent
        url: initialUrl
        z: 2
        webChannel: wChannel

        onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceId) {
            console.log("[js]", message)
        }

        onLoadingChanged: function(loadingInfo) {
            if (loadingInfo.status === WebEngineView.LoadSucceededStatus) {
                webView.webChannel.registerObject("bridge", transport)
                console.log("[shell] bridge registered on channel")
            }
        }
    }

    WebChannel {
        id: wChannel
    }

    Timer {
        id: trackRefreshTimer
        interval: 2000
        repeat: true
        onTriggered: {
            root.refreshTracks()
            // Stop retrying once we have tracks
            if (root.subTracks.length > 0 || root.audioTracks.length > 1)
                trackRefreshTimer.stop()
        }
    }

    // ── Native controls overlay (on top of mpv) ──
    Item {
        id: controlsOverlay
        anchors.fill: parent
        visible: false
        z: 4

        property bool showControls: true
        property int _savedVolume: 100

        Timer {
            id: hideTimer
            interval: 3000
            onTriggered: controlsOverlay.showControls = false
        }

        MouseArea {
            anchors.fill: parent
            anchors.bottomMargin: bottomBar.height
            hoverEnabled: true
            acceptedButtons: Qt.LeftButton
            onPositionChanged: {
                controlsOverlay.showControls = true
                hideTimer.restart()
            }
            onClicked: root.togglePause()
            onDoubleClicked: root.toggleFullscreen()
        }

        // Separate hover tracker for the bottom bar area (no pause on click)
        MouseArea {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: bottomBar.height
            hoverEnabled: true
            acceptedButtons: Qt.NoButton
            onPositionChanged: {
                controlsOverlay.showControls = true
                hideTimer.restart()
            }
        }

        Keys.onPressed: function(event) {
            switch (event.key) {
            case Qt.Key_Space:
                root.togglePause()
                event.accepted = true; break
            case Qt.Key_Left:
                bridge.seek(Math.max(0, root.currentTime - 10))
                event.accepted = true; break
            case Qt.Key_Right:
                bridge.seek(root.currentTime + 10)
                event.accepted = true; break
            case Qt.Key_Up:
                root.volume = Math.min(100, root.volume + 10)
                bridge.setVolume(root.volume); transport.nativeVolumeChanged(root.volume)
                event.accepted = true; break
            case Qt.Key_Down:
                root.volume = Math.max(0, root.volume - 10)
                bridge.setVolume(root.volume); transport.nativeVolumeChanged(root.volume)
                event.accepted = true; break
            case Qt.Key_M:
                if (root.volume > 0) {
                    controlsOverlay._savedVolume = root.volume
                    root.volume = 0
                } else {
                    root.volume = controlsOverlay._savedVolume || 100
                }
                bridge.setVolume(root.volume); transport.nativeVolumeChanged(root.volume)
                event.accepted = true; break
            case Qt.Key_Escape:
                if (root.visibility === Window.FullScreen)
                    root.showNormal()
                else
                    bridge.stop()
                event.accepted = true; break
            case Qt.Key_F:
                root.toggleFullscreen()
                event.accepted = true; break
            }
        }

        focus: visible

        // ── Top bar ──
        Rectangle {
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: 60
            opacity: controlsOverlay.showControls ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: 200 } }
            gradient: Gradient {
                GradientStop { position: 0.0; color: "#BF000000" }
                GradientStop { position: 1.0; color: "transparent" }
            }

            Row {
                anchors.left: parent.left
                anchors.leftMargin: 16
                anchors.verticalCenter: parent.verticalCenter
                spacing: 12

                Text {
                    text: "\u2190"
                    color: "white"
                    font.pixelSize: 20
                    MouseArea {
                        anchors.fill: parent
                        anchors.margins: -8
                        cursorShape: Qt.PointingHandCursor
                        onClicked: bridge.stop()
                    }
                }

                Text {
                    text: root.mediaTitle
                    color: "white"
                    font.pixelSize: 15
                    elide: Text.ElideRight
                    width: root.width - 100
                }
            }
        }

        // ── Track picker popup ──
        Rectangle {
            id: trackPopup
            visible: false
            anchors.right: parent.right
            anchors.bottom: bottomBar.top
            anchors.rightMargin: 16
            anchors.bottomMargin: 8
            width: 260
            height: trackCol.height + 24
            radius: 8
            color: "#E0181818"

            MouseArea { anchors.fill: parent }

            Column {
                id: trackCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 12
                spacing: 4

                Text {
                    text: "Subtitles"
                    color: "#888"
                    font.pixelSize: 11
                    font.bold: true
                    visible: root.subTracks.length > 0
                }

                Rectangle {
                    width: parent.width; height: 28; radius: 4
                    color: root.activeSub === 0 ? "#30c9a84c" : "transparent"
                    visible: root.subTracks.length > 0
                    Text {
                        anchors.left: parent.left; anchors.leftMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        text: "Off"
                        color: root.activeSub === 0 ? "#c9a84c" : "#ccc"
                        font.pixelSize: 13
                    }
                    MouseArea {
                        anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                        onClicked: { bridge.setProperty("sid", 0); root.activeSub = 0; transport.nativeSubChanged(0) }
                    }
                }

                Repeater {
                    model: root.subTracks
                    Rectangle {
                        width: trackCol.width; height: 28; radius: 4
                        color: root.activeSub === modelData.id ? "#30c9a84c" : "transparent"
                        Text {
                            anchors.left: parent.left; anchors.leftMargin: 8
                            anchors.right: parent.right; anchors.rightMargin: 8
                            anchors.verticalCenter: parent.verticalCenter
                            text: modelData.label
                            color: root.activeSub === modelData.id ? "#c9a84c" : "#ccc"
                            font.pixelSize: 13; elide: Text.ElideRight
                        }
                        MouseArea {
                            anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                            onClicked: { bridge.setProperty("sid", modelData.id); root.activeSub = modelData.id; transport.nativeSubChanged(modelData.id) }
                        }
                    }
                }

                Text {
                    text: "Audio"; color: "#888"; font.pixelSize: 11; font.bold: true
                    topPadding: 8; visible: root.audioTracks.length > 1
                }

                Repeater {
                    model: root.audioTracks.length > 1 ? root.audioTracks : []
                    Rectangle {
                        width: trackCol.width; height: 28; radius: 4
                        color: root.activeAudio === modelData.id ? "#30c9a84c" : "transparent"
                        Text {
                            anchors.left: parent.left; anchors.leftMargin: 8
                            anchors.right: parent.right; anchors.rightMargin: 8
                            anchors.verticalCenter: parent.verticalCenter
                            text: modelData.label
                            color: root.activeAudio === modelData.id ? "#c9a84c" : "#ccc"
                            font.pixelSize: 13; elide: Text.ElideRight
                        }
                        MouseArea {
                            anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                            onClicked: { bridge.setProperty("aid", modelData.id); root.activeAudio = modelData.id; transport.nativeAudioChanged(modelData.id) }
                        }
                    }
                }

                Text {
                    text: "Size"; color: "#888"; font.pixelSize: 11; font.bold: true
                    topPadding: 8; visible: root.subTracks.length > 0
                }
                Row {
                    spacing: 8; visible: root.subTracks.length > 0
                    Text {
                        text: "A\u2212"; color: "#ccc"; font.pixelSize: 14
                        MouseArea {
                            anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor
                            onClicked: { root.subSize = Math.max(20, root.subSize - 5); bridge.setProperty("sub-font-size", root.subSize); transport.nativeSubSizeChanged(root.subSize) }
                        }
                    }
                    Text { text: root.subSize.toString(); color: "#888"; font.pixelSize: 12; width: 24; horizontalAlignment: Text.AlignHCenter }
                    Text {
                        text: "A+"; color: "#ccc"; font.pixelSize: 14
                        MouseArea {
                            anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor
                            onClicked: { root.subSize = Math.min(100, root.subSize + 5); bridge.setProperty("sub-font-size", root.subSize); transport.nativeSubSizeChanged(root.subSize) }
                        }
                    }
                }
            }
        }

        // ── Bottom bar ──
        Rectangle {
            id: bottomBar
            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            height: 90
            opacity: controlsOverlay.showControls ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: 200 } }
            gradient: Gradient {
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 1.0; color: "#BF000000" }
            }

            Rectangle {
                id: progressBg
                anchors.left: parent.left; anchors.right: parent.right
                anchors.bottom: controlsRow.top
                anchors.leftMargin: 16; anchors.rightMargin: 16; anchors.bottomMargin: 4
                height: 4; radius: 2; color: "#40ffffff"

                Rectangle {
                    width: root.duration > 0 ? parent.width * (root.currentTime / root.duration) : 0
                    height: parent.height; radius: 2; color: "#e94560"
                }
                Rectangle {
                    visible: root.duration > 0
                    x: root.duration > 0 ? parent.width * (root.currentTime / root.duration) - 6 : 0
                    y: -4; width: 12; height: 12; radius: 6; color: "#e94560"
                    opacity: controlsOverlay.showControls ? 1 : 0
                }
                MouseArea {
                    anchors.fill: parent; anchors.topMargin: -12; anchors.bottomMargin: -12
                    cursorShape: Qt.PointingHandCursor
                    onClicked: function(mouse) { bridge.seek(Math.max(0, Math.min(1, mouse.x / parent.width)) * root.duration) }
                    onPositionChanged: function(mouse) {
                        if (pressed) bridge.seek(Math.max(0, Math.min(1, mouse.x / parent.width)) * root.duration)
                    }
                }
            }

            Item {
                id: controlsRow
                anchors.bottom: parent.bottom; anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 16; anchors.rightMargin: 16; anchors.bottomMargin: 12
                height: 30

                Text {
                    id: playBtn; text: root.paused ? "\u25B6" : "\u23F8"
                    color: "white"; font.pixelSize: 22
                    anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
                    MouseArea { anchors.fill: parent; anchors.margins: -4; cursorShape: Qt.PointingHandCursor; onClicked: root.togglePause() }
                }

                Text {
                    text: root.formatTime(root.currentTime) + " / " + root.formatTime(root.duration)
                    color: "#cccccc"; font.pixelSize: 13
                    anchors.left: playBtn.right; anchors.leftMargin: 12; anchors.verticalCenter: parent.verticalCenter
                }

                Text {
                    id: fullscreenBtn
                    text: root.visibility === Window.FullScreen ? "\u2750" : "\u26F6"
                    color: "white"; font.pixelSize: 18
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: root.toggleFullscreen() }
                }

                Text {
                    id: subBtn; text: "CC"
                    color: root.activeSub > 0 ? "#c9a84c" : "#888"
                    font.pixelSize: 13; font.bold: true
                    anchors.right: fullscreenBtn.left; anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter
                    visible: root.subTracks.length > 0 || root.audioTracks.length > 1
                    MouseArea {
                        anchors.fill: parent; anchors.margins: -8; cursorShape: Qt.PointingHandCursor
                        onClicked: { root.refreshTracks(); trackPopup.visible = !trackPopup.visible }
                    }
                }

                Row {
                    anchors.right: subBtn.visible ? subBtn.left : fullscreenBtn.left
                    anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter
                    spacing: 6

                    Text {
                        text: root.volume === 0 ? "\uD83D\uDD07" : root.volume < 50 ? "\uD83D\uDD09" : "\uD83D\uDD0A"
                        color: "white"; font.pixelSize: 16; anchors.verticalCenter: parent.verticalCenter
                        MouseArea {
                            anchors.fill: parent; anchors.margins: -4; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (root.volume > 0) { controlsOverlay._savedVolume = root.volume; root.volume = 0 }
                                else { root.volume = controlsOverlay._savedVolume || 100 }
                                bridge.setVolume(root.volume); transport.nativeVolumeChanged(root.volume)
                            }
                        }
                    }

                    Rectangle {
                        width: 80; height: 3; radius: 2; color: "#40ffffff"; anchors.verticalCenter: parent.verticalCenter
                        Rectangle { width: parent.width * (root.volume / 100); height: parent.height; radius: 2; color: "white" }
                        Rectangle { x: parent.width * (root.volume / 100) - 6; y: -4.5; width: 12; height: 12; radius: 6; color: "white" }
                        MouseArea {
                            anchors.fill: parent; anchors.topMargin: -10; anchors.bottomMargin: -10; cursorShape: Qt.PointingHandCursor
                            onClicked: function(mouse) { var v = Math.round(Math.max(0, Math.min(100, (mouse.x / parent.width) * 100))); root.volume = v; bridge.setVolume(v); transport.nativeVolumeChanged(v) }
                            onPositionChanged: function(mouse) { if (pressed) { var v = Math.round(Math.max(0, Math.min(100, (mouse.x / parent.width) * 100))); root.volume = v; bridge.setVolume(v); transport.nativeVolumeChanged(v) } }
                        }
                    }
                }
            }
        }
    }
}
