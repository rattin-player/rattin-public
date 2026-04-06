#pragma once

#include <QObject>
#include <QVariant>

class MpvObject;

class MpvBridge : public QObject
{
    Q_OBJECT

public:
    explicit MpvBridge(QObject *parent = nullptr);
    void attachMpv(MpvObject *mpv);

    // These slots are callable from JavaScript via QWebChannel
public slots:
    void play(const QString &url);
    void pause();
    void resume();
    void togglePause();
    void seek(double seconds);
    void setVolume(int percent);
    void setAudioTrack(int index);
    void setSubtitleTrack(int index);
    void loadExternalSubtitle(const QString &url, const QString &title = QString());
    void stop();
    QVariant getProperty(const QString &name) const;
    void setProperty(const QString &name, const QVariant &value);

signals:
    // Emitted to JavaScript
    void timeChanged(double seconds);
    void durationChanged(double seconds);
    void eofReached();
    void pauseChanged(bool paused);
    void isPlayingChanged(bool playing);
    void coreIdleChanged(bool idle);
    void externalSubtitleLoaded();

private slots:
    void onMpvEvent(const QString &eventName, const QVariant &value);

private:
    MpvObject *m_mpv;
    bool m_isPlaying = false;
    bool m_loadPending = false;  // true after play() until first time-pos arrives
    QString m_pendingSubUrl;
    QString m_pendingSubTitle;
};
