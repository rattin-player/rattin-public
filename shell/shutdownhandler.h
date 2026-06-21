#pragma once

#include <QObject>
#include <QProcess>
#include <csignal>

#ifdef Q_OS_WIN
#include <windows.h>
#endif

// Exposed to QML so it can kill the process directly on window close.
// No Qt signals, no event loop — just TerminateProcess / _exit.
class ShutdownHandler : public QObject {
    Q_OBJECT
public:
    explicit ShutdownHandler(QProcess *server, QObject *parent = nullptr)
        : QObject(parent), m_server(server) {}

    Q_INVOKABLE void shutdown() {
#ifdef Q_OS_WIN
        if (m_server) {
            QString pidStr = QString::number(m_server->processId());
            QProcess::startDetached("taskkill", {"/T", "/F", "/PID", pidStr});
        }
        TerminateProcess(GetCurrentProcess(), 0);
#else
        if (m_server) {
            auto pid = m_server->processId();
            if (pid > 0) ::kill(-pid, SIGKILL);
        }
        _exit(0);
#endif
    }

private:
    QProcess *m_server;
};
