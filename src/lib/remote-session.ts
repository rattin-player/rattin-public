export const REMOTE_SESSION_EVENT = "rattin:remote-session-changed";

function expireCookie(name: string) {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

export function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(prefix.length));
}

export function getRemoteSessionId(): string | null {
  return readCookie("rc_session");
}

export function notifyRemoteSessionChanged(): void {
  window.dispatchEvent(new Event(REMOTE_SESSION_EVENT));
}

export function clearRemoteSession(): void {
  expireCookie("rc_session");
  expireCookie("rc_token");
  expireCookie("rc_auth");
  notifyRemoteSessionChanged();
}
