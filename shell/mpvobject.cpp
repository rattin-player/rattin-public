#include "mpvobject.h"

#include <clocale>
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QQuickWindow>
#include <mpv/qthelper.hpp>

#ifdef Q_OS_WIN
#include <dwmapi.h>
#endif

namespace {

void *getProcAddress(void *ctx, const char *name)
{
    Q_UNUSED(ctx);
    auto glctx = QOpenGLContext::currentContext();
    if (!glctx) return nullptr;
    return reinterpret_cast<void *>(glctx->getProcAddress(QByteArray(name)));
}

} // namespace

class MpvRenderer : public QQuickFramebufferObject::Renderer
{
public:
    explicit MpvRenderer(MpvObject *obj) : m_obj(obj) {}

    QOpenGLFramebufferObject *createFramebufferObject(const QSize &size) override
    {
        if (!m_obj->m_mpvGL) {
            mpv_opengl_init_params glInitParams{getProcAddress, nullptr};
            mpv_render_param params[]{
                {MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_OPENGL)},
                {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &glInitParams},
                {MPV_RENDER_PARAM_INVALID, nullptr}
            };
            mpv_render_context_create(&m_obj->m_mpvGL, m_obj->m_mpv, params);
            mpv_render_context_set_update_callback(m_obj->m_mpvGL, MpvObject::onMpvRedraw, m_obj);
        }
        return QQuickFramebufferObject::Renderer::createFramebufferObject(size);
    }

    void render() override
    {
        if (!m_obj->m_mpvGL) return;

        auto *fbo = framebufferObject();
        mpv_opengl_fbo mpvFbo{
            static_cast<int>(fbo->handle()),
            fbo->width(),
            fbo->height(),
            0
        };
        int flipY = 1;
        mpv_render_param params[]{
            {MPV_RENDER_PARAM_OPENGL_FBO, &mpvFbo},
            {MPV_RENDER_PARAM_FLIP_Y, &flipY},
            {MPV_RENDER_PARAM_INVALID, nullptr}
        };
        mpv_render_context_render(m_obj->m_mpvGL, params);
    }

private:
    MpvObject *m_obj;
};

MpvObject::MpvObject(QQuickItem *parent)
    : QQuickFramebufferObject(parent)
{
    std::setlocale(LC_NUMERIC, "C");

#ifdef Q_OS_WIN
    DwmEnableMMCSS(TRUE);
#endif

    m_mpv = mpv_create();
    if (!m_mpv) return;

    // Enable hardware decoding — auto-selects VAAPI/NVDEC/DXVA/VideoToolbox
    mpv_set_property_string(m_mpv, "hwdec", "auto");
    mpv_set_property_string(m_mpv, "vo", "libmpv");
    mpv_set_property_string(m_mpv, "gpu-hwdec-interop", "auto");
    // Keep mpv running after playback ends (needed for command interface)
    mpv_set_property_string(m_mpv, "keep-open", "yes");
    mpv_set_property_string(m_mpv, "idle", "yes");
    // Torrent-friendly: generous cache and timeout for incomplete downloads.
    // WebTorrent streams may stall while pieces are fetched from peers.
    mpv_set_property_string(m_mpv, "cache", "yes");
    mpv_set_property_string(m_mpv, "cache-secs", "30");
    mpv_set_property_string(m_mpv, "demuxer-max-back-bytes", "50M");
    mpv_set_property_string(m_mpv, "network-timeout", "60");

    mpv_initialize(m_mpv);

    mpv_set_wakeup_callback(m_mpv, wakeup, this);

    connect(this, &MpvObject::onUpdate, this, &MpvObject::doUpdate, Qt::QueuedConnection);
}

MpvObject::~MpvObject()
{
    if (m_mpvGL) mpv_render_context_free(m_mpvGL);
    if (m_mpv) mpv_destroy(m_mpv);
}

QQuickFramebufferObject::Renderer *MpvObject::createRenderer() const
{
    window()->setPersistentGraphics(true);
    window()->setPersistentSceneGraph(true);
    return new MpvRenderer(const_cast<MpvObject *>(this));
}

QVariant MpvObject::command(const QVariant &params)
{
    return mpv::qt::command(m_mpv, params);
}

void MpvObject::setProperty(const QString &name, const QVariant &value)
{
    mpv::qt::set_property(m_mpv, name, value);
}

QVariant MpvObject::getProperty(const QString &name) const
{
    return mpv::qt::get_property(m_mpv, name);
}

void MpvObject::observeProperty(const QString &name)
{
    mpv_observe_property(m_mpv, 0, name.toUtf8().constData(), MPV_FORMAT_NODE);
}

void MpvObject::doUpdate()
{
    update();
}

void MpvObject::onMpvRedraw(void *ctx)
{
    QMetaObject::invokeMethod(static_cast<MpvObject *>(ctx), "doUpdate", Qt::QueuedConnection);
}

void MpvObject::wakeup(void *ctx)
{
    QMetaObject::invokeMethod(static_cast<MpvObject *>(ctx), "onMpvEvents", Qt::QueuedConnection);
}

void MpvObject::onMpvEvents()
{
    while (m_mpv) {
        mpv_event *event = mpv_wait_event(m_mpv, 0);
        if (event->event_id == MPV_EVENT_NONE) break;
        handleMpvEvent(event);
    }
}

void MpvObject::handleMpvEvent(mpv_event *event)
{
    switch (event->event_id) {
    case MPV_EVENT_PROPERTY_CHANGE: {
        auto *prop = static_cast<mpv_event_property *>(event->data);
        QVariant value;
        if (prop->format == MPV_FORMAT_NODE) {
            value = mpv::qt::node_to_variant(static_cast<mpv_node *>(prop->data));
        } else if (prop->format == MPV_FORMAT_DOUBLE) {
            value = *static_cast<double *>(prop->data);
        } else if (prop->format == MPV_FORMAT_FLAG) {
            value = *static_cast<int *>(prop->data) != 0;
        } else if (prop->format == MPV_FORMAT_STRING) {
            value = QString::fromUtf8(*static_cast<char **>(prop->data));
        }
        emit mpvEvent(QString::fromUtf8(prop->name), value);
        break;
    }
    case MPV_EVENT_END_FILE:
        emit mpvEvent("eof", QVariant());
        break;
    default:
        break;
    }
}
