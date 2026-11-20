import { Fragment, type ReactNode } from 'react';

/**
 * A memory key ("user.learning.history.module5") with a line-break
 * opportunity after every dot, so a long key wraps between its segments
 * instead of at hyphens only. The text (and a copy of it) is unchanged; the
 * key's CSS still breaks inside a segment too long for the line.
 */
export function memoryKeyWithBreaks(key: string): ReactNode {
  const parts = key.split('.');
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          .<wbr />
        </>
      )}
    </Fragment>
  ));
}
