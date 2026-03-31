#include "mpvobject.h"

#include <clocale>
#include <cstring>
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QQuickWindow>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <mpv/client.h>

// mpv/qthelper.hpp was removed in mpv 2.x. These helpers replace the
// mpv::qt:: functions we need: command, set_property, get_property,
// and node_to_variant.

namespace mpv_qt {

static QVariant node_to_variant(const mpv_node *node)
{
    if (!node) return QVariant();
    switch (node->format) {
    case MPV_FORMAT_STRING:
        return QString::fromUtf8(node->u.string);
    case MPV_FORMAT_FLAG:
        return static_cast<bool>(node->u.flag);
    case MPV_FORMAT_INT64:
        return static_cast<qlonglong>(node->u.int64);
    case MPV_FORMAT_DOUBLE:
        return node->u.double_;
    case MPV_FORMAT_NODE_ARRAY: {
        QVariantList list;
        auto *a = node->u.list;
        for (int i = 0; i < a->num; i++)
            list.append(node_to_variant(&a->values[i]));
        return list;
    }
    case MPV_FORMAT_NODE_MAP: {
        QVariantMap map;
        auto *m = node->u.list;
        for (int i = 0; i < m->num; i++)
            map.insert(QString::fromUtf8(m->keys[i]), node_to_variant(&m->values[i]));
        return map;
    }
    default:
        return QVariant();
    }
}

// Build an mpv_node from a QVariant for command() calls.
// Only handles the types we actually use: string lists.
static int command_variant(mpv_handle *mpv, const QVariant &params)
{
    if (!params.canConvert<QVariantList>()) return -1;
    QVariantList list = params.toList();

    // Build a simple string command array
    QList<QByteArray> utf8Args;
    QList<const char *> args;
    for (const auto &v : list) {
        utf8Args.append(v.toString().toUtf8());
        args.append(utf8Args.last().constData());
    }
    args.append(nullptr);
    return mpv_command(mpv, args.data());
}

static int set_property_variant(mpv_handle *mpv, const QString &name, const QVariant &value)
{
    QByteArray key = name.toUtf8();
    switch (value.typeId()) {
    case QMetaType::Bool: {
        int flag = value.toBool() ? 1 : 0;
        return mpv_set_property(mpv, key.constData(), MPV_FORMAT_FLAG, &flag);
    }
    case QMetaType::Int:
    case QMetaType::LongLong: {
        int64_t v = value.toLongLong();
        return mpv_set_property(mpv, key.constData(), MPV_FORMAT_INT64, &v);
    }
    case QMetaType::Double:
    case QMetaType::Float: {
        double v = value.toDouble();
        return mpv_set_property(mpv, key.constData(), MPV_FORMAT_DOUBLE, &v);
    }
    default: {
        QByteArray val = value.toString().toUtf8();
        return mpv_set_property_string(mpv, key.constData(), val.constData());
    }
    }
}

static QVariant get_property_variant(mpv_handle *mpv, const QString &name)
{
    mpv_node node;
    int err = mpv_get_property(mpv, name.toUtf8().constData(), MPV_FORMAT_NODE, &node);
    if (err < 0) return QVariant();
    QVariant result = node_to_variant(&node);
    mpv_free_node_contents(&node);
    return result;
}

} // namespace mpv_qt

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
    mpv_qt::command_variant(m_mpv, params);
    return QVariant();
}

void MpvObject::setProperty(const QString &name, const QVariant &value)
{
    mpv_qt::set_property_variant(m_mpv, name, value);
}

QVariant MpvObject::getProperty(const QString &name) const
{
    return mpv_qt::get_property_variant(m_mpv, name);
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
            value = mpv_qt::node_to_variant(static_cast<mpv_node *>(prop->data));
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
