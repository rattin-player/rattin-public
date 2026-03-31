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

        onLoadingChanged: function(loadingInfo) {
            if (loadingInfo.status === WebEngineView.LoadSucceededStatus) {
                console.log("[shell] page loaded, wiring bridge...");
                // qwebchannel.js is injected into MainWorld via C++ (QWebEngineProfile::scripts).
                // Now wire up the QWebChannel bridge so React can access mpvBridge.
                webView.runJavaScript(
                    "(function() {" +
                    "  var diag = {" +
                    "    QWebChannel: typeof QWebChannel," +
                    "    qt: typeof qt," +
                    "    qtTransport: typeof qt !== 'undefined' && qt ? typeof qt.webChannelTransport : 'no qt'," +
                    "    url: location.href" +
                    "  };" +
                    "  console.log('[shell] diag: ' + JSON.stringify(diag));" +
                    "  if (typeof QWebChannel === 'undefined') {" +
                    "    console.error('[shell] QWebChannel not defined');" +
                    "    return 'no QWebChannel';" +
                    "  }" +
                    "  if (typeof qt === 'undefined' || !qt || !qt.webChannelTransport) {" +
                    "    console.error('[shell] qt.webChannelTransport not available');" +
                    "    return 'no transport';" +
                    "  }" +
                    "  try {" +
                    "    new QWebChannel(qt.webChannelTransport, function(channel) {" +
                    "      console.log('[shell] channel objects: ' + JSON.stringify(Object.keys(channel.objects)));" +
                    "      window.mpvBridge = channel.objects.bridge;" +
                    "      window.mpvEvents = {" +
                    "        onTimeChanged: null," +
                    "        onDurationChanged: null," +
                    "        onEofReached: null," +
                    "        onPauseChanged: null" +
                    "      };" +
                    "      if (window.mpvBridge) {" +
                    "        window.mpvBridge.timeChanged.connect(function(s) {" +
                    "          if (window.mpvEvents.onTimeChanged) window.mpvEvents.onTimeChanged(s);" +
                    "        });" +
                    "        window.mpvBridge.durationChanged.connect(function(s) {" +
                    "          if (window.mpvEvents.onDurationChanged) window.mpvEvents.onDurationChanged(s);" +
                    "        });" +
                    "        window.mpvBridge.eofReached.connect(function() {" +
                    "          if (window.mpvEvents.onEofReached) window.mpvEvents.onEofReached();" +
                    "        });" +
                    "        window.mpvBridge.pauseChanged.connect(function(p) {" +
                    "          if (window.mpvEvents.onPauseChanged) window.mpvEvents.onPauseChanged(p);" +
                    "        });" +
                    "      }" +
                    "      console.log('[shell] bridge wired: ' + !!window.mpvBridge);" +
                    "    });" +
                    "    return 'connecting';" +
                    "  } catch(e) {" +
                    "    console.error('[shell] QWebChannel error: ' + e.message);" +
                    "    return 'error: ' + e.message;" +
                    "  }" +
                    "})()"
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
