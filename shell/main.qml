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

        // Mark window.__NATIVE__ early so React can detect native mode at module load.
        // Also inject qwebchannel.js into MainWorld (belt-and-suspenders with runJavaScript).
        Component.onCompleted: {
            webView.userScripts.collection = [
                {
                    "sourceUrl": "qrc:///qtwebchannel/qwebchannel.js",
                    "injectionPoint": WebEngineScript.DocumentCreation,
                    "worldId": WebEngineScript.MainWorld
                },
                {
                    "name": "native-marker",
                    "sourceCode": "window.__NATIVE__ = true; console.log('[shell] __NATIVE__ marker set');",
                    "injectionPoint": WebEngineScript.DocumentCreation,
                    "worldId": WebEngineScript.MainWorld
                }
            ]
        }

        onLoadingChanged: function(loadingInfo) {
            if (loadingInfo.status === WebEngineView.LoadSucceededStatus) {
                // Step 1: Load qwebchannel.js source into MainWorld via runJavaScript.
                // The userScripts.collection approach may silently fail on some Qt6 versions,
                // so we fetch the resource and eval it as a fallback-proof method.
                webView.runJavaScript(
                    "(function() {" +
                    "  if (typeof QWebChannel !== 'undefined') { return 'already loaded'; }" +
                    "  var xhr = new XMLHttpRequest();" +
                    "  xhr.open('GET', 'qrc:///qtwebchannel/qwebchannel.js', false);" +
                    "  xhr.send();" +
                    "  if (xhr.status === 200) { eval(xhr.responseText); return 'loaded'; }" +
                    "  return 'failed: ' + xhr.status;" +
                    "})()",
                    function(result) {
                        console.log("[shell] qwebchannel.js:", result);
                        // Step 2: Create the channel and wire up the bridge
                        webView.runJavaScript(
                            "(function() {" +
                            "  if (typeof QWebChannel === 'undefined') {" +
                            "    console.error('[shell] QWebChannel still not defined');" +
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
                            "    window.mpvBridge.timeChanged.connect(function(s) {" +
                            "      if (window.mpvEvents.onTimeChanged) window.mpvEvents.onTimeChanged(s);" +
                            "    });" +
                            "    window.mpvBridge.durationChanged.connect(function(s) {" +
                            "      if (window.mpvEvents.onDurationChanged) window.mpvEvents.onDurationChanged(s);" +
                            "    });" +
                            "    window.mpvBridge.eofReached.connect(function() {" +
                            "      if (window.mpvEvents.onEofReached) window.mpvEvents.onEofReached();" +
                            "    });" +
                            "    window.mpvBridge.pauseChanged.connect(function(p) {" +
                            "      if (window.mpvEvents.onPauseChanged) window.mpvEvents.onPauseChanged(p);" +
                            "    });" +
                            "    console.log('[shell] QWebChannel bridge wired up');" +
                            "  });" +
                            "})()"
                        );
                    }
                );
            }
        }
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
