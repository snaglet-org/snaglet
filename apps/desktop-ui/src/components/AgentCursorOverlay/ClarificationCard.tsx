import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type RefObject,
} from 'react';
import type { ClarificationQuestion, ClarificationRequestPayload } from '@snaglet/shared/types';
import {
  OTHER,
  useClarificationForm,
  type ClarificationRespond,
} from '@desktop/pages/Dashboard/views/ChatView/useClarificationForm';
import { shortcutHint } from '@desktop/utils/platform';
import './ClarificationCard.css';

const EDGE = 8;
/** Gap between the flower's click point and the card. */
const GAP = 18;

/**
 * Key-handling rule (documented once, here): the card reacts to the keyboard only
 * while nothing else owns it, i.e. `document.activeElement` is the body (nothing
 * focused) or something inside the card. If the user is typing in the chat
 * composer or any other field, every key goes there untouched. Cmd/Ctrl+. pulls
 * the keyboard to the card from anywhere (that combo is unused elsewhere in the
 * app). Handlers live on this window only and exist only while the card is
 * mounted; nothing is registered globally outside the Snaglet window.
 */
function cardOwnsKeyboard(card: HTMLElement | null): boolean {
  if (!card) return false;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return true;
  return card.contains(el);
}

const isPrintable = (e: KeyboardEvent): boolean =>
  e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;

function optionList(q: ClarificationQuestion): string[] {
  if (q.type === 'text') return [];
  return [...(q.options ?? []), ...(q.allowOther ? [OTHER] : [])];
}

/** Place the card beside the flower, flipping/sliding so it stays inside the viewport. */
function usePlacement(
  ref: RefObject<HTMLElement | null>,
  anchor: { x: number; y: number },
  dep: unknown,
  inline: boolean
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ left: anchor.x + GAP, top: anchor.y - 70 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || inline) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Right of the click point; flip to the left of the flower when it would not fit.
    let left = anchor.x + GAP;
    if (left + w > vw - EDGE) left = anchor.x - 78 - w;
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    // Aligned with the flower's top; slide up/down to stay on screen.
    const top = Math.max(EDGE, Math.min(anchor.y - 70, vh - h - EDGE));
    setStyle((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [ref, anchor.x, anchor.y, dep, inline]);
  return style;
}

interface Props {
  request: ClarificationRequestPayload;
  respond: ClarificationRespond;
  /** Viewport position of the agent's click point (the flower sits up-left of it). */
  anchor: { x: number; y: number };
  agentName: string;
  /**
   * Flow in its parent instead of floating at `anchor`: how the agent-popup stack
   * shows it. Such a card never grabs the keyboard on its own (a background popup
   * must not eat typing); Cmd/Ctrl+. still pulls it in.
   */
  inline?: boolean;
}

/**
 * The agent's Ask question, shown next to its flower so it can be answered from
 * the keyboard without moving the mouse. The mouse works on the card only.
 */
export const ClarificationCard: FC<Props> = ({
  request,
  respond,
  anchor,
  agentName,
  inline = false,
}) => {
  const form = useClarificationForm(request, respond);
  const { q, s, step, setStep, isLast, canAdvance, allAnswered, update, nextSelected } = form;
  const cardRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const options = optionList(q);
  const placement = usePlacement(cardRef, anchor, `${step}|${options.length}|${q.prompt}`, inline);

  useEffect(() => setFocusIdx(0), [step]);

  const latest = useRef({ form, focusIdx, options });
  latest.current = { form, focusIdx, options };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { form: f, focusIdx: idx, options: opts } = latest.current;
      const card = cardRef.current;
      if (!card) return;
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        card.focus();
        return;
      }
      if (inline || !cardOwnsKeyboard(card)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      const inInput = active === otherRef.current || active === textRef.current;
      const isSelect = f.q.type !== 'text';
      const advance = (override?: typeof f.state): void => {
        if (f.isLast) {
          if (override || f.allAnswered) f.respond('answered', f.buildAnswers(override));
        } else if (override || f.canAdvance) {
          f.setStep(f.step + 1);
        }
      };
      const move = (delta: number): void => {
        (active as HTMLElement | null)?.blur?.();
        setFocusIdx(Math.max(0, Math.min(opts.length - 1, idx + delta)));
      };
      const focusInput = (ref: RefObject<HTMLInputElement | null>, append = ''): void => {
        if (append) f.update(f.q.id, { otherText: f.s.otherText + append });
        ref.current?.focus();
      };
      const pickOther = (): void => {
        const next = f.nextSelected(f.q, OTHER, f.s);
        if (next && !f.s.selected.includes(OTHER)) f.update(f.q.id, { selected: next });
      };

      if (e.key === 'Escape') {
        // Same status as the composer panel's Skip. Handled in capture so the
        // overlay's "Esc stops the agent" does not also fire.
        e.preventDefault();
        e.stopPropagation();
        f.respond('dismissed', {});
        return;
      }
      if (inInput) {
        if (e.key === 'Enter') {
          e.preventDefault();
          advance();
        } else if (isSelect && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          move(e.key === 'ArrowUp' ? -1 : 1);
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!isSelect) return;
        e.preventDefault();
        move(e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (f.step > 0) f.setStep(f.step - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!f.isLast && f.canAdvance) f.setStep(f.step + 1);
      } else if (e.key === ' ' && isSelect) {
        e.preventDefault();
        const value = opts[idx];
        if (value === OTHER) {
          pickOther();
          focusInput(otherRef);
        } else if (value) f.select(f.q, value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!isSelect) {
          advance();
          return;
        }
        const value = opts[idx];
        if (f.q.type === 'single_select' && value) {
          if (value === OTHER) {
            pickOther();
            focusInput(otherRef);
            return;
          }
          const override = { ...f.state, [f.q.id]: { ...f.s, selected: [value] } };
          f.update(f.q.id, { selected: [value] });
          advance(override);
        } else if (f.canAdvance) {
          advance();
        } else if (value && value !== OTHER) {
          f.select(f.q, value);
        }
      } else if (isPrintable(e)) {
        // Typing goes straight into the free-text field.
        if (!isSelect) {
          e.preventDefault();
          focusInput(textRef, e.key);
        } else if (f.q.allowOther) {
          e.preventDefault();
          pickOther();
          focusInput(otherRef, e.key);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [inline]);

  const total = form.questions.length;
  return (
    <div
      ref={cardRef}
      className={`snaglet-agent-ask${inline ? ' snaglet-agent-ask--inline' : ''}`}
      role="dialog"
      aria-label={`Question from ${agentName}`}
      data-testid="agent-ask-card"
      tabIndex={-1}
      style={inline ? undefined : placement}
    >
      <div className="snaglet-agent-ask__head">
        <strong>{agentName}</strong>
        <span>{total > 1 ? ` asks · ${step + 1}/${total}` : ' asks'}</span>
      </div>
      {form.preamble ? <p className="snaglet-agent-ask__preamble">{form.preamble}</p> : null}
      <p className="snaglet-agent-ask__prompt">
        {q.prompt}
        {!form.required(q) ? <span className="snaglet-agent-ask__muted"> (optional)</span> : null}
      </p>
      {q.type === 'text' ? (
        <input
          ref={textRef}
          className="snaglet-agent-ask__input"
          aria-label={q.prompt}
          placeholder="Type your answer…"
          value={s.otherText}
          onChange={(e) => update(q.id, { otherText: e.target.value })}
        />
      ) : (
        <div className="snaglet-agent-ask__options" role="group">
          {options.map((value, i) => {
            const on = s.selected.includes(value);
            const isOther = value === OTHER;
            const cls = `snaglet-agent-ask__option${on ? ' is-on' : ''}${
              i === focusIdx ? ' is-focus' : ''
            }`;
            return (
              <div key={value} className="snaglet-agent-ask__row">
                <button
                  type="button"
                  className={cls}
                  aria-pressed={on}
                  onClick={() => {
                    const next = nextSelected(q, value, s);
                    if (next) update(q.id, { selected: next });
                    setFocusIdx(i);
                  }}
                >
                  <span className="snaglet-agent-ask__mark" />
                  <span>{isOther ? 'Other:' : value}</span>
                </button>
                {isOther ? (
                  <input
                    ref={otherRef}
                    className="snaglet-agent-ask__input"
                    aria-label="Other answer"
                    placeholder="…"
                    value={s.otherText}
                    onChange={(e) => update(q.id, { otherText: e.target.value })}
                    onFocus={() => {
                      if (!s.selected.includes(OTHER)) {
                        const next = nextSelected(q, OTHER, s);
                        if (next) update(q.id, { selected: next });
                      }
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <div className="snaglet-agent-ask__foot">
        <span className="snaglet-agent-ask__muted">
          {q.type === 'multi_select'
            ? '↑↓ move · Space pick · '
            : q.type === 'single_select'
              ? '↑↓ move · '
              : ''}
          Enter {isLast ? 'send' : 'next'} · Esc skip · {shortcutHint('.')} focus here
        </span>
        <span className="snaglet-agent-ask__actions">
          <button type="button" onClick={() => form.respond('dismissed', {})}>
            Skip
          </button>
          {step > 0 ? (
            <button type="button" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
          {isLast ? (
            <button
              type="button"
              disabled={!allAnswered}
              onClick={() => form.respond('answered', form.buildAnswers())}
            >
              Send
            </button>
          ) : (
            <button type="button" disabled={!canAdvance} onClick={() => setStep(step + 1)}>
              Next
            </button>
          )}
        </span>
      </div>
    </div>
  );
};
