/** Returns true if the URL points to an external site (http/https). */
export function isExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/**
 * Open a URL in the system browser.
 * Calls the backend which uses xdg-open / open / start.
 */
export function openExternal(url: string): void {
  fetch("/api/open-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).catch(() => {
    // Fallback: try window.open (works outside Qt WebEngine)
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

/**
 * Intercepts clicks on <a target="_blank"> elements and routes them
 * through openExternal() so they work in Qt WebEngine.
 * Returns a cleanup function.
 */
export function setupExternalLinkInterceptor(): () => void {
  function handler(e: MouseEvent) {
    // Walk up from click target to find an anchor
    let el = e.target as HTMLElement | null;
    while (el && el.tagName !== "A") el = el.parentElement;
    if (!el) return;

    const anchor = el as HTMLAnchorElement;
    const href = anchor.getAttribute("href");

    if (!isExternalUrl(href)) return;

    // Left-click or middle-click on external links
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      openExternal(href!);
    }
  }

  document.addEventListener("click", handler, true);
  document.addEventListener("auxclick", handler, true);
  return () => {
    document.removeEventListener("click", handler, true);
    document.removeEventListener("auxclick", handler, true);
  };
}
