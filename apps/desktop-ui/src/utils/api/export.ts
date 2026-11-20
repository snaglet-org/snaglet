import { getApiUrl } from './core';

/** Kinds the export endpoint accepts. Files remain outside node export. */
type ExportKind = 'doc' | 'thread' | 'image' | 'agent_memories' | 'container';
export type DownloadableExportKind = Exclude<ExportKind, 'container'>;

interface ContainerExportEntry {
  kind: string;
  id: string;
  name: string;
  path?: string;
  reason?: string;
  bytes?: number;
}

export interface ContainerExportReport {
  schemaVersion: 1;
  container: { id: string; name: string };
  exportedAt: string;
  exportedBy: string;
  snagletVersion: string;
  exported: ContainerExportEntry[];
  skipped: ContainerExportEntry[];
  failed: ContainerExportEntry[];
  summary: { containers: number; docs: number; skipped: number; failed: number };
}

export interface ExportRequest {
  kind: ExportKind;
  id: string;
  /**
   * Absolute path to an existing folder. Omitted in the browser, where the
   * server writes nothing and returns bytes instead.
   */
  destDir?: string;
  /** The name the user typed. Its extension is not authoritative. */
  fileName?: string;
  options?: {
    /** Threads only: newest N messages instead of all. */
    messageLimit?: number;
    /**
     * Signed proof from the native save dialog that this exact path was
     * chosen and the OS asked about replacing it. The only thing that can
     * authorize an overwrite — there is no boolean, because a boolean is
     * something any caller can set and therefore proves nothing.
     */
    overwriteGrant?: string;
  };
}

/** What the server reports after writing a file. */
interface ExportWriteResult {
  kind: ExportKind;
  id: string;
  /** May differ from what was asked for — a collision appends " (2)". */
  fileName: string;
  bytes: number;
  path: string;
  overwritten: boolean;
  downloaded: false;
  manifestPath?: string;
  report?: ContainerExportReport;
}

export const exportApi = {
  /**
   * Ask the server to write the export into `destDir`.
   *
   * Uses the JSON envelope like every other mutating call. The response is the
   * path that was actually written, which is not necessarily the path implied
   * by `fileName`.
   */
  async write(body: ExportRequest & { destDir: string }): Promise<ExportWriteResult> {
    const res = await fetch(getApiUrl('/export'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as {
      data?: ExportWriteResult;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      throw new Error(payload?.error?.message || `Export failed (${res.status})`);
    }
    if (!payload?.data) throw new Error('Export succeeded but the server returned no result.');
    return payload.data;
  },

  /**
   * Ask the server for the bytes, for a browser download.
   *
   * A separate method rather than a flag because the response is a file body,
   * not a JSON envelope. Omitting `destDir` tells the server not to touch the
   * filesystem.
   */
  async download(
    body: Omit<ExportRequest, 'destDir' | 'kind'> & { kind: DownloadableExportKind }
  ): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(getApiUrl('/export'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // The error path still speaks JSON.
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(payload?.error?.message || `Export failed (${res.status})`);
    }
    return {
      blob: await res.blob(),
      fileName: fileNameFromDisposition(res.headers.get('Content-Disposition')),
    };
  },
};

/**
 * Read the filename back out of `Content-Disposition`.
 *
 * Prefers the RFC 5987 `filename*` form, which carries the real (possibly
 * non-ASCII) name. Falls back to the quoted ASCII `filename` when
 * `filename*` is absent, which can garble a non-ASCII title.
 */
function fileNameFromDisposition(header: string | null): string {
  if (!header) return 'export';
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain?.[1] || 'export';
}
