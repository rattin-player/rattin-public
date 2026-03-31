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
    connect(m_mpv, &MpvObject::mpvEvent, this, &MpvBridge::onMpvEvent);
}

void MpvBridge::play(const QString &url)
{
    if (!m_mpv) return;
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

void MpvBridge::stop()
{
    if (!m_mpv) return;
    m_mpv->command(QVariantList{"stop"});
    m_isPlaying = false;
    emit isPlayingChanged(false);
}

QVariant MpvBridge::getProperty(const QString &name) const
{
    if (!m_mpv) return QVariant();
    return m_mpv->getProperty(name);
}

void MpvBridge::onMpvEvent(const QString &eventName, const QVariant &value)
{
    if (eventName == "time-pos" && value.canConvert<double>()) {
        emit timeChanged(value.toDouble());
    } else if (eventName == "duration" && value.canConvert<double>()) {
        emit durationChanged(value.toDouble());
    } else if (eventName == "pause" && value.canConvert<bool>()) {
        emit pauseChanged(value.toBool());
    } else if (eventName == "eof") {
        m_isPlaying = false;
        emit isPlayingChanged(false);
        emit eofReached();
    }
}
