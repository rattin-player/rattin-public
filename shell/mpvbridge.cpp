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
    m_needsStateEmit = true;  // Force-emit duration/core-idle on first time-pos
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

void MpvBridge::togglePause()
{
    if (!m_mpv) return;
    m_mpv->command(QVariantList{"cycle", "pause"});
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

QVariantList MpvBridge::getMpvChapters() const
{
    QVariantList out;
    if (!m_mpv) return out;
    QVariant cl = m_mpv->getProperty("chapter-list");
    if (!cl.canConvert<QVariantList>()) return out;
    for (const QVariant &c : cl.toList()) {
        QVariantMap m = c.toMap();
        QVariantMap o;
        o["time"] = m.value("time").toDouble();
        o["title"] = m.value("title").toString();
        out.append(o);
    }
    return out;
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
        // When replaying the same file, mpv's property observers may not fire
        // for duration/core-idle because the values didn't change. Force-query
        // them on the first time-pos to guarantee React receives them.
        if (m_needsStateEmit) {
            m_needsStateEmit = false;
            QVariant dur = m_mpv->getProperty("duration");
            if (dur.canConvert<double>() && dur.toDouble() > 0) {
                fprintf(stderr, "[bridge] force-emit duration: %.1f\n", dur.toDouble());
                emit durationChanged(dur.toDouble());
            }
            QVariant idle = m_mpv->getProperty("core-idle");
            if (idle.canConvert<bool>()) {
                fprintf(stderr, "[bridge] force-emit core-idle: %d\n", idle.toBool());
                emit coreIdleChanged(idle.toBool());
            }
        }
        emit timeChanged(value.toDouble());
    } else if (eventName == "duration" && value.canConvert<double>()) {
        m_needsStateEmit = false;  // Observer fired — no need to force-query
        emit durationChanged(value.toDouble());
    } else if (eventName == "core-idle" && value.canConvert<bool>()) {
        emit coreIdleChanged(value.toBool());
    } else if (eventName == "pause" && value.canConvert<bool>()) {
        emit pauseChanged(value.toBool());
    } else if (eventName == "load-error") {
        // loadfile failed (HTTP error, network timeout, file not found).
        // Do NOT suppress even though m_loadPending is true — this is a real
        // failure, not a stale EOF from the previous file. Clear pending state
        // and emit eofReached so React can recover (go back, show error, retry).
        m_loadPending = false;
        m_needsStateEmit = false;
        fprintf(stderr, "[bridge] load error: mpv error code %d\n", value.toInt());
        emit eofReached();
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
