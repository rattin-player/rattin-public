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
    // Reference impl uses this exact pattern: a QML QtObject registered on the channel.
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

    // Mpv video renderer — sits behind the webview, shown during playback
    MpvObject {
        id: mpvPlayer
        anchors.fill: parent
        visible: false
        z: 1
    }

    // Web UI — the existing React app
    WebEngineView {
        id: webView
        anchors.fill: parent
        url: initialUrl
        z: 2
        webChannel: wChannel

        // Forward JS console.log to stderr for debugging
        onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceId) {
            console.log("[js]", message)
        }

        onLoadingChanged: function(loadingInfo) {
            if (loadingInfo.status === WebEngineView.LoadSucceededStatus) {
                // Register transport on channel AFTER page loads (standard pattern)
                webView.webChannel.registerObject("bridge", transport)
                console.log("[shell] bridge registered on channel, bootstrapping JS...")

                // Bootstrap: create QWebChannel in page JS and wire up window.mpvBridge
                webView.runJavaScript(
                    "(function() {" +
                    "  if (typeof QWebChannel === 'undefined') {" +
                    "    console.error('[shell] QWebChannel not defined');" +
                    "    return;" +
                    "  }" +
                    "  new QWebChannel(qt.webChannelTransport, function(channel) {" +
                    "    window.mpvBridge = channel.objects.bridge;" +
                    "    window.mpvEvents = {" +
                    "      onTimeChanged: null," +
                    "      onDurationChanged: null," +
                    "      onEofReached: null," +
                    "      onPauseChanged: null" +
                    "    };" +
                    "    if (window.mpvBridge) {" +
                    "      window.mpvBridge.timeChanged.connect(function(s) {" +
                    "        if (window.mpvEvents.onTimeChanged) window.mpvEvents.onTimeChanged(s);" +
                    "      });" +
                    "      window.mpvBridge.durationChanged.connect(function(s) {" +
                    "        if (window.mpvEvents.onDurationChanged) window.mpvEvents.onDurationChanged(s);" +
                    "      });" +
                    "      window.mpvBridge.eofReached.connect(function() {" +
                    "        if (window.mpvEvents.onEofReached) window.mpvEvents.onEofReached();" +
                    "      });" +
                    "      window.mpvBridge.pauseChanged.connect(function(p) {" +
                    "        if (window.mpvEvents.onPauseChanged) window.mpvEvents.onPauseChanged(p);" +
                    "      });" +
                    "    }" +
                    "    console.log('[shell] bridge wired, objects: ' + Object.keys(channel.objects));" +
                    "  });" +
                    "})()"
                )
            }
        }
    }

    WebChannel {
        id: wChannel
    }
}
