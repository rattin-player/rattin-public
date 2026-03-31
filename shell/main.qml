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
        visible: false
        z: 1
    }

    // Web UI — the existing React app
    WebEngineView {
        id: webView
        anchors.fill: parent
        url: initialUrl
        z: 2

        webChannel: channel

        // Forward JS console.log to stderr for debugging
        onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceId) {
            console.log("[js]", message);
        }

        // Bridge wiring is done by React (native-bridge.ts) via QWebChannel.
        // qwebchannel.js is injected into MainWorld by C++ (QWebEngineProfile::scripts).
    }

    // QWebChannel exposes the bridge to JS — "bridge" is set as context property from C++
    WebChannel {
        id: channel
        registeredObjects: [bridge]
    }

    Connections {
        target: bridge
        function onIsPlayingChanged(playing) {
            webView.z = playing ? 0 : 2;
            mpvPlayer.visible = playing;
        }
    }
}
