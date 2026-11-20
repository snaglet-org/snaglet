import { useEffect, useState, type FC } from 'react';
import type { ImageTreeNode } from '@desktop/utils/api';
import { imagesApi } from '@desktop/utils/api/images';
import { ImageViewer } from '@desktop/components/ImageViewer';
import { Modal } from '@desktop/components';
import { formatBytes } from '@snaglet/shared/utils';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { PropertiesPanel } from '../shared/PropertiesPanel';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import { Chip } from '@desktop/components/Chip';
import { ExportButton } from '@desktop/components/ExportButton';
import styles from './ImageView.module.scss';
import propertyStyles from '../shared/NodeProperties.module.scss';

interface ImageViewProps {
  node: ImageTreeNode;
}

const ImageView: FC<ImageViewProps> = ({ node }) => {
  // Authenticated image loading is handled by AuthenticatedImageContent component
  const [previewOpen, setPreviewOpen] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(node.description ?? '');
  const [newTag, setNewTag] = useState('');
  const [metadata, setMetadata] = useState(() => ({
    description: node.description ?? null,
    tags: node.tags ?? [],
  }));
  const displayName = node.name || 'Untitled image';

  // Export copies the stored bytes. The extension is imposed server-side from
  // the stored MIME type, so the suggested name carries only the stem — a
  // ".png" guessed here would be overridden anyway, and wrongly for a JPEG.
  // (Rendered in the topbar by PropertiesPanel, beside the Properties toggle.)
  // Defensive defaults: persisted pane state (localStorage) may carry an
  // older ImageTreeNode shape that predates `description` / `tags`, so a
  // refresh after a schema bump renders the cached selection before the
  // tree refetch lands. Read through the nullish-coalescers so the view
  // doesn't crash on the stale snapshot.
  useEffect(() => {
    setMetadata({ description: node.description ?? null, tags: node.tags ?? [] });
    setDescriptionDraft(node.description ?? '');
  }, [node.id, node.description, node.tags]);

  useEffect(
    () =>
      onLibraryEvent((event) => {
        if (event.type === 'image-metadata-saved' && event.id === node.id) {
          setMetadata((current) => ({
            description: event.description !== undefined ? event.description : current.description,
            tags: event.tags ?? current.tags,
          }));
          if (event.description !== undefined) setDescriptionDraft(event.description ?? '');
        }
      }),
    [node.id]
  );

  const { tags } = metadata;
  const saveDescription = async () => {
    const result = await imagesApi.updateMetadata(node.id, {
      description: descriptionDraft.trim() || null,
    });
    setMetadata((current) => ({ ...current, description: result.description ?? null }));
  };
  const saveTags = async (nextTags: string[]) => {
    const result = await imagesApi.updateMetadata(node.id, { tags: nextTags });
    setMetadata((current) => ({ ...current, tags: result.tags ?? nextTags }));
  };
  const topbarMeta = (
    <span className={styles.headerMeta}>
      <button
        type="button"
        className={styles.previewButton}
        onClick={() => setPreviewOpen(true)}
        title="Open fullscreen preview"
        aria-label={`Preview ${node.mimeType}`}
      >
        {node.mimeType}
      </button>
      <span className={styles.propertiesSize}>{formatBytes(node.sizeBytes)}</span>
      <ExportButton variant="topbar" kind="image" id={node.id} suggestedName={displayName} />
    </span>
  );
  const propertiesPanel = (
    <div className={styles.meta}>
      <div className={styles.descriptionField}>
        <label className={propertyStyles.fieldLabel} htmlFor="image-description">
          Description
        </label>
        <ChipEditableInput
          value={descriptionDraft}
          onChange={setDescriptionDraft}
          onSubmit={() => void saveDescription()}
          placeholder="Add a description…"
          ariaLabel="Image description"
          className={styles.descriptionEditor}
        />
      </div>
      {tags.length > 0 ? (
        <div className={styles.tagList} aria-label="Tags">
          {tags.map((tag) => (
            <Chip
              key={tag}
              size="xs"
              tone="primary"
              onRemove={() => void saveTags(tags.filter((item) => item !== tag))}
            >
              {tag}
            </Chip>
          ))}
        </div>
      ) : (
        <p className={styles.empty}>No tags</p>
      )}
      <form
        className={styles.addTag}
        onSubmit={(event) => {
          event.preventDefault();
          const value = newTag.trim();
          if (value && !tags.includes(value)) void saveTags([...tags, value]);
          setNewTag('');
        }}
      >
        <input
          value={newTag}
          onChange={(event) => setNewTag(event.target.value)}
          placeholder="Add tag…"
          aria-label="Add image tag"
        />
      </form>
    </div>
  );
  return (
    <PropertiesPanel
      ariaLabel="Image properties"
      topbarActions={topbarMeta}
      panel={propertiesPanel}
    >
      <div className={styles.imageView}>
        <div className={styles.canvas}>
          <ImageViewer
            imageId={node.id}
            alt={displayName}
            imageClassName={styles.image}
            fitPadding={24}
          />
        </div>
        {previewOpen && (
          <Modal
            onClose={() => setPreviewOpen(false)}
            unstyled
            className={styles.previewOverlay}
            aria-label={`${displayName} preview`}
          >
            {/* A zoomed image covers the dim area, so the backdrop click alone
              would leave mouse users stuck until they zoom back out. */}
            <button
              type="button"
              className={styles.previewClose}
              onClick={() => setPreviewOpen(false)}
              aria-label="Close preview"
              title="Close (Esc)"
            >
              ×
            </button>
            <ImageViewer
              imageId={node.id}
              alt={displayName}
              imageClassName={styles.previewImage}
              fitPadding={24}
              onBackdropClick={() => setPreviewOpen(false)}
              autoFocus
            />
          </Modal>
        )}
      </div>
    </PropertiesPanel>
  );
};

export { ImageView };
