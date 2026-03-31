import QtQuick
import QtQuick.Window
import QtWebEngine
import QtWebChannel
import com.magnetplayer.mpv 1.0

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

    // Transport object exposed to JS via QWebChannel
    QtObject {
        id: transport

        signal timeChanged(double seconds)
        signal durationChanged(double seconds)
        signal eofReached()
        signal pauseChanged(bool paused)
        signal isPlayingChanged(bool playing)

        function play(url) { bridge.play(url) }
        function pause() { bridge.pause() }
        function resume() { bridge.resume() }
        function seek(seconds) { bridge.seek(seconds) }
        function setVolume(percent) { bridge.setVolume(percent) }
        function setAudioTrack(index) { bridge.setAudioTrack(index) }
        function setSubtitleTrack(index) { bridge.setSubtitleTrack(index) }
        function stop() { bridge.stop() }
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
        }
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

    // ── Native controls overlay (on top of mpv) ──
    Item {
        id: controlsOverlay
        anchors.fill: parent
        visible: false
        z: 4

        // Auto-hide controls after 3 seconds of no mouse movement
        property bool showControls: true
        Timer {
            id: hideTimer
            interval: 3000
            onTriggered: controlsOverlay.showControls = false
        }

        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onPositionChanged: {
                controlsOverlay.showControls = true
                hideTimer.restart()
            }
            onClicked: root.togglePause()
            onDoubleClicked: root.toggleFullscreen()
        }

        // Keyboard handling
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
                bridge.setVolume(root.volume)
                event.accepted = true; break
            case Qt.Key_Down:
                root.volume = Math.max(0, root.volume - 10)
                bridge.setVolume(root.volume)
                event.accepted = true; break
            case Qt.Key_Escape:
                bridge.stop()
                event.accepted = true; break
            case Qt.Key_F:
                root.toggleFullscreen()
                event.accepted = true; break
            }
        }

        focus: visible

        // Top bar — title / back
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

            Text {
                anchors.left: parent.left
                anchors.leftMargin: 20
                anchors.verticalCenter: parent.verticalCenter
                text: "← Back"
                color: "white"
                font.pixelSize: 16

                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: bridge.stop()
                }
            }
        }

        // Bottom bar — progress + time
        Rectangle {
            id: bottomBar
            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            height: 80
            opacity: controlsOverlay.showControls ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: 200 } }
            gradient: Gradient {
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 1.0; color: "#BF000000" }
            }

            // Progress bar
            Rectangle {
                id: progressBg
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: timeRow.top
                anchors.leftMargin: 20
                anchors.rightMargin: 20
                anchors.bottomMargin: 4
                height: 4
                radius: 2
                color: "#40ffffff"

                Rectangle {
                    width: root.duration > 0
                        ? parent.width * (root.currentTime / root.duration)
                        : 0
                    height: parent.height
                    radius: 2
                    color: "#e94560"
                }

                MouseArea {
                    anchors.fill: parent
                    anchors.topMargin: -10
                    anchors.bottomMargin: -10
                    onClicked: function(mouse) {
                        var ratio = mouse.x / parent.width
                        bridge.seek(ratio * root.duration)
                    }
                }
            }

            // Time display + play/pause
            Row {
                id: timeRow
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: 20
                anchors.rightMargin: 20
                anchors.bottomMargin: 12
                spacing: 16

                Text {
                    text: root.paused ? "▶" : "⏸"
                    color: "white"
                    font.pixelSize: 20
                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.togglePause()
                    }
                }

                Text {
                    text: root.formatTime(root.currentTime) + " / " + root.formatTime(root.duration)
                    color: "#cccccc"
                    font.pixelSize: 14
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }
    }
}
