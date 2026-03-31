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

    // Mpv video renderer — sits behind the webview, shown during playback
    MpvObject {
        id: mpvPlayer
        anchors.fill: parent
        visible: bridge.isPlaying
        z: 1
    }

    // Web UI — the existing React app
    WebEngineView {
        id: webView
        anchors.fill: parent
        url: initialUrl
        z: bridge.isPlaying ? 0 : 2

        // Inject the bridge into the page's JS context.
        // Setting webChannel auto-injects qwebchannel.js (no manual userScripts needed).
        webChannel: channel

        onLoadingChanged: function(loadingInfo) {
            if (loadingInfo.status === WebEngineView.LoadSucceededStatus) {
                // Wire up window.mpvBridge + window.mpvEvents via QWebChannel.
                // qwebchannel.js was already loaded by userScripts above.
                webView.runJavaScript(
                    "new QWebChannel(qt.webChannelTransport, function(channel) {" +
                    "  window.mpvBridge = channel.objects.mpvBridge;" +
                    "  window.mpvEvents = {" +
                    "    onTimeChanged: null," +
                    "    onDurationChanged: null," +
                    "    onEofReached: null," +
                    "    onPauseChanged: null" +
                    "  };" +
                    "  window.mpvBridge.timeChanged.connect(function(s) {" +
                    "    if (window.mpvEvents.onTimeChanged) window.mpvEvents.onTimeChanged(s);" +
                    "  });" +
                    "  window.mpvBridge.durationChanged.connect(function(s) {" +
                    "    if (window.mpvEvents.onDurationChanged) window.mpvEvents.onDurationChanged(s);" +
                    "  });" +
                    "  window.mpvBridge.eofReached.connect(function() {" +
                    "    if (window.mpvEvents.onEofReached) window.mpvEvents.onEofReached();" +
                    "  });" +
                    "  window.mpvBridge.pauseChanged.connect(function(p) {" +
                    "    if (window.mpvEvents.onPauseChanged) window.mpvEvents.onPauseChanged(p);" +
                    "  });" +
                    "});"
                );
            }
        }
    }

    // QWebChannel exposes the bridge to JS
    WebChannel {
        id: channel
        registeredObjects: [bridge]
    }

    property bool isPlaying: false

    Connections {
        target: typeof mpvBridgeObj !== "undefined" ? mpvBridgeObj : null
        function onIsPlayingChanged(playing) {
            root.isPlaying = playing;
            // When playback starts, hide webview; when it stops, show it
            webView.z = playing ? 0 : 2;
            mpvPlayer.visible = playing;
        }
    }
}
