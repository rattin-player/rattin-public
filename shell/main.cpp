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
#include <QDir>
#include <QFile>
#include <QtWebEngineQuick>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebChannel>

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
        auto url = QUrl(QString("http://127.0.0.1:%1/").arg(port));
        auto *reply = mgr->get(QNetworkRequest(url));
        QObject::connect(reply, &QNetworkReply::finished, [=]() {
            reply->deleteLater();
            if (reply->error() == QNetworkReply::NoError) {
                timer->stop();
                timer->deleteLater();
                mgr->deleteLater();
                onReady();
            } else {
                fprintf(stderr, "[shell] poll failed: %s (HTTP %d)\n",
                    reply->errorString().toUtf8().constData(),
                    reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt());
            }
        });
    });
    timer->start();
}

int main(int argc, char *argv[])
{
    std::setlocale(LC_NUMERIC, "C");
    fprintf(stderr, "[shell] starting\n");

    // Force OpenGL — required for QQuickFramebufferObject + libmpv.
    // Verified working: known working pattern on Qt6.
    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);

    QtWebEngineQuick::initialize();

    QGuiApplication app(argc, argv);
    app.setApplicationName("Rattin");
    app.setOrganizationName("MagnetPlayer");
    app.setApplicationVersion("1.0.0");

    fprintf(stderr, "[shell] registering MpvObject type\n");
    // Register MpvObject QML type
    qmlRegisterType<MpvObject>("com.magnetplayer.mpv", 1, 0, "MpvObject");

    fprintf(stderr, "[shell] finding free port\n");
    // Determine server port
    int port = findFreePort();
    fprintf(stderr, "[shell] got port %d\n", port);

    // Spawn Express server as child process
    auto *serverProcess = new QProcess(&app);
    serverProcess->setProcessChannelMode(QProcess::ForwardedChannels);

    // Find the app directory (where server.ts and node_modules live).
    // Binary lives at <root>/shell/build/rattin-shell, so go up 2 levels.
    // Also handle symlinks by resolving the real path first.
    QString binDir = QCoreApplication::applicationDirPath();
    QString appDir = QDir(binDir + "/../../").canonicalPath() + "/";
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

    fprintf(stderr, "[shell] appDir: %s\n", appDir.toUtf8().constData());
    fprintf(stderr, "[shell] runner: %s\n", runner.toUtf8().constData());
    fprintf(stderr, "[shell] server: %s\n", serverScript.toUtf8().constData());
    fprintf(stderr, "[shell] port:   %d\n", port);

    serverProcess->start(runner, args);

    // Clean up server on exit
    QObject::connect(&app, &QGuiApplication::aboutToQuit, [serverProcess]() {
        serverProcess->terminate();
        if (!serverProcess->waitForFinished(3000)) {
            serverProcess->kill();
        }
    });

    // Wait for server, then launch QML UI.
    // IMPORTANT: waitForServer uses QTimer which needs the event loop.
    // We call it before app.exec() — the timer starts but only fires
    // once the event loop is running.
    waitForServer(port, &app, [&app, port]() {
        fprintf(stderr, "[shell] server ready, loading QML\n");

        // Inject qwebchannel.js into MainWorld via the default profile.
        // Must happen before any WebEngineView loads a page.
        {
            QFile f(":/qtwebchannel/qwebchannel.js");
            if (f.open(QIODevice::ReadOnly)) {
                QWebEngineScript script;
                script.setName("qwebchannel");
                script.setSourceCode(QString::fromUtf8(f.readAll()));
                script.setInjectionPoint(QWebEngineScript::DocumentCreation);
                script.setWorldId(QWebEngineScript::MainWorld);
                script.setRunsOnSubFrames(false);
                QWebEngineProfile::defaultProfile()->scripts()->insert(script);
                fprintf(stderr, "[shell] injected qwebchannel.js into MainWorld (%lld bytes)\n", f.size());
            } else {
                fprintf(stderr, "[shell] ERROR: could not open qrc:///qtwebchannel/qwebchannel.js\n");
            }
        }

        // Create bridge and register it on a QWebChannel from C++.
        // QML's registeredObjects requires WebChannel.id attached property
        // which can't be set on C++ context properties. So we create the
        // channel here and pass it to QML.
        auto *bridge = new MpvBridge(&app);
        auto *webChannel = new QWebChannel(&app);
        webChannel->registerObject("bridge", bridge);
        fprintf(stderr, "[shell] bridge registered on QWebChannel\n");

        auto *engine = new QQmlApplicationEngine(&app);
        engine->rootContext()->setContextProperty("serverPort", port);
        engine->rootContext()->setContextProperty("initialUrl",
            QString("http://localhost:%1?native=1").arg(port));
        engine->rootContext()->setContextProperty("bridge", bridge);
        engine->rootContext()->setContextProperty("cppWebChannel", webChannel);

        engine->load(QUrl("qrc:/main.qml"));

        // After QML loads, find the MpvObject and attach it to the bridge
        QObject::connect(engine, &QQmlApplicationEngine::objectCreated, [bridge](QObject *obj) {
            if (!obj) return;
            auto *mpvObj = obj->findChild<MpvObject *>();
            if (!mpvObj) {
                fprintf(stderr, "[shell] WARNING: MpvObject not found in QML\n");
                return;
            }
            bridge->attachMpv(mpvObj);
            fprintf(stderr, "[shell] bridge attached to mpv\n");
        });
    });

    // app.exec() starts the event loop — this is when waitForServer's
    // QTimer actually begins firing.
    return app.exec();
}
