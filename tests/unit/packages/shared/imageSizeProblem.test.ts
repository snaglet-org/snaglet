import { describe, expect, it } from '@jest/globals';
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIZE_LABEL, imageSizeProblem } from '@snaglet/shared/utils';

const MB = 1024 * 1024;

describe('imageSizeProblem', () => {
  it('sets the image limit at 50 MB of 1024 × 1024 bytes', () => {
    expect(MAX_IMAGE_BYTES).toBe(50 * MB);
    expect(MAX_IMAGE_SIZE_LABEL).toBe('50 MB');
  });

  it.each([0, 1, 9 * MB, MAX_IMAGE_BYTES])('accepts an image of %d bytes', (size) => {
    expect(imageSizeProblem(size)).toBeNull();
  });

  it('names the size and the limit for an image over it', () => {
    expect(imageSizeProblem(72 * MB)).toBe('This image is 72 MB. Images can be up to 50 MB.');
  });

  it.each([1, 1000, 100_000, Math.floor(MB / 10)])(
    'shows an image %d bytes over the limit as larger than it',
    (over) => {
      expect(imageSizeProblem(MAX_IMAGE_BYTES + over)).toBe(
        'This image is 50.1 MB. Images can be up to 50 MB.'
      );
    }
  );

  it('names the file when given one', () => {
    expect(imageSizeProblem(64.5 * MB, 'photo.png')).toBe(
      '"photo.png" is 64.5 MB. Images can be up to 50 MB.'
    );
  });
});
