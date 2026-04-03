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
#include <QIcon>
#include <QStandardPaths>
#include <QtWebEngineQuick>
#include <QWebEngineProfile>
#include <QWebEngineSettings>
#ifdef Q_OS_WIN
#include <windows.h>
#else
#include <signal.h>
#endif

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

#ifdef Q_OS_WIN
    // QWebEngine is forced into OpenGL mode (above) because mpv needs it,
    // but Chromium on Windows is optimised for ANGLE/DirectX.  These flags
    // reduce the performance gap by disabling the slow GL compositor and
    // letting Chromium rasterise on the GPU instead.
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS",
        "--enable-gpu-rasterization "
        "--enable-zero-copy "
        "--ignore-gpu-blocklist");
#endif

    // Must come after QTWEBENGINE_CHROMIUM_FLAGS is set (Windows, above).
    QtWebEngineQuick::initialize();

    QGuiApplication app(argc, argv);
    app.setApplicationName("Rattin");
    app.setOrganizationName("Rattin");
    app.setApplicationVersion("1.0.0");

    // Set window icon — on Linux, look next to the binary or in standard paths;
    // on Windows the .exe already embeds the icon via rattin.rc.
#ifndef Q_OS_WIN
    {
        QString binDir = QCoreApplication::applicationDirPath();
        QStringList iconPaths = {
            binDir + "/../share/icons/hicolor/scalable/apps/rattin.svg",
            binDir + "/../../packaging/linux/rattin.svg",
        };
        for (const auto &path : iconPaths) {
            if (QFile::exists(path)) {
                app.setWindowIcon(QIcon(path));
                break;
            }
        }
    }
#endif

    fprintf(stderr, "[shell] registering MpvObject type\n");
    // Register MpvObject QML type
    qmlRegisterType<MpvObject>("com.rattin.mpv", 1, 0, "MpvObject");

    // Fixed port so firewall rules & phone bookmarks survive restarts
    int port = 9630;
    fprintf(stderr, "[shell] using port %d\n", port);

    // Spawn Express server as child process
    auto *serverProcess = new QProcess(&app);
#ifdef Q_OS_WIN
    // Hide the console window for the Node.js child process
    serverProcess->setCreateProcessArgumentsModifier(
        [](QProcess::CreateProcessArguments *args) {
            args->flags |= CREATE_NO_WINDOW;
        });
#endif
    serverProcess->setProcessChannelMode(QProcess::ForwardedChannels);

    // Find the app directory (where server.ts and node_modules live).
    // When MAGNET_APP_DIR is set (AppImage mode), use that directly.
    // Otherwise, binary lives at <root>/shell/build/rattin-shell — go up 2 levels.
    QString binDir = QCoreApplication::applicationDirPath();
    QString appDir;
    if (qEnvironmentVariableIsSet("MAGNET_APP_DIR"))
        appDir = qEnvironmentVariable("MAGNET_APP_DIR");
    else
#ifdef Q_OS_WIN
        // Installed layout: binary sits in root, app code in app/ subdirectory
        appDir = QDir(binDir + "/app/").canonicalPath() + "/";
#else
        // Dev layout: binary at shell/build/rattin-shell — go up 2 levels
        appDir = QDir(binDir + "/../../").canonicalPath() + "/";
#endif
    serverProcess->setWorkingDirectory(appDir);

    // Config directory for .env file (writable — outside AppImage mount).
    // Falls back to appDir for non-AppImage installs.
    QString configDir;
    if (qEnvironmentVariableIsSet("MAGNET_CONFIG_DIR"))
        configDir = qEnvironmentVariable("MAGNET_CONFIG_DIR");
    else
#ifdef Q_OS_WIN
        // %APPDATA%/Rattin — matches lib/paths.ts configDir() on Windows
        configDir = qEnvironmentVariable("APPDATA", QDir::homePath() + "/AppData/Roaming") + "/Rattin";
#else
        configDir = appDir;
#endif

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("PORT", QString::number(port));
    env.insert("HOST", "0.0.0.0");
#ifdef Q_OS_WIN
    // Pass config dir to Node.js so lib/paths.ts uses the same location
    env.insert("MAGNET_CONFIG_DIR", configDir);
    // Add the directory containing rattin-runtime.exe to PATH
    QString nodePath = QDir(binDir).canonicalPath();
    env.insert("PATH", nodePath + ";" + env.value("PATH"));
#endif

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
    // MAGNET_NODE_PATH overrides the node binary (for bundled node in AppImage).
    QString nodeRunner;
    if (qEnvironmentVariableIsSet("MAGNET_NODE_PATH"))
        nodeRunner = qEnvironmentVariable("MAGNET_NODE_PATH");
    else
#ifdef Q_OS_WIN
        nodeRunner = "rattin-runtime";
#else
        nodeRunner = "node";
#endif

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
#ifdef Q_OS_WIN
        // On Windows, tsx.cmd is a batch script — run it directly, not via node
        QString localTsx = appDir + "/node_modules/.bin/tsx.cmd";
        if (!QFile::exists(localTsx)) localTsx = "tsx.cmd";
        runner = localTsx;
        args = {serverScript};
#else
        runner = nodeRunner;
        // Use local tsx from node_modules, invoked via node for reliable path resolution
        QString localTsx = appDir + "/node_modules/.bin/tsx";
        if (!QFile::exists(localTsx)) localTsx = "tsx";
        args = {localTsx, serverScript};
#endif
    }

    fprintf(stderr, "[shell] appDir: %s\n", appDir.toUtf8().constData());
    fprintf(stderr, "[shell] runner: %s\n", runner.toUtf8().constData());
    fprintf(stderr, "[shell] server: %s\n", serverScript.toUtf8().constData());
    fprintf(stderr, "[shell] port:   %d\n", port);

    // Give the server its own process group so we can kill the entire tree
    // (tsx spawns a child node process, and that spawns ffmpeg children).
#ifndef Q_OS_WIN
    serverProcess->setChildProcessModifier([]() { setsid(); });
#endif

    serverProcess->start(runner, args);

    // Clean up server on exit — kill the whole process group, not just
    // the direct child, so tsx's child (the actual server) and any
    // ffmpeg grandchildren are also terminated.
    QObject::connect(&app, &QGuiApplication::aboutToQuit, [serverProcess]() {
#ifndef Q_OS_WIN
        auto pid = serverProcess->processId();
        if (pid > 0) ::kill(-pid, SIGTERM);   // negative PID = process group
#else
        serverProcess->terminate();
#endif
        if (!serverProcess->waitForFinished(3000)) {
#ifndef Q_OS_WIN
            auto pid2 = serverProcess->processId();
            if (pid2 > 0) ::kill(-pid2, SIGKILL);
#else
            serverProcess->kill();
#endif
        }
    });

    // Load QML immediately so the user sees a window right away.
    // The WebView URL is set later once the server responds.
    auto *bridge = new MpvBridge(&app);

    auto *engine = new QQmlApplicationEngine(&app);
    engine->rootContext()->setContextProperty("serverPort", port);
    engine->rootContext()->setContextProperty("initialUrl",
        QString("http://127.0.0.1:%1?native=1").arg(port));
    engine->rootContext()->setContextProperty("serverReady", false);
    engine->rootContext()->setContextProperty("bridge", bridge);

    // Configure QWebEngine disk cache so images/assets persist across navigations.
    auto *profile = QWebEngineProfile::defaultProfile();
    QString cachePath = QStandardPaths::writableLocation(QStandardPaths::CacheLocation);
    profile->setCachePath(cachePath + "/webengine");
    profile->setHttpCacheMaximumSize(200 * 1024 * 1024);  // 200 MB
    profile->setHttpCacheType(QWebEngineProfile::DiskHttpCache);

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

    // Poll for server readiness. When ready, tell QML to show the WebView.
    waitForServer(port, &app, [engine]() {
        fprintf(stderr, "[shell] server ready\n");
        engine->rootContext()->setContextProperty("serverReady", true);
    });

    return app.exec();
}
