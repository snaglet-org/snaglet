# create_image

## Overview

Store image bytes you already hold — typically a screen capture returned to you as an image
block — as a normal image node in a workspace container. The data is passed inline; there is no
file-path mode, so the tool never reads the host filesystem.

The image contents are sent to and stored by Snaglet. Only pass captures that were intentionally taken
for the workspace, never incidental screens that may show unrelated private content.

## Parameters

### Required

- **title** (string, 1–120 chars): Display name of the image node.
- **mime_type** (string): `image/png`, `image/jpeg` or `image/webp`. Must match the data's real
  file signature.
- **data_base64** (string): Raw standard Base64 of the image file. No `data:` URL prefix;
  whitespace is ignored.
- Exactly one destination:
  - **parent_id** (string): Container id (`container-<timestamp>-<random>`), not a display name.
  - **parent_path** (string): Slash path such as `/Snaglet/screens` (case-insensitive).

### Optional

- **caption** (string): Stored as the image description.
- **sort_order** (integer ≥ 0): Position among the container's images; later siblings shift
  down. Defaults to the end.

## Validation and limits

- The Base64 must be well-formed; the decoded bytes must carry the PNG, JPEG or WebP signature
  that `mime_type` names. A mismatch is an error, not a correction.
- SVG, GIF and every other format are rejected. Animated images are rejected.
- At most 5 MB decoded, 16384 px per side and 40 megapixels.
- The image is re-encoded in its own format before storage, which strips all metadata (EXIF/GPS,
  XMP, ICC profiles, text chunks) and applies any EXIF rotation to the pixels. JPEG is re-encoded
  at quality 90; PNG and lossless WebP stay lossless.
- The destination must be an existing, non-archived container. The workspace root is not
  accepted, and there is no fallback to the calling thread's container.

Nothing is written unless every check passes, and the node row and stored file are created
together: a failure leaves neither behind.

## Return Value

JSON with `success`, `image_id`, `link` (ready-to-paste `[Title](image-…)`), `width`, `height`
(after rotation), `mime_type`, `sha256` (hex digest of the stored, sanitized bytes),
`size_bytes` and `container_id`.

## Example

```typescript
await create_image({
  title: 'Settings panel — empty state',
  parent_path: '/Snaglet/screens',
  mime_type: 'image/png',
  data_base64: 'iVBORw0KGgo…',
  caption: 'Captured while reviewing the empty-state copy.',
});
```
