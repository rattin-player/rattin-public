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

    // Transport object exposed to JS via QWebChannel.
    // Wraps the C++ MpvBridge (set as "bridge" context property from main.cpp).
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

    // Forward C++ bridge signals to the transport object
    Connections {
        target: bridge
        function onTimeChanged(seconds) { transport.timeChanged(seconds) }
        function onDurationChanged(seconds) { transport.durationChanged(seconds) }
        function onEofReached() { transport.eofReached() }
        function onPauseChanged(paused) { transport.pauseChanged(paused) }
        function onIsPlayingChanged(playing) {
            transport.isPlayingChanged(playing)
            webView.z = playing ? 0 : 2
            mpvPlayer.visible = playing
        }
    }

    MpvObject {
        id: mpvPlayer
        anchors.fill: parent
        visible: false
        z: 1
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

        // Register transport on channel after page loads (standard pattern).
        // React's native-bridge.ts handles QWebChannel connection using the
        // bundled qwebchannel npm package — no JS injection needed from QML.
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
}
