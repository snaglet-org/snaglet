import type { ReactElement } from 'react';
import type { ClarificationRequestPayload } from '@snaglet/shared/types';
import { Button } from '@desktop/components/controls/Button/Button';
import { TextInput } from '@desktop/components/controls/TextInput/TextInput';
import { InteractionPanel } from './InteractionPanel/InteractionPanel';
import styles from './ClarificationPrompt.module.scss';
import { OTHER, useClarificationForm, type ClarificationRespond } from './useClarificationForm';

interface Props {
  request: ClarificationRequestPayload;
  onRespond: ClarificationRespond;
}

/**
 * Interactive clarification, shown as a square panel above the composer. One
 * question at a time with Back/Next; the last step submits. Themed to match the
 * terminal aesthetic (0-radius keylines, mono `$` header, amber accent).
 */
export function ClarificationPrompt({ request, onRespond }: Props): ReactElement {
  const {
    questions,
    preamble,
    step,
    setStep,
    q,
    s,
    isLast,
    canAdvance,
    allAnswered,
    required,
    update,
    select,
    buildAnswers,
    respond,
  } = useClarificationForm(request, onRespond);

  const renderOption = (value: string, label: string, isOther: boolean): ReactElement => {
    const on = s.selected.includes(value);
    const indicator = (
      <span className={`${styles.indicator} ${on ? styles.indicatorOn : ''}`.trim()} />
    );
    if (isOther) {
      return (
        <div key={value} className={styles.otherRow}>
          <button
            type="button"
            className={`${styles.option} ${on ? styles.optionSelected : ''}`.trim()}
            style={{ flex: '0 0 auto', width: 'auto' }}
            aria-pressed={on}
            onClick={() => select(q, value)}
          >
            {indicator}
            <span>{label}</span>
          </button>
          <TextInput
            inputSize="sm"
            fullWidth
            containerClassName={styles.otherInput}
            placeholder="…"
            aria-label="Other answer"
            value={s.otherText}
            onChange={(e) => update(q.id, { otherText: e.target.value })}
            onFocus={() => {
              if (!s.selected.includes(value)) select(q, value);
            }}
          />
        </div>
      );
    }
    return (
      <button
        key={value}
        type="button"
        className={`${styles.option} ${on ? styles.optionSelected : ''}`.trim()}
        aria-pressed={on}
        onClick={() => select(q, value)}
      >
        {indicator}
        <span>{label}</span>
      </button>
    );
  };

  return (
    <InteractionPanel
      title="$ Ask"
      detail={`${step + 1} / ${questions.length}`}
      resizeLabel="Resize question panel"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => respond('dismissed', {})}>
            Skip
          </Button>
          <div className={styles.nav}>
            <Button
              variant="neutral"
              size="sm"
              disabled={step === 0}
              onClick={() => setStep((v) => Math.max(0, v - 1))}
            >
              ‹ Back
            </Button>
            {isLast ? (
              <Button
                variant="primary"
                size="sm"
                disabled={!allAnswered}
                onClick={() => respond('answered', buildAnswers())}
              >
                Send answers
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!canAdvance}
                onClick={() => setStep((v) => Math.min(questions.length - 1, v + 1))}
              >
                Next ›
              </Button>
            )}
          </div>
        </>
      }
    >
      {preamble ? <p className={styles.preamble}>{preamble}</p> : null}
      <p className={styles.prompt}>
        {q.prompt}
        {!required(q) ? <span className={styles.optional}>(optional)</span> : null}
      </p>

      {q.type === 'text' ? (
        <TextInput
          fullWidth
          className={styles.textField}
          placeholder="Type your answer…"
          aria-label={q.prompt}
          value={s.otherText}
          onChange={(e) => update(q.id, { otherText: e.target.value })}
        />
      ) : (
        <div className={styles.options}>
          {(q.options ?? []).map((opt) => renderOption(opt, opt, false))}
          {q.allowOther ? renderOption(OTHER, 'Other:', true) : null}
        </div>
      )}
    </InteractionPanel>
  );
}
