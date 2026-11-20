import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  externalLinkTarget,
  externalUrl,
  hasOpenLinkModifier,
  installExternalLinkOpener,
  openExternalUrl,
  openLinkHint,
} from './externalLinks';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

const APP_ORIGIN = 'http://127.0.0.1:4001';

function anchor(html: string): HTMLAnchorElement {
  document.body.innerHTML = html;
  const a = document.body.querySelector('a');
  if (!a) throw new Error('fixture has no anchor');
  return a;
}

describe('externalLinkTarget', () => {
  it('opens a target=_blank web link outside the app', () => {
    const a = anchor('<a href="https://example.org/docs" target="_blank" rel="noopener">x</a>');
    expect(externalLinkTarget(a, APP_ORIGIN)).toBe('https://example.org/docs');
  });

  it('opens an off-origin link even without target=_blank, and mailto links', () => {
    expect(externalLinkTarget(anchor('<a href="https://example.org/">x</a>'), APP_ORIGIN)).toBe(
      'https://example.org/'
    );
    expect(externalLinkTarget(anchor('<a href="mailto:user@example.com">x</a>'), APP_ORIGIN)).toBe(
      'mailto:user@example.com'
    );
  });

  it('leaves same-origin routes, fragments, downloads and other schemes to the page', () => {
    expect(externalLinkTarget(anchor('<a href="/dashboard">x</a>'), APP_ORIGIN)).toBeNull();
    expect(externalLinkTarget(anchor('<a href="#section">x</a>'), APP_ORIGIN)).toBeNull();
    expect(
      externalLinkTarget(anchor('<a href="https://example.org/f.zip" download>x</a>'), APP_ORIGIN)
    ).toBeNull();
    expect(
      externalLinkTarget(anchor('<a href="file:///etc/hosts" target="_blank">x</a>'), APP_ORIGIN)
    ).toBeNull();
  });

  it('keeps relative and same-origin links in the app even when they ask for a new window', () => {
    for (const href of [
      '/dashboard',
      './notes.md',
      'doc-1111111111111-aaaaaaaaa',
      `${APP_ORIGIN}/x`,
    ])
      expect(
        externalLinkTarget(anchor(`<a href="${href}" target="_blank">x</a>`), APP_ORIGIN)
      ).toBeNull();
  });

  it('leaves links inside editable content alone so the caret can land on them', () => {
    const a = anchor(
      '<div contenteditable="true"><p><a href="https://example.org/" target="_blank">x</a></p></div>'
    );
    expect(externalLinkTarget(a, APP_ORIGIN)).toBeNull();
  });

  it('opens links in a read-only island inside an editor, such as an included doc', () => {
    const a = anchor(
      '<div contenteditable="true"><span contenteditable="false"><a href="https://example.org/" target="_blank">x</a></span></div>'
    );
    expect(externalLinkTarget(a, APP_ORIGIN)).toBe('https://example.org/');
    const disabledEditor = anchor(
      '<div contenteditable="false"><p><a href="https://example.org/" target="_blank">x</a></p></div>'
    );
    expect(externalLinkTarget(disabledEditor, APP_ORIGIN)).toBe('https://example.org/');
  });
});

describe('externalUrl', () => {
  it('passes absolute http(s) and mailto links off the app origin', () => {
    expect(externalUrl('https://example.org/a?b=1#c', APP_ORIGIN)).toBe(
      'https://example.org/a?b=1#c'
    );
    expect(externalUrl('http://example.org', APP_ORIGIN)).toBe('http://example.org/');
    expect(externalUrl('mailto:user@example.com', APP_ORIGIN)).toBe('mailto:user@example.com');
  });

  it('refuses every other scheme, relative links and the app itself', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hello',
      'file:///etc/hosts',
      'vscode://file/tmp/example',
      'ftp://example.org/file',
      'tel:+15555550100',
      'blob:http://127.0.0.1:4001/1111-aaaa',
      'thread:abc',
      '/dashboard',
      './notes.md',
      '#section',
      '',
      `${APP_ORIGIN}/dashboard`,
    ])
      expect(externalUrl(href, APP_ORIGIN), href).toBeNull();
  });
});

describe('open-link modifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is ⌘ on macOS', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    expect(hasOpenLinkModifier({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(hasOpenLinkModifier({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(openLinkHint('https://example.org/')).toBe('⌘-click to open https://example.org/');
  });

  it('is Ctrl elsewhere', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)');
    expect(hasOpenLinkModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(hasOpenLinkModifier({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(openLinkHint('https://example.org/')).toBe('Ctrl-click to open https://example.org/');
  });
});

describe('openExternalUrl', () => {
  const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };

  afterEach(() => {
    delete tauriWindow.__TAURI_INTERNALS__;
    tauri.invoke.mockClear();
    vi.restoreAllMocks();
  });

  it('opens a new tab in a plain browser', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await openExternalUrl('https://example.org/');
    expect(open).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener');
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("hands the link to the shell's open_url in the desktop app", async () => {
    tauriWindow.__TAURI_INTERNALS__ = {};
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await openExternalUrl('mailto:user@example.com');
    expect(tauri.invoke).toHaveBeenCalledWith('open_url', { url: 'mailto:user@example.com' });
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses non-web schemes and relative links without opening anything', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    for (const url of ['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,x', '/x'])
      await expect(openExternalUrl(url), url).rejects.toThrow(/only opens web and mail links/);
    tauriWindow.__TAURI_INTERNALS__ = {};
    await expect(openExternalUrl('vscode://file/tmp/example')).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});

describe('installExternalLinkOpener', () => {
  const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
  let dispose = () => {};

  beforeEach(() => {
    tauriWindow.__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    dispose();
    delete tauriWindow.__TAURI_INTERNALS__;
    document.body.innerHTML = '';
  });

  it('hands an external anchor click to the shell and swallows the default navigation', () => {
    const openUrl = vi.fn(() => Promise.resolve());
    dispose = installExternalLinkOpener(openUrl);
    const a = anchor(
      '<a href="https://example.org/" target="_blank" rel="noopener"><span>go</span></a>'
    );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.querySelector('span')!.dispatchEvent(event);
    expect(openUrl).toHaveBeenCalledWith('https://example.org/');
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores in-app links and does nothing outside the Tauri shell', () => {
    const openUrl = vi.fn(() => Promise.resolve());
    dispose = installExternalLinkOpener(openUrl);
    const inApp = anchor('<a href="/docs/1">x</a>');
    const inAppEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    inApp.dispatchEvent(inAppEvent);
    expect(openUrl).not.toHaveBeenCalled();
    expect(inAppEvent.defaultPrevented).toBe(false);

    dispose();
    delete tauriWindow.__TAURI_INTERNALS__;
    dispose = installExternalLinkOpener(openUrl);
    const external = anchor('<a href="https://example.org/" target="_blank">x</a>');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    external.dispatchEvent(event);
    expect(openUrl).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
