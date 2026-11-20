import { type FC } from 'react';
import type { FileContent } from '@desktop/utils/api';
import { AudioPlayer } from './AudioPlayer';
import { FileMarkdownPreview } from './FileMarkdownPreview';
import { PdfViewer } from './PdfViewer';
import type { RawFileSource } from './rawFileSource';
import styles from './FilePreview.module.scss';

/** Extensions rendered through the markdown renderer rather than as raw code. */
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
/** Extensions played by the audio player; the raw routes label each one. */
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg']);

function unpreviewableMessage(data: FileContent): string {
  switch (data.reason) {
    case 'binary':
      return 'This file is not text and cannot be previewed.';
    case 'too_large':
      return 'This file is too large to preview.';
    case 'missing':
      return 'This file could not be found on disk.';
    default:
      return 'This file cannot be previewed.';
  }
}

/**
 * Pure render of a loaded {@link FileContent}: a visual PDF viewer for `.pdf`,
 * an audio player for `.mp3`/`.wav`/`.m4a`/`.ogg`, markdown for .md/.mdx,
 * monospace for everything else, and a friendly notice when the file can't be
 * previewed. Loading / fetch-error states are owned by the caller (pane or
 * modal).
 *
 * `rawSource` is how the PDF viewer and audio player fetch raw bytes (a node id
 * or an absolute path). Both are handled before the previewable/binary check on
 * purpose: the text route reports every PDF and audio file as not-previewable
 * (binary or too_large), so that branch would otherwise swallow them.
 */
export const FileContentBody: FC<{
  data: FileContent;
  fileName: string;
  rawSource?: RawFileSource;
}> = ({ data, fileName, rawSource }) => {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf' && rawSource) {
    return <PdfViewer source={rawSource} />;
  }
  if (AUDIO_EXT.has(ext) && rawSource) {
    return <AudioPlayer source={rawSource} fileName={fileName.split('/').pop() ?? fileName} />;
  }
  if (!data.previewable || data.content == null) {
    return <div className={styles.notice}>{unpreviewableMessage(data)}</div>;
  }
  if (MARKDOWN_EXT.has(ext)) {
    return (
      <FileMarkdownPreview
        key={data.id}
        data={data}
        source={rawSource?.kind === 'path' ? rawSource.path : data.id}
      />
    );
  }
  return <pre className={styles.code}>{data.content}</pre>;
};
