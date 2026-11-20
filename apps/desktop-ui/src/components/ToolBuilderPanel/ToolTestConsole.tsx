import { useCallback, useState, type FC } from 'react';
import { Button, Textarea } from '@desktop/components';
import { BuilderTestConsole, useTestConsoleEntries } from '@desktop/components/BuilderTestConsole';
import { toolsApi } from '@desktop/utils/api';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { explainNestedToolRefusal, seedArgsJson } from './toolTestConsoleSupport';
import consoleStyles from '@desktop/components/BuilderTestConsole/BuilderTestConsole.module.scss';

export interface ToolTestConsoleProps {
  /** Folder-safe tool id/name — session key + run labels. */
  toolName: string;
  /** Current editor content. The sandbox runs this text, saved or not
   *  (`/tools/execute/test` takes raw code; no deploy needed). */
  code: string;
  /** The tool's parameters schema, used to pre-seed the args editor. */
  parametersSchema: Record<string, unknown> | null;
  disabled?: boolean;
}

/**
 * ToolTestConsole — the tool builder's collapsible test surface (shared
 * shell: BuilderTestConsole, same look as the hook console). Runs the code
 * currently in the editor through the isolated `/tools/execute/test`
 * sandbox with a JSON args object pre-seeded from `parametersSchema`
 * (defaults / first enum value / empty-by-type — see seedArgsFromSchema).
 * The sandbox has no agent, so a nested `snaglet.tools.execute` inside tested
 * code runs as the ghost system actor and is limited to ghost's allow list;
 * a refusal is translated into a plain-language note instead of a bare stack.
 */
export const ToolTestConsole: FC<ToolTestConsoleProps> = ({
  toolName,
  code,
  parametersSchema,
  disabled = false,
}) => {
  const { entries, append, clear } = useTestConsoleEntries(`tool:${toolName || 'new-tool'}`);
  const [expanded, setExpanded] = useState(false);
  const [argsJson, setArgsJson] = useState(() => seedArgsJson(parametersSchema));
  const [running, setRunning] = useState(false);

  const label = toolName || 'tool';

  const handleReseed = useCallback(() => {
    setArgsJson(seedArgsJson(parametersSchema));
  }, [parametersSchema]);

  const handleRun = useCallback(async () => {
    let input: Record<string, unknown> = {};
    const trimmed = argsJson.trim();
    if (trimmed) {
      const parsed = safeJsonParse<Record<string, unknown> | null>(trimmed, null);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        append({
          label,
          status: 'fail',
          stderr: 'Input JSON must be a single object, e.g. { "query": "…" }.',
        });
        return;
      }
      input = parsed;
    }
    setRunning(true);
    try {
      const result = await toolsApi.test(code, input);
      append({
        label,
        status: result.success ? 'ok' : 'fail',
        payload: input,
        payloadLabel: 'Input',
        stdout: result.output,
        stderr: result.error,
        durationMs: result.durationMs,
        note: result.error ? (explainNestedToolRefusal(result.error) ?? undefined) : undefined,
      });
    } catch (err) {
      append({ label, status: 'fail', stderr: getErrorMessage(err, 'Test run failed') });
    } finally {
      setRunning(false);
    }
  }, [argsJson, code, label, append]);

  return (
    <BuilderTestConsole
      title="Test console"
      notice="Runs the code in the editor, saved or not. Its @snaglet/sdk calls are real and act as the ghost system actor (table, thread send/read, database_query), the same as when a person runs the saved tool."
      entries={entries}
      onClear={clear}
      expanded={expanded}
      onToggle={() => setExpanded((current) => !current)}
      controls={
        <div className={consoleStyles.controls}>
          <div className={consoleStyles.controlField}>
            <span className={consoleStyles.controlLabel}>Input JSON</span>
            <Textarea
              unstyled
              value={argsJson}
              onChange={(event) => setArgsJson(event.target.value)}
              rows={4}
              disabled={disabled || running}
              placeholder="{}"
              aria-label="Tool input JSON"
              className={consoleStyles.jsonInput}
            />
            <span className={consoleStyles.controlHint}>
              Pre-seeded from the tool&apos;s parameters schema (defaults, or an empty value per
              type).
            </span>
          </div>
          <div className={consoleStyles.actions}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleRun()}
              disabled={disabled}
              loading={running}
              loadingText="Running…"
              title="Run the editor's current code in the isolated test sandbox with the input above"
            >
              Run test
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReseed}
              disabled={disabled || running}
              title="Rebuild the input skeleton from the current parameters schema"
            >
              Re-seed from schema
            </Button>
          </div>
        </div>
      }
    />
  );
};
