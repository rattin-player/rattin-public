import QtQuick
import QtQuick.Window
import QtQuick.Controls
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
    property var reversedSubTracks: []
    property var audioTracks: []
    property int activeSub: 0
    property int activeAudio: 1
    property int subSize: 55
    property bool sourcePanelOpen: false
    property int sourceCount: 0
    property bool coreIdle: true
    property bool loadingOverlay: false
    property string posterUrl: ""
    property string loadingStatus: ""
    property bool seekBuffering: false
    property bool slowWarning: false
    property bool slowWarningDismissed: false
    property bool hasAlternateSources: false

    function togglePause() {
        if (root.paused) bridge.resume()
        else bridge.pause()
    }

    function toggleFullscreen() {
        if (root.visibility === Window.FullScreen) root.showNormal()
        else root.showFullScreen()
    }

    // Save watch progress via JS before stopping playback.
    // Uses sync XHR with a 2s timeout so the UI never hangs indefinitely.
    function saveProgressAndStop() {
        if (root.currentTime > 0) {
            var t = Math.floor(root.currentTime)
            var d = Math.floor(root.duration)
            webView.runJavaScript(
                "(function(){var s=window.__rattinWatchState;" +
                "if(s&&s.tmdbId){s.position=" + t + ";s.duration=" + d + ";" +
                "var x=new XMLHttpRequest();x.timeout=2000;" +
                "x.open('POST','/api/watch-history/progress',false);" +
                "x.setRequestHeader('Content-Type','application/json');x.send(JSON.stringify(s))}" +
                "})()",
                function(result) { bridge.stop() }
            )
        } else {
            bridge.stop()
        }
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
        root.reversedSubTracks = subs.slice().reverse()
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
        signal backRequested()                    // QML→JS: user pressed back in native overlay
        signal toggleSourcePanel()               // QML→JS: open/close source panel
        signal sourcePanelChanged(bool open)     // JS→QML: source panel state changed

        function play(url) { bridge.play(url) }
        function setSourceCount(count) { root.sourceCount = count }
        function notifySourcePanel(open) { transport.sourcePanelChanged(open) }
        function setPoster(url) { root.posterUrl = url }
        function setLoadingStatus(text) { root.loadingStatus = text }
        function setLoading(loading) { root.loadingOverlay = loading; if (!loading) root.seekBuffering = false }
        function setSlowWarning(show, hasAlt) { root.slowWarning = show; root.hasAlternateSources = hasAlt; if (!show) root.slowWarningDismissed = false }
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
            if (p) {
                seekBufferTimer.stop()
                root.seekBuffering = false
            }
        }
        function onIsPlayingChanged(p) {
            transport.isPlayingChanged(p)
            root.playing = p
            mpvPlayer.visible = p
            controlsOverlay.visible = p && !root.loadingOverlay
            if (p) {
                trackRefreshTimer.start()
                root.loadingOverlay = true
                root.seekBuffering = false
                root.slowWarning = false
                root.slowWarningDismissed = false
            } else {
                seekBufferTimer.stop()
                root.seekBuffering = false
            }
        }
        function onCoreIdleChanged(idle) {
            root.coreIdle = idle
            if (!idle && root.playing) {
                root.loadingOverlay = false
                root.seekBuffering = false
                controlsOverlay.visible = !root.sourcePanelOpen
            }
            if (idle && root.playing && !root.loadingOverlay && !root.paused) {
                seekBufferTimer.start()
            }
        }
    }

    // Sync QML state when JS changes state (phone remote → QML overlay)
    Connections {
        target: transport
        function onSubtitleTrackChanged(mpvId) { root.activeSub = mpvId }
        function onAudioTrackChanged(mpvId) { root.activeAudio = mpvId }
        function onVolumeChanged(percent) { root.volume = percent }
        function onSourcePanelChanged(open) {
            root.sourcePanelOpen = open
            mpvPlayer.visible = !open && root.playing
            controlsOverlay.visible = !open && root.playing && !root.loadingOverlay
        }
    }

    MpvObject {
        id: mpvPlayer
        anchors.fill: parent
        visible: false
        z: 3
    }

    property bool pageLoaded: false

    WebEngineView {
        id: webView
        anchors.fill: parent
        url: serverReady ? initialUrl : "about:blank"
        z: 2
        webChannel: wChannel
        backgroundColor: "#000000"

        onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceId) {
            console.log("[js]", message)
        }

        onLoadingChanged: function(loadingInfo) {
            if (loadingInfo.status === WebEngineView.LoadSucceededStatus) {
                webView.webChannel.registerObject("bridge", transport)
                console.log("[shell] bridge registered on channel")
                if (serverReady) root.pageLoaded = true
            }
        }
    }

    WebChannel {
        id: wChannel
    }

    // Loading splash — shown until the actual page has loaded
    Rectangle {
        anchors.fill: parent
        color: "#000000"
        visible: !root.pageLoaded
        z: 5
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

    Timer {
        id: seekBufferTimer
        interval: 300
        onTriggered: {
            if (root.coreIdle && root.playing && !root.loadingOverlay && !root.paused)
                root.seekBuffering = true
        }
    }

    // ── Loading overlay (covers mpv during load) ──
    Rectangle {
        id: loadingOverlay
        anchors.fill: parent
        color: "#000000"
        z: 4
        visible: opacity > 0
        opacity: (root.loadingOverlay && !root.sourcePanelOpen) ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 300 } }

        Image {
            anchors.fill: parent
            source: root.posterUrl
            fillMode: Image.PreserveAspectCrop
            opacity: 0.25
            visible: status === Image.Ready
        }

        // Spinner
        Rectangle {
            id: loadingSpinner
            anchors.centerIn: parent
            anchors.verticalCenterOffset: -20
            width: 40; height: 40
            radius: 20
            color: "transparent"
            border.width: 3
            border.color: "#40ffffff"

            Rectangle {
                width: 40; height: 40; radius: 20
                color: "transparent"
                border.width: 3
                border.color: "transparent"

                Canvas {
                    anchors.fill: parent
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.clearRect(0, 0, width, height)
                        ctx.strokeStyle = "#c9a84c"
                        ctx.lineWidth = 3
                        ctx.lineCap = "round"
                        ctx.beginPath()
                        ctx.arc(20, 20, 17, -Math.PI / 2, Math.PI / 4)
                        ctx.stroke()
                    }
                }

                RotationAnimation on rotation {
                    from: 0; to: 360
                    duration: 1000
                    loops: Animation.Infinite
                    running: loadingOverlay.visible
                }
            }
        }

        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: loadingSpinner.bottom
            anchors.topMargin: 20
            text: root.loadingStatus
            color: "#aaaaaa"
            font.pixelSize: 13
            visible: root.loadingStatus !== ""
        }

        // Top bar (back + title)
        Rectangle {
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: 60
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
                        onClicked: { console.log("[shell] loading overlay back clicked"); root.loadingOverlay = false; bridge.stop(); transport.backRequested() }
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

        // Slow source warning banner
        Rectangle {
            anchors.bottom: parent.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottomMargin: 40
            width: slowWarningRow.width + 32
            height: 40
            radius: 8
            color: "#20ef4444"
            border.width: 1
            border.color: "#40ef4444"
            visible: root.slowWarning && !root.slowWarningDismissed

            Row {
                id: slowWarningRow
                anchors.centerIn: parent
                spacing: 12

                Text {
                    text: "Source may be slow"
                    color: "#fca5a5"
                    font.pixelSize: 13
                    font.weight: Font.Medium
                    anchors.verticalCenter: parent.verticalCenter
                }

                Rectangle {
                    width: switchSourceText.width + 16
                    height: 26
                    radius: 4
                    color: "#30ef4444"
                    border.width: 1
                    border.color: "#40ef4444"
                    visible: root.hasAlternateSources
                    anchors.verticalCenter: parent.verticalCenter

                    Text {
                        id: switchSourceText
                        anchors.centerIn: parent
                        text: "Switch Source"
                        color: "#fca5a5"
                        font.pixelSize: 11
                        font.weight: Font.DemiBold
                    }

                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: transport.toggleSourcePanel()
                    }
                }

                Text {
                    text: "\u2715"
                    color: "#80fca5a5"
                    font.pixelSize: 13
                    anchors.verticalCenter: parent.verticalCenter
                    MouseArea {
                        anchors.fill: parent
                        anchors.margins: -6
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.slowWarningDismissed = true
                    }
                }
            }
        }
    }

    // ── Seek buffering spinner (lightweight, mid-playback) ──
    Rectangle {
        anchors.centerIn: parent
        width: 56; height: 56; radius: 28
        color: "#80000000"
        z: 4
        visible: root.seekBuffering && !root.loadingOverlay && !root.sourcePanelOpen

        Rectangle {
            anchors.centerIn: parent
            width: 32; height: 32; radius: 16
            color: "transparent"
            border.width: 2.5
            border.color: "#40ffffff"

            Canvas {
                anchors.fill: parent
                onPaint: {
                    var ctx = getContext("2d")
                    ctx.clearRect(0, 0, width, height)
                    ctx.strokeStyle = "#c9a84c"
                    ctx.lineWidth = 2.5
                    ctx.lineCap = "round"
                    ctx.beginPath()
                    ctx.arc(16, 16, 13, -Math.PI / 2, Math.PI / 4)
                    ctx.stroke()
                }
            }

            RotationAnimation on rotation {
                from: 0; to: 360
                duration: 1000
                loops: Animation.Infinite
                running: root.seekBuffering && !root.loadingOverlay
            }
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
                    transport.backRequested()
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
                        onClicked: { console.log("[shell] controls overlay back clicked"); transport.backRequested() }
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

        // ── Subtitle picker popup ──
        Rectangle {
            id: subPopup
            visible: false
            anchors.right: parent.right
            anchors.bottom: bottomBar.top
            anchors.rightMargin: 16
            anchors.bottomMargin: 8
            width: 260
            height: Math.min(subListCol.height + subSizeRow.height + 52, 340)
            radius: 8
            color: "#E0181818"
            clip: true

            MouseArea { anchors.fill: parent }

            // Size controls fixed at bottom
            Column {
                id: subSizeRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.margins: 12

                Rectangle { width: parent.width; height: 1; color: "#30ffffff" }

                Row {
                    spacing: 8; topPadding: 8
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

            Flickable {
                id: subFlick
                anchors.top: parent.top
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: subSizeRow.top
                anchors.margins: 12
                contentHeight: subListCol.height
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                Column {
                    id: subListCol
                    width: subFlick.width
                    spacing: 4

                    Rectangle {
                        width: parent.width; height: 28; radius: 4
                        color: root.activeSub === 0 ? "#30c9a84c" : "transparent"
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
                        model: root.reversedSubTracks
                        Rectangle {
                            width: subListCol.width; height: 28; radius: 4
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
                }

                ScrollBar.vertical: ScrollBar {
                    policy: subFlick.contentHeight > subFlick.height ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff
                }
            }
        }

        // ── Audio picker popup ──
        Rectangle {
            id: audioPopup
            visible: false
            anchors.right: parent.right
            anchors.bottom: bottomBar.top
            anchors.rightMargin: 16
            anchors.bottomMargin: 8
            width: 260
            height: Math.min(audioListCol.height + 24, 340)
            radius: 8
            color: "#E0181818"
            clip: true

            MouseArea { anchors.fill: parent }

            Flickable {
                id: audioFlick
                anchors.fill: parent
                anchors.margins: 12
                contentHeight: audioListCol.height
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                Column {
                    id: audioListCol
                    width: audioFlick.width
                    spacing: 4

                    Repeater {
                        model: root.audioTracks
                        Rectangle {
                            width: audioListCol.width; height: 28; radius: 4
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
                }

                ScrollBar.vertical: ScrollBar {
                    policy: audioFlick.contentHeight > audioFlick.height ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff
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
                    height: parent.height; radius: 2; color: "#c9a84c"
                }
                Rectangle {
                    visible: root.duration > 0
                    x: root.duration > 0 ? parent.width * (root.currentTime / root.duration) - 6 : 0
                    y: -4; width: 12; height: 12; radius: 6; color: "#c9a84c"
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

                Item {
                    id: playBtn
                    width: 30; height: 30
                    anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter

                    Canvas {
                        anchors.centerIn: parent; width: 16; height: 16
                        onPaint: {
                            var ctx = getContext("2d")
                            ctx.clearRect(0, 0, width, height)
                            ctx.fillStyle = "white"
                            if (root.paused) {
                                ctx.beginPath()
                                ctx.moveTo(4, 2); ctx.lineTo(16, 9); ctx.lineTo(4, 16)
                                ctx.closePath(); ctx.fill()
                            } else {
                                ctx.roundedRect(2, 2, 5, 14, 1, 1); ctx.fill()
                                ctx.roundedRect(11, 2, 5, 14, 1, 1); ctx.fill()
                            }
                        }
                        Connections {
                            target: root
                            function onPausedChanged() { playBtn.children[0].requestPaint() }
                        }
                    }

                    MouseArea {
                        anchors.fill: parent; hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor; onClicked: root.togglePause()
                    }
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

                // Source switcher button (hamburger icon)
                Canvas {
                    id: sourceBtn
                    width: 18; height: 18
                    anchors.right: fullscreenBtn.left; anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter
                    visible: root.sourceCount > 1
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.clearRect(0, 0, width, height)
                        ctx.fillStyle = sourceBtnMa.containsMouse ? "white" : "#888"
                        for (var i = 0; i < 3; i++) ctx.fillRect(2, 3 + i * 5, 14, 2)
                    }
                    Connections {
                        target: sourceBtnMa
                        function onContainsMouseChanged() { sourceBtn.requestPaint() }
                    }
                    MouseArea {
                        id: sourceBtnMa; anchors.fill: parent; anchors.margins: -8
                        hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: transport.toggleSourcePanel()
                    }
                }

                Text {
                    id: audioBtn; text: "\uD83D\uDD0A"
                    color: "#888"
                    font.pixelSize: 14
                    anchors.right: sourceBtn.visible ? sourceBtn.left : fullscreenBtn.left
                    anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter
                    visible: root.audioTracks.length > 1
                    MouseArea {
                        anchors.fill: parent; anchors.margins: -8; cursorShape: Qt.PointingHandCursor
                        onClicked: { root.refreshTracks(); subPopup.visible = false; audioPopup.visible = !audioPopup.visible }
                    }
                }

                Text {
                    id: subBtn; text: "CC"
                    color: root.activeSub > 0 ? "#c9a84c" : "#888"
                    font.pixelSize: 13; font.bold: true
                    anchors.right: audioBtn.visible ? audioBtn.left : (sourceBtn.visible ? sourceBtn.left : fullscreenBtn.left)
                    anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter
                    visible: root.subTracks.length > 0
                    MouseArea {
                        anchors.fill: parent; anchors.margins: -8; cursorShape: Qt.PointingHandCursor
                        onClicked: { root.refreshTracks(); audioPopup.visible = false; subPopup.visible = !subPopup.visible }
                    }
                }

                Row {
                    anchors.right: subBtn.visible ? subBtn.left : (audioBtn.visible ? audioBtn.left : (sourceBtn.visible ? sourceBtn.left : fullscreenBtn.left))
                    anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter
                    spacing: 8

                    Item {
                        width: 30; height: 30
                        anchors.verticalCenter: parent.verticalCenter

                        Canvas {
                            id: volCanvas
                            anchors.centerIn: parent; width: 18; height: 18
                            onPaint: {
                                var ctx = getContext("2d")
                                ctx.clearRect(0, 0, width, height)
                                ctx.strokeStyle = "white"; ctx.lineWidth = 1.8
                                ctx.lineCap = "round"; ctx.lineJoin = "round"
                                ctx.beginPath()
                                ctx.moveTo(10, 3); ctx.lineTo(5, 6); ctx.lineTo(2, 6)
                                ctx.lineTo(2, 12); ctx.lineTo(5, 12); ctx.lineTo(10, 15)
                                ctx.closePath()
                                ctx.fillStyle = "white"; ctx.fill()
                                if (root.volume === 0) {
                                    ctx.beginPath(); ctx.moveTo(13, 6); ctx.lineTo(17, 12); ctx.stroke()
                                    ctx.beginPath(); ctx.moveTo(17, 6); ctx.lineTo(13, 12); ctx.stroke()
                                } else {
                                    ctx.beginPath(); ctx.arc(11, 9, 3, -0.8, 0.8); ctx.stroke()
                                    if (root.volume >= 50) {
                                        ctx.beginPath(); ctx.arc(11, 9, 6, -0.9, 0.9); ctx.stroke()
                                    }
                                }
                            }
                            Connections {
                                target: root
                                function onVolumeChanged() { volCanvas.requestPaint() }
                            }
                        }

                        MouseArea {
                            anchors.fill: parent; hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (root.volume > 0) { controlsOverlay._savedVolume = root.volume; root.volume = 0 }
                                else { root.volume = controlsOverlay._savedVolume || 100 }
                                bridge.setVolume(root.volume); transport.nativeVolumeChanged(root.volume)
                            }
                        }
                    }

                    Rectangle {
                        width: 80; height: 4; radius: 2; color: "#26ffffff"; anchors.verticalCenter: parent.verticalCenter
                        Rectangle { width: parent.width * (root.volume / 100); height: parent.height; radius: 2; color: "#c9a84c" }
                        Rectangle {
                            x: parent.width * (root.volume / 100) - 5; y: -3; width: 10; height: 10; radius: 5
                            color: "#c9a84c"
                            scale: volSliderMa.containsMouse || volSliderMa.pressed ? 1.3 : 1.0
                            Behavior on scale { NumberAnimation { duration: 150 } }
                        }
                        MouseArea {
                            id: volSliderMa
                            anchors.fill: parent; anchors.topMargin: -10; anchors.bottomMargin: -10
                            hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: function(mouse) { var v = Math.round(Math.max(0, Math.min(100, (mouse.x / parent.width) * 100))); root.volume = v; bridge.setVolume(v); transport.nativeVolumeChanged(v) }
                            onPositionChanged: function(mouse) { if (pressed) { var v = Math.round(Math.max(0, Math.min(100, (mouse.x / parent.width) * 100))); root.volume = v; bridge.setVolume(v); transport.nativeVolumeChanged(v) } }
                        }
                    }
                }
            }
        }
    }
}
