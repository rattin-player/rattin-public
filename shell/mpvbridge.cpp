#include "mpvbridge.h"
#include "mpvobject.h"

MpvBridge::MpvBridge(QObject *parent)
    : QObject(parent)
    , m_mpv(nullptr)
{
}

void MpvBridge::attachMpv(MpvObject *mpv)
{
    m_mpv = mpv;
    m_mpv->observeProperty("time-pos");
    m_mpv->observeProperty("duration");
    m_mpv->observeProperty("pause");
    m_mpv->observeProperty("eof-reached");
    m_mpv->observeProperty("core-idle");
    connect(m_mpv, &MpvObject::mpvEvent, this, &MpvBridge::onMpvEvent);
}

void MpvBridge::play(const QString &url)
{
    if (!m_mpv) {
        fprintf(stderr, "[bridge] play() called but m_mpv is null!\n");
        return;
    }
    fprintf(stderr, "[bridge] loadfile: %s (wasPlaying=%d)\n", url.toUtf8().constData(), m_isPlaying);
    m_loadPending = true;  // Suppress stale EOF until new file produces time updates
    m_pendingSubUrl.clear();  // Clear any stale queued subtitle from previous session
    m_pendingSubTitle.clear();
    m_mpv->setProperty("pause", false);  // Ensure mpv is unpaused before loading
    m_mpv->command(QVariantList{"loadfile", url});
    m_isPlaying = true;
    emit isPlayingChanged(true);
}

void MpvBridge::pause()
{
    if (!m_mpv) return;
    m_mpv->setProperty("pause", true);
}

void MpvBridge::resume()
{
    if (!m_mpv) return;
    m_mpv->setProperty("pause", false);
}

void MpvBridge::seek(double seconds)
{
    if (!m_mpv) return;
    m_mpv->command(QVariantList{"seek", seconds, "absolute"});
}

void MpvBridge::setVolume(int percent)
{
    if (!m_mpv) return;
    m_mpv->setProperty("volume", percent);
}

void MpvBridge::setAudioTrack(int index)
{
    if (!m_mpv) return;
    m_mpv->setProperty("aid", index + 1);
}

void MpvBridge::setSubtitleTrack(int index)
{
    if (!m_mpv) return;
    if (index < 0) {
        m_mpv->setProperty("sid", "no");
    } else {
        m_mpv->setProperty("sid", index + 1);
    }
}

void MpvBridge::loadExternalSubtitle(const QString &url, const QString &title)
{
    if (!m_mpv) return;
    if (m_loadPending) {
        fprintf(stderr, "[bridge] queuing external subtitle (load pending): %s\n", url.toUtf8().constData());
        m_pendingSubUrl = url;
        m_pendingSubTitle = title;
        return;
    }
    fprintf(stderr, "[bridge] loading external subtitle: %s\n", url.toUtf8().constData());
    QVariantList cmd = {"sub-add", url, "select"};
    if (!title.isEmpty()) cmd.append(title);
    m_mpv->command(cmd);
    emit externalSubtitleLoaded();
}

void MpvBridge::stop()
{
    if (!m_mpv) return;
    fprintf(stderr, "[bridge] stop() — pausing + hiding (surface kept alive)\n");
    m_loadPending = false;
    m_mpv->setProperty("pause", true);
    m_isPlaying = false;
    emit isPlayingChanged(false);
}

QVariant MpvBridge::getProperty(const QString &name) const
{
    if (!m_mpv) return QVariant();
    return m_mpv->getProperty(name);
}

void MpvBridge::setProperty(const QString &name, const QVariant &value)
{
    if (!m_mpv) return;
    // mpv integer properties need int64 — JS sends doubles via QWebChannel
    if (name == "sid" || name == "aid" || name == "sub-font-size") {
        m_mpv->setProperty(name, QVariant(value.toLongLong()));
    } else {
        m_mpv->setProperty(name, value);
    }
}

void MpvBridge::onMpvEvent(const QString &eventName, const QVariant &value)
{
    if (eventName == "time-pos" && value.canConvert<double>()) {
        m_loadPending = false;  // New file is producing frames — EOF is real from now on
        if (!m_pendingSubUrl.isEmpty()) {
            fprintf(stderr, "[bridge] loading queued external subtitle: %s\n", m_pendingSubUrl.toUtf8().constData());
            QVariantList cmd = {"sub-add", m_pendingSubUrl, "select"};
            if (!m_pendingSubTitle.isEmpty()) cmd.append(m_pendingSubTitle);
            m_mpv->command(cmd);
            m_pendingSubUrl.clear();
            m_pendingSubTitle.clear();
            emit externalSubtitleLoaded();
        }
        emit timeChanged(value.toDouble());
    } else if (eventName == "duration" && value.canConvert<double>()) {
        emit durationChanged(value.toDouble());
    } else if (eventName == "pause" && value.canConvert<bool>()) {
        emit pauseChanged(value.toBool());
    } else if (eventName == "core-idle" && value.canConvert<bool>()) {
        emit coreIdleChanged(value.toBool());
    } else if (eventName == "eof") {
        if (m_loadPending) {
            // Stale EOF from the previous file during a loadfile transition — suppress it.
            // Without this, the JS eofReached handler would navigate(-1) back to home.
            fprintf(stderr, "[bridge] eof suppressed (loadPending)\n");
        } else {
            fprintf(stderr, "[bridge] eof\n");
            emit eofReached();
        }
    }
}
