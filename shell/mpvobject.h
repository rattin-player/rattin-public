#pragma once

#include <QQuickFramebufferObject>
#include <mpv/client.h>
#include <mpv/render_gl.h>

class MpvRenderer;

class MpvObject : public QQuickFramebufferObject
{
    Q_OBJECT
    friend class MpvRenderer;

public:
    explicit MpvObject(QQuickItem *parent = nullptr);
    ~MpvObject() override;

    Renderer *createRenderer() const override;

public slots:
    QVariant command(const QVariant &params);
    void setProperty(const QString &name, const QVariant &value);
    QVariant getProperty(const QString &name) const;
    void observeProperty(const QString &name);

signals:
    void onUpdate();
    void mpvEvent(const QString &eventName, const QVariant &value);

private slots:
    void doUpdate();
    void onMpvEvents();

private:
    void handleMpvEvent(mpv_event *event);
    static void onMpvRedraw(void *ctx);
    static void wakeup(void *ctx);

    mpv_handle *m_mpv = nullptr;
    mpv_render_context *m_mpvGL = nullptr;
};
