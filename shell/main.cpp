#include <clocale>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QProcess>
#include <QTimer>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QTcpServer>
#include <QtWebEngineQuick>

#include "mpvobject.h"
#include "mpvbridge.h"

static int findFreePort()
{
    // Bind to port 0, read the OS-assigned port, then close.
    QTcpServer tmp;
    tmp.listen(QHostAddress::LocalHost, 0);
    int port = tmp.serverPort();
    tmp.close();
    return port;
}

static void waitForServer(int port, QObject *parent, std::function<void()> onReady)
{
    auto *mgr = new QNetworkAccessManager(parent);
    auto *timer = new QTimer(parent);
    timer->setInterval(200);
    QObject::connect(timer, &QTimer::timeout, [=]() {
        auto url = QUrl(QString("http://localhost:%1/api/status/health").arg(port));
        auto *reply = mgr->get(QNetworkRequest(url));
        QObject::connect(reply, &QNetworkReply::finished, [=]() {
            reply->deleteLater();
            if (reply->error() == QNetworkReply::NoError) {
                timer->stop();
                timer->deleteLater();
                mgr->deleteLater();
                onReady();
            }
        });
    });
    timer->start();
}

int main(int argc, char *argv[])
{
    std::setlocale(LC_NUMERIC, "C");

    // Force OpenGL — required for QQuickFramebufferObject + libmpv.
    // Verified working: known working pattern on Qt6.
    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);

    QtWebEngineQuick::initialize();

    QGuiApplication app(argc, argv);
    app.setApplicationName("Rattin");
    app.setOrganizationName("MagnetPlayer");
    app.setApplicationVersion("1.0.0");

    // Register MpvObject QML type
    qmlRegisterType<MpvObject>("com.magnetplayer.mpv", 1, 0, "MpvObject");

    // Determine server port
    int port = findFreePort();

    // Spawn Express server as child process
    auto *serverProcess = new QProcess(&app);
    serverProcess->setProcessChannelMode(QProcess::ForwardedChannels);

    // Find the app directory (where server.ts and node_modules live)
    QString appDir = QCoreApplication::applicationDirPath() + "/../";
    serverProcess->setWorkingDirectory(appDir);

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("PORT", QString::number(port));
    env.insert("HOST", "127.0.0.1");
    serverProcess->setProcessEnvironment(env);

    // Determine how to start the server:
    // 1. If server.js exists (pre-compiled), use node
    // 2. Otherwise use local node_modules/.bin/tsx (not global tsx which may not exist)
    QString serverScript;
    QString runner;
    QStringList args;

    if (QFile::exists(appDir + "/server.js")) {
        serverScript = "server.js";
        runner = "node";
        args = {"--env-file=.env", serverScript};
    } else {
        serverScript = "server.ts";
        // Use local tsx from node_modules — global tsx may not be installed
        QString localTsx = appDir + "/node_modules/.bin/tsx";
        if (QFile::exists(localTsx)) {
            runner = localTsx;
        } else {
            // Fall back to global tsx (might work if user installed it)
            runner = "tsx";
        }
        args = {"--env-file=.env", serverScript};
    }
    serverProcess->start(runner, args);

    // Clean up server on exit
    QObject::connect(&app, &QGuiApplication::aboutToQuit, [serverProcess]() {
        serverProcess->terminate();
        if (!serverProcess->waitForFinished(3000)) {
            serverProcess->kill();
        }
    });

    // Wait for server, then launch QML UI
    waitForServer(port, &app, [&app, port]() {
        auto *engine = new QQmlApplicationEngine(&app);
        engine->rootContext()->setContextProperty("serverPort", port);

        // Create mpv bridge (needs the MpvObject from QML — connected in main.qml)
        engine->rootContext()->setContextProperty("initialUrl",
            QString("http://localhost:%1").arg(port));

        engine->load(QUrl("qrc:/main.qml"));

        // After QML loads, find the MpvObject and create the bridge
        QObject::connect(engine, &QQmlApplicationEngine::objectCreated, [engine](QObject *obj) {
            if (!obj) return;
            auto *mpvObj = obj->findChild<MpvObject *>();
            if (!mpvObj) return;

            auto *bridge = new MpvBridge(mpvObj, obj);
            engine->rootContext()->setContextProperty("mpvBridgeObj", bridge);
        });
    });

    return app.exec();
}
