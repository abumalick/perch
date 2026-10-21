import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIOSWebKit, openTerminalLink } from './terminal-link';

describe('isIOSWebKit', () => {
  it('detects the iPhone', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
    expect(isIOSWebKit(ua, 5)).toBe(true);
  });

  it('detects an iPad reporting as desktop Safari (Macintosh + touch)', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    expect(isIOSWebKit(ua, 5)).toBe(true);
  });

  it('treats a real Mac (Macintosh, no touch) as not iOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    expect(isIOSWebKit(ua, 0)).toBe(false);
  });
});

describe('openTerminalLink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('on iOS opens a blank window then navigates it (the popup-safe path)', () => {
    const win = { opener: {} as unknown, location: { href: '' } };
    const open = vi.fn(() => win);
    vi.stubGlobal('open', open);

    openTerminalLink('https://example.com', { ios: true });

    expect(open).toHaveBeenCalledWith();
    expect(win.location.href).toBe('https://example.com');
    expect(win.opener).toBeNull();
  });

  it('on desktop clicks a noopener external anchor (hands off to the default browser)', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.href).toBe('https://example.com/');
        expect(this.target).toBe('_blank');
        expect(this.rel).toBe('noopener noreferrer');
        expect(this.isConnected).toBe(true);
      });

    openTerminalLink('https://example.com/', { ios: false });

    expect(click).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('a[href="https://example.com/"]')).toBeNull();
  });

  it('with share on, hands the link to the share sheet instead of opening it', () => {
    const share = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, share });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    openTerminalLink('https://example.com/', { ios: false, share: true });

    expect(share).toHaveBeenCalledWith({ url: 'https://example.com/' });
    expect(click).not.toHaveBeenCalled();
  });

  it('with share on, swallows a dismissed share sheet', async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('dismissed', 'AbortError')));
    vi.stubGlobal('navigator', { ...navigator, share });

    openTerminalLink('https://example.com/', { ios: false, share: true });

    await expect(share.mock.results[0]!.value).rejects.toThrow();
  });

  it('with share on but no Web Share, opens the link as before', () => {
    vi.stubGlobal('navigator', { ...navigator, share: undefined });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    openTerminalLink('https://example.com/', { ios: false, share: true });

    expect(click).toHaveBeenCalledOnce();
  });
});
