import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import styles from './lineHighlight.module.scss';

/**
 * Meta: `{from, to}` highlights that range; `null` clears it. With `flash`,
 * the block holding `from` flashes briefly instead (an outline jump).
 */
export const lineHighlightKey = new PluginKey<DecorationSet>('snaglet-line-link-highlight');

/** How long a flash shows; matches the animation in lineHighlight.module.scss. */
export const LINE_FLASH_MS = 1400;

interface HighlightMeta {
  from: number;
  to: number;
  flash?: boolean;
}

interface FlashSpec {
  flash: number;
}

let flashCount = 0;

function flashId(set: DecorationSet | undefined): number | null {
  const found = set?.find(undefined, undefined, (spec) => typeof spec.flash === 'number');
  return found?.length ? (found[0]!.spec as FlashSpec).flash : null;
}

/**
 * Highlights the part of a doc a line link points at. The highlight follows
 * edits (mapped through each transaction) and clears on the next click in
 * the editor; a flash also clears itself once its animation is over.
 */
export function createLineHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: lineHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(lineHighlightKey) as HighlightMeta | null | undefined;
        if (meta === null) return DecorationSet.empty;
        if (meta) {
          const size = tr.doc.content.size;
          const from = Math.max(0, Math.min(meta.from, size));
          const to = Math.max(from, Math.min(meta.to, size));
          if (meta.flash) {
            const $from = tr.doc.resolve(from);
            if ($from.depth === 0) return DecorationSet.empty;
            const spec: FlashSpec = { flash: ++flashCount };
            return DecorationSet.create(tr.doc, [
              Decoration.node(
                $from.before($from.depth),
                $from.after($from.depth),
                { class: styles.flash ?? '', 'data-line-flash': '' },
                spec
              ),
            ]);
          }
          return DecorationSet.create(tr.doc, [
            Decoration.inline(from, to, { class: 'snaglet-line-highlight' }),
          ]);
        }
        return set.map(tr.mapping, tr.doc);
      },
    },
    view: () => {
      let timer: number | null = null;
      let scheduled: number | null = null;
      const stop = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        scheduled = null;
      };
      return {
        update(view) {
          const id = flashId(lineHighlightKey.getState(view.state));
          if (id === scheduled) return;
          stop();
          if (id === null) return;
          scheduled = id;
          timer = window.setTimeout(() => {
            timer = null;
            scheduled = null;
            if (flashId(lineHighlightKey.getState(view.state)) !== id) return;
            view.dispatch(
              view.state.tr.setMeta(lineHighlightKey, null).setMeta('addToHistory', false)
            );
          }, LINE_FLASH_MS);
        },
        destroy: stop,
      };
    },
    props: {
      decorations: (state) => lineHighlightKey.getState(state),
      handleDOMEvents: {
        mousedown: (view) => {
          const set = lineHighlightKey.getState(view.state);
          if (set && set !== DecorationSet.empty && set.find().length > 0) {
            view.dispatch(
              view.state.tr.setMeta(lineHighlightKey, null).setMeta('addToHistory', false)
            );
          }
          return false;
        },
      },
    },
  });
}
