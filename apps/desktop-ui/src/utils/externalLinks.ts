/**
 * externalLinks — open web and mail links in the system browser from the
 * desktop shell.
 *
 * WebKit skips the shell's `on_new_window` hook for anchors with
 * `rel="noopener"` / `rel="noreferrer"` and drops the click, so external
 * anchor clicks go to the shell's `open_url` command instead (which only opens
 * `http(s):` and `mailto:`; see apps/desktop/src-tauri/src/links.rs). Relative
 * and same-origin links stay in Snaglet. Links in editable text are left alone so
 * a click places the caret (the editor opens them on ⌘-click); read-only
 * islands inside an editor open on a plain click.
 */
import { isMacPlatform } from './platform';
import { isTauriEnv } from './tauriEnv';

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * `href` as a URL Snaglet may open outside the app (an `http(s):` or `mailto:`
 * link off the app's origin), or null for anything else.
 */
export function externalUrl(href: string, appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, appOrigin);
  } catch {
    return null;
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return null;
  return url.origin === appOrigin ? null : url.toString();
}

/** True when `el` sits in text the user can edit, not in a read-only island. */
export function inEditableText(el: Element): boolean {
  const host = el.closest('[contenteditable]');
  return host !== null && host.getAttribute('contenteditable') !== 'false';
}

/** The URL an anchor click should open outside the app, or null to leave it to the page. */
export function externalLinkTarget(anchor: HTMLAnchorElement, appOrigin: string): string | null {
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#') || anchor.hasAttribute('download')) return null;
  if (inEditableText(anchor)) return null;
  return externalUrl(href, appOrigin);
}

/** Whether a click holds the open-link modifier: ⌘ on macOS, Ctrl elsewhere. */
export function hasOpenLinkModifier(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

/** Hover hint for a link in editable text, e.g. "⌘-click to open https://example.org/". */
export function openLinkHint(url: string): string {
  return `${isMacPlatform() ? '⌘' : 'Ctrl'}-click to open ${url}`;
}

/**
 * Open a web or mail link outside the app: the system browser (or mail
 * client) through the shell's `open_url` in the desktop app, a new tab in a
 * plain browser. Rejects any other scheme.
 */
export async function openExternalUrl(url: string): Promise<void> {
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    // relative or malformed: refused below
  }
  if (!EXTERNAL_SCHEMES.has(protocol)) {
    throw new Error(
      `Snaglet only opens web and mail links outside the app, not ${protocol || 'relative'} links`
    );
  }
  if (isTauriEnv()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('open_url', { url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** Open `url` outside the app without awaiting it, logging a failure. */
export function launchExternalUrl(
  url: string,
  openUrl: (url: string) => Promise<void> = openExternalUrl
): void {
  void openUrl(url).catch((err: unknown) => {
    console.error('[externalLinks] could not open link in the system browser', err);
  });
}

/**
 * Install the document-level interceptor. Returns a disposer. A no-op outside
 * the Tauri shell, where the browser handles `target="_blank"` itself.
 */
export function installExternalLinkOpener(
  openUrl: (url: string) => Promise<void> = openExternalUrl,
  doc: Document = document
): () => void {
  if (!isTauriEnv()) return () => {};
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = externalLinkTarget(anchor, doc.location.origin);
    if (!url) return;
    event.preventDefault();
    launchExternalUrl(url, openUrl);
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}
