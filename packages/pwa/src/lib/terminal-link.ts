// How a terminal link (OSC 8 hyperlink or plain-text URL detected by the web-links
// addon) is opened differs by platform:
//
// - iOS standalone PWA: window.open(url, '_blank', …) is blocked as a popup, so we open a
//   blank window within the gesture and then navigate it. There is no separate PWA window
//   on the iPhone, so this lands in Safari.
// - macOS Safari web app (and desktop): window.open() opens a new *in-app* PWA window. A
//   synthetic external anchor click is instead treated as an out-of-scope link and handed
//   off to the system default browser.
// - Android, when the user turned on "share sheet" links: no installed PWA (Chrome WebAPK or
//   Firefox web app) hands a tapped link to another browser app, so a link picker such as
//   LinkSheet never sees it. The share sheet reaches it, at the cost of one extra tap.

export function isIOSWebKit(ua: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS Safari reports as "Macintosh"; the touch points distinguish it from a real Mac.
  return ua.includes('Macintosh') && maxTouchPoints > 1;
}

export function openTerminalLink(uri: string, opts: { ios: boolean; share?: boolean }): void {
  if (opts.share && navigator.share) {
    navigator.share({ url: uri }).catch(() => {
      // dismissed, or refused — the user can tap the link again
    });
    return;
  }

  if (opts.ios) {
    const win = window.open();
    if (win) {
      try {
        win.opener = null;
      } catch {
        // some engines forbid reassigning opener — best-effort, ignore
      }
      win.location.href = uri;
    }
    return;
  }

  const a = document.createElement('a');
  a.href = uri;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
