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

static void messageHandler(QtMsgType, const QMessageLogContext &, const QString &msg)
{
    fprintf(stderr, "qml: %s\n", msg.toUtf8().constData());
}

int main(int argc, char *argv[])
{
    qInstallMessageHandler(messageHandler);
    std::setlocale(LC_NUMERIC, "C");
    fprintf(stderr, "[shell] starting\n");

    // Force OpenGL — required for QQuickFramebufferObject + libmpv.
    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);

    QtWebEngineQuick::initialize();

    QGuiApplication app(argc, argv);
    app.setApplicationName("Rattin");
    app.setOrganizationName("Rattin");
    app.setApplicationVersion("1.0.0");

    fprintf(stderr, "[shell] registering MpvObject type\n");
    // Register MpvObject QML type
    qmlRegisterType<MpvObject>("com.rattin.mpv", 1, 0, "MpvObject");

    // Fixed port so firewall rules & phone bookmarks survive restarts
    int port = 9630;
    fprintf(stderr, "[shell] using port %d\n", port);

    // Spawn Express server as child process
    auto *serverProcess = new QProcess(&app);
    serverProcess->setProcessChannelMode(QProcess::ForwardedChannels);

    // Find the app directory (where server.ts and node_modules live).
    // When RATTIN_APP_DIR is set (AppImage mode), use that directly.
    // Otherwise, binary lives at <root>/shell/build/rattin-shell — go up 2 levels.
    QString binDir = QCoreApplication::applicationDirPath();
    QString appDir;
    if (qEnvironmentVariableIsSet("RATTIN_APP_DIR"))
        appDir = qEnvironmentVariable("RATTIN_APP_DIR");
    else
        appDir = QDir(binDir + "/../../").canonicalPath() + "/";
    serverProcess->setWorkingDirectory(appDir);

    // Config directory for .env file (writable — outside AppImage mount).
    // Falls back to appDir for non-AppImage installs.
    QString configDir;
    if (qEnvironmentVariableIsSet("RATTIN_CONFIG_DIR"))
        configDir = qEnvironmentVariable("RATTIN_CONFIG_DIR");
    else
        configDir = appDir;

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("PORT", QString::number(port));
    env.insert("HOST", "0.0.0.0");

    // Load .env file and inject vars into process environment directly.
    // Node's --env-file flag doesn't propagate through tsx's child fork,
    // so we parse it ourselves and set them on the QProcess environment.
    QString envFilePath = configDir + "/.env";
    if (QFile::exists(envFilePath)) {
        QFile envFile(envFilePath);
        if (envFile.open(QIODevice::ReadOnly | QIODevice::Text)) {
            QTextStream in(&envFile);
            while (!in.atEnd()) {
                QString line = in.readLine().trimmed();
                if (line.isEmpty() || line.startsWith('#')) continue;
                int eq = line.indexOf('=');
                if (eq <= 0) continue;
                QString key = line.left(eq).trimmed();
                QString val = line.mid(eq + 1).trimmed();
                // Strip surrounding quotes if present
                if ((val.startsWith('"') && val.endsWith('"')) ||
                    (val.startsWith('\'') && val.endsWith('\'')))
                    val = val.mid(1, val.length() - 2);
                if (!key.isEmpty())
                    env.insert(key, val);
            }
            envFile.close();
            fprintf(stderr, "[shell] Loaded env from %s\n", envFilePath.toUtf8().constData());
        }
    }

    serverProcess->setProcessEnvironment(env);

    // Determine how to start the server:
    // 1. If server.js exists (pre-compiled), use node
    // 2. Otherwise use node + tsx loader for server.ts
    //
    // RATTIN_NODE_PATH overrides the node binary (for bundled node in AppImage).
    QString nodeRunner;
    if (qEnvironmentVariableIsSet("RATTIN_NODE_PATH"))
        nodeRunner = qEnvironmentVariable("RATTIN_NODE_PATH");
    else
        nodeRunner = "node";

    QString serverScript;
    QString runner;
    QStringList args;

    // Env vars are injected via setProcessEnvironment above (parsed from .env).
    // No need for --env-file flag (it doesn't propagate through tsx's child fork).
    if (QFile::exists(appDir + "/server.js")) {
        serverScript = "server.js";
        runner = nodeRunner;
        args = {serverScript};
    } else {
        serverScript = "server.ts";
        runner = nodeRunner;
        // Use local tsx from node_modules, invoked via node for reliable path resolution
        QString localTsx = appDir + "/node_modules/.bin/tsx";
        if (!QFile::exists(localTsx)) {
            // Fall back to global tsx (might work if user installed it)
            localTsx = "tsx";
        }
        args = {localTsx, serverScript};
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

        auto *bridge = new MpvBridge(&app);

        auto *engine = new QQmlApplicationEngine(&app);
        engine->rootContext()->setContextProperty("serverPort", port);
        engine->rootContext()->setContextProperty("initialUrl",
            QString("http://127.0.0.1:%1?native=1").arg(port));
        engine->rootContext()->setContextProperty("bridge", bridge);

        // Connect BEFORE load — load() is synchronous for qrc: URLs,
        // so objectCreated fires during load() and would be missed otherwise.
        QObject::connect(engine, &QQmlApplicationEngine::objectCreated, [bridge](QObject *obj) {
            if (!obj) return;
            auto *mpvObj = obj->findChild<MpvObject *>();
            if (mpvObj) {
                bridge->attachMpv(mpvObj);
                fprintf(stderr, "[shell] bridge attached to mpv\n");
            } else {
                fprintf(stderr, "[shell] WARNING: MpvObject not found in QML\n");
            }
        });

        engine->load(QUrl("qrc:/main.qml"));
    });

    // app.exec() starts the event loop — this is when waitForServer's
    // QTimer actually begins firing.
    return app.exec();
}
