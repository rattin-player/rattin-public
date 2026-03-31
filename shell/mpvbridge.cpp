#include "mpvbridge.h"
#include "mpvobject.h"

MpvBridge::MpvBridge(MpvObject *mpv, QObject *parent)
    : QObject(parent)
    , m_mpv(mpv)
{
    // Observe properties we need to forward to JS
    m_mpv->observeProperty("time-pos");
    m_mpv->observeProperty("duration");
    m_mpv->observeProperty("pause");
    m_mpv->observeProperty("eof-reached");

    connect(m_mpv, &MpvObject::mpvEvent, this, &MpvBridge::onMpvEvent);
}

void MpvBridge::play(const QString &url)
{
    m_mpv->command(QVariantList{"loadfile", url});
    m_isPlaying = true;
    emit isPlayingChanged(true);
}

void MpvBridge::pause()
{
    m_mpv->setProperty("pause", true);
}

void MpvBridge::resume()
{
    m_mpv->setProperty("pause", false);
}

void MpvBridge::seek(double seconds)
{
    m_mpv->command(QVariantList{"seek", seconds, "absolute"});
}

void MpvBridge::setVolume(int percent)
{
    m_mpv->setProperty("volume", percent);
}

void MpvBridge::setAudioTrack(int index)
{
    // mpv audio track IDs are 1-based; 0 means auto
    m_mpv->setProperty("aid", index + 1);
}

void MpvBridge::setSubtitleTrack(int index)
{
    if (index < 0) {
        m_mpv->setProperty("sid", "no");
    } else {
        // mpv subtitle track IDs are 1-based
        m_mpv->setProperty("sid", index + 1);
    }
}

void MpvBridge::stop()
{
    m_mpv->command(QVariantList{"stop"});
    m_isPlaying = false;
    emit isPlayingChanged(false);
}

QVariant MpvBridge::getProperty(const QString &name) const
{
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
