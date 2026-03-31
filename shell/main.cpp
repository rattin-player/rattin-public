#include <QGuiApplication>
#include <QQuickWindow>
#include <QtWebEngineQuick>

int main(int argc, char *argv[])
{
    // Force OpenGL backend — required for QQuickFramebufferObject + mpv.
    // Verified working in qt6-mpv-reference (qt6-mpv-reference).
    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);

    QtWebEngineQuick::initialize();

    QGuiApplication app(argc, argv);
    app.setApplicationName("Rattin");
    app.setOrganizationName("MagnetPlayer");

    // TODO: Tasks 4-7 will fill in the QML engine, mpv, bridge, and server launch
    return app.exec();
}
