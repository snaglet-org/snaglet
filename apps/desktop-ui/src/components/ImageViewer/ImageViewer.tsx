import { type FC } from 'react';
import { AuthenticatedImageContent } from '@desktop/components/AuthenticatedImageContent';
import { cn } from '@desktop/utils/classNames';
import { ZoomableImage, type ZoomableImageProps } from './ZoomableImage';
import styles from './ImageViewer.module.scss';

export interface ImageViewerProps extends Omit<ZoomableImageProps, 'src'> {
  /** Stored image id; loaded through the authenticated fetch → blob path. */
  imageId: string;
}

/**
 * ImageViewer — the one surface for showing a stored image large: the image
 * pane and every image preview modal. Loads the bytes like
 * AuthenticatedImageContent (same loading / error states, filling the box),
 * then hands them to ZoomableImage for pan and zoom.
 */
export const ImageViewer: FC<ImageViewerProps> = ({ imageId, alt, className, ...rest }) => (
  <AuthenticatedImageContent imageId={imageId} alt={alt} className={cn(styles.status, className)}>
    {(src) => <ZoomableImage src={src} alt={alt} className={className} {...rest} />}
  </AuthenticatedImageContent>
);
