/**
 * Presentational component for rendering authenticated image content.
 * Handles loading/error states and uses useAuthenticatedImage hook for protected images.
 * Reusable across inline previews, image cards, and the pan/zoom ImageViewer.
 */

import type { ReactNode } from 'react';
import { useAuthenticatedImage } from '@desktop/hooks/useAuthenticatedImage';
import styles from './AuthenticatedImageContent.module.scss';

interface AuthenticatedImageContentProps {
  imageId: string;
  alt?: string;
  className?: string;
  /** Render the loaded blob URL yourself (e.g. in a viewer) instead of a plain <img>. */
  children?: (blobUrl: string) => ReactNode;
}

export function AuthenticatedImageContent({
  imageId,
  alt = '',
  className = '',
  children,
}: AuthenticatedImageContentProps) {
  const { blobUrl, loading, error } = useAuthenticatedImage(imageId);

  if (loading) {
    return (
      <div className={`${styles.loading} ${className}`} role="status">
        <div className={styles.spinner} aria-hidden="true" />
        <span className={styles.loadingText}>Loading image…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${styles.error} ${className}`} role="alert">
        <p className={styles.errorMessage}>
          {error.message === 'Image not found'
            ? 'This image could not be found.'
            : error.message === 'Unauthorized'
              ? 'You do not have permission to view this image.'
              : 'Failed to load image.'}
        </p>
      </div>
    );
  }

  if (!blobUrl) {
    return null;
  }

  if (children) return <>{children(blobUrl)}</>;

  return <img src={blobUrl} alt={alt} className={className} />;
}
