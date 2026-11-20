import type { FC } from 'react';
import { Modal } from '@desktop/components';
import { ZoomableImage, type ZoomableImageProps } from '@desktop/components/ImageViewer';
import { MERMAID_PREVIEW_IMAGE, preventPreviewDrag } from './mermaidDrag';
import styles from './MermaidPreviewModal.module.scss';

/**
 * How far fitting may grow a small diagram. The SVG stays sharp at any scale;
 * past 2× a small chart reads as blown up rather than enlarged.
 */
const MAX_FIT_SCALE = 2;

interface MermaidPreviewModalProps {
  /** The rendered diagram image (an SVG data URI). */
  src: string;
  /** Content laid over the diagram (its node chips), as in the inline viewer. */
  overlay?: ZoomableImageProps['overlay'];
  onClose: () => void;
}

/**
 * MermaidPreviewModal — a rendered Mermaid diagram shown large, framed like
 * the image preview modal: a fixed frame whose body hosts the pan/zoom
 * viewer, fitted on open. Esc, the backdrop and Close dismiss it. It only
 * displays the image; nothing here writes to a document.
 */
export const MermaidPreviewModal: FC<MermaidPreviewModalProps> = ({ src, overlay, onClose }) => (
  <Modal onClose={onClose} unstyled className={styles.overlay} aria-label="Mermaid diagram preview">
    <div className={styles.panel}>
      <header className={styles.header}>
        <h2 className={styles.title}>Diagram</h2>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close preview"
          title="Close (Esc)"
        >
          ×
        </button>
      </header>
      <div className={styles.body} onDragStartCapture={preventPreviewDrag}>
        <ZoomableImage
          src={src}
          alt="Mermaid diagram"
          className={styles.canvas}
          imageClassName={styles.image}
          fitPadding={24}
          maxFitScale={MAX_FIT_SCALE}
          imageDataAttributes={MERMAID_PREVIEW_IMAGE}
          overlay={overlay}
          autoFocus
        />
      </div>
    </div>
  </Modal>
);
