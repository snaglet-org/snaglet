import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useAutofitText } from 'autofit-text';
import { TYPE_SCALE } from '@desktop/styles/typeScale';
import { type SnagletAgent, type ToolAccessConfig, type ToolOverride } from '@snaglet/shared/types';
import { AgentModelEditor, type AgentModelEditorValue } from '@desktop/components/AgentModelEditor';
import { LeafToggle } from '@desktop/components/Icons';
import { Tabs } from '@desktop/components/Tabs';
import { Button, EmptyState, HelpTooltip, Switch } from '@desktop/components';
import { ToolAccessEditor } from '@desktop/components/ToolAccessEditor';
import { AgentMcpServers } from './AgentMcpServers';
import { AgentMemoriesTab } from './AgentMemoriesTab';
import { AgentDmsTab } from './AgentDmsTab';
import { AgentUtilityModelOverride } from './AgentUtilityModelOverride';
import { useToolOptions, toolAccessOf } from '@desktop/hooks/useToolOptions';
import { SystemPromptEditor } from './SystemPromptEditor';
import { IdentityEditor } from './IdentityEditor';
import { AgentRoleField } from './AgentRoleField';
import { VoicePicker } from '@desktop/features/voice';
import { FlowerAvatar } from '@desktop/components/agentCursor/FlowerAvatar';
import { useAgentAvatar } from './useAgentAvatar';
import { useLiveAgent } from './useLiveAgent';
import type { AgentLiveField, ConflictChoice } from './agentLiveFields';
import { AgentSkillsSection } from '@desktop/features/skills';
import { archivedDrawerReachable, requestArchivedDrawer } from '../archivedDrawerRequest';
import { getErrorMessage } from '@snaglet/shared/utils';
import { cn } from '@desktop/utils/classNames';
import type { AgentPageTab } from '@desktop/pages/Dashboard/selection/types';
import styles from './AgentView.module.scss';

/**
 * Detail panel for one agent: a profile header (avatar, name, role) over tabs
 * (Overview, Behavior, Capabilities, Memories, Direct messages). With
 * `variant="pane"` (default) the shell fills its host and scrolls; with
 * `preview` it flows to content height so an outer container (the
 * WikiLinkPreviewModal body) scrolls the whole card, except on Direct messages,
 * where it fills the modal like a pane.
 *
 * The pane stays live while open (`useLiveAgent`): a change made anywhere
 * else (another agent's tool, an automation, another window) shows at once
 * with a brief highlight, except in a text field the user is editing, which
 * keeps their text and offers Reload or Keep mine.
 */
export const AgentView: FC<{
  agent: SnagletAgent;
  variant?: 'pane' | 'preview';
  /** Close the pane this view renders in (offered once the agent is deleted). */
  onClosePane?: () => void;
  /** A navigation that names a tab: shown on open, and again on each new `focusRequestId`. */
  focusTab?: AgentPageTab;
  focusRequestId?: number;
}> = ({ agent: agentProp, variant = 'pane', onClosePane, focusTab, focusRequestId }) => {
  const live = useLiveAgent(agentProp);
  const {
    agent,
    saveFields,
    conflicts,
    held,
    resolveConflict,
    keepDraft,
    gates,
    waiting,
    pulsing,
    pulse,
    probes,
  } = live;
  const [tab, setTab] = useState<AgentPageTab>(focusTab ?? 'overview');
  // The page may already be open on another tab (the Direct messages tab holds
  // a chat whose Configure model link lands here), so each new request
  // switches tabs; a plain re-render with the same request leaves the user's.
  useEffect(() => {
    if (focusTab && focusRequestId !== undefined) setTab(focusTab);
  }, [focusTab, focusRequestId]);
  const preview = variant === 'preview';
  // A tab that scrolls inside itself fills its host, so the header and tabs
  // stay put. Direct messages always does: a chat needs a height to keep its
  // composer at the bottom, so in the preview modal the card takes the modal's
  // full height (WikiLinkPreviewModal reads `data-fills-host`). Memories does in
  // a pane only; in the modal the list flows with the card.
  const fillsHost = tab === 'dms' || (tab === 'memories' && !preview);
  // Summary model starts expanded; the leaf toggle collapses it.
  const [summaryOpen, setSummaryOpen] = useState(true);
  const liveClass = (field: AgentLiveField) => (pulsing.has(field) ? styles.livePulse : '');

  // Fluid hero name: the heading fits its box as the pane
  // resizes — one line in wide panes, word-wrap at watch-scale — with
  // bounds from the shared type scale instead of fixed breakpoints.
  const nameBoxRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLHeadingElement>(null);
  useAutofitText(
    nameRef,
    nameBoxRef,
    {
      wrap: { belowWidth: 220, on: 'word' },
      minFontSize: TYPE_SCALE.heroMin,
      maxFontSize: TYPE_SCALE.heroMax,
      alignX: 'left',
      alignY: 'center',
    },
    [agent.name]
  );

  // The agent's avatar (its cursor) sits beside the name; one button reshuffles it.
  const avatar = useAgentAvatar({
    agentId: agent.id,
    spec: agent.cursorSpec ?? null,
    onSave: saveFields,
  });

  // The shared editor speaks `providerId`; the SnagletAgent record stores
  // that value as `provider`. `modelId` / `credentialId`
  // line up directly. `next.providerId` is non-null in practice when
  // `allowNull=false`, but we tolerate the null type by coercing to ''
  // so the agent record stays required-provider. The fallback toggle
  // persists into configJson alongside the triple.
  const handleSaveModel = useCallback(
    (next: AgentModelEditorValue) =>
      saveFields({
        provider: next.providerId ?? '',
        modelId: next.modelId,
        credentialId: next.credentialId,
        disableModelFallback: next.disableFallback ?? false,
      }),
    [saveFields]
  );

  const handleSaveSystemPrompt = useCallback(
    (next: string) => saveFields({ systemPrompt: next }),
    [saveFields]
  );

  const handleSaveIdentity = useCallback(
    (next: string) => saveFields({ identity: next }),
    [saveFields]
  );

  const tools = useToolOptions();

  const agentToolAccess = useMemo<ToolAccessConfig>(
    () => toolAccessOf(agent),
    [agent.toolAccessMode, agent.toolAccessAllowList, agent.toolAccessDenyList]
  );
  const displayName = agent.name?.trim() || 'Untitled agent';

  const fallbackDisabled = agent.disableModelFallback;

  const handleSaveRole = useCallback((role: string | null) => saveFields({ role }), [saveFields]);
  const resolveRole = useCallback(
    (choice?: ConflictChoice) => resolveConflict('role', choice),
    [resolveConflict]
  );
  const resolveIdentity = useCallback(
    (choice?: ConflictChoice) => resolveConflict('identity', choice),
    [resolveConflict]
  );
  const resolveSystemPrompt = useCallback(
    (choice?: ConflictChoice) => resolveConflict('systemPrompt', choice),
    [resolveConflict]
  );
  const keepIdentityDraft = useCallback((text: string) => keepDraft('identity', text), [keepDraft]);
  const keepSystemPromptDraft = useCallback(
    (text: string) => keepDraft('systemPrompt', text),
    [keepDraft]
  );
  const pulseSkills = useCallback(() => pulse('skills'), [pulse]);

  const handleSaveToolAccess = useCallback(
    (next: ToolAccessConfig) => {
      const isDefault =
        next.mode === 'all' && next.allowList.length === 0 && next.denyList.length === 0;
      return saveFields({
        toolAccessMode: isDefault ? null : next.mode,
        toolAccessAllowList: isDefault ? null : next.allowList,
        toolAccessDenyList: isDefault ? null : next.denyList,
      });
    },
    [saveFields]
  );

  // Trusted-mode clear from the editor's Guarded indicator: persists the
  // overrides map with the guarded `requiresConfirmation` flags removed
  // (null when nothing else is stored). Same optimistic-refresh shape as the
  // other agent field saves.
  const handleSaveToolOverrides = useCallback(
    (next: Record<string, ToolOverride> | null) => saveFields({ toolOverrides: next }),
    [saveFields]
  );

  // Trusted tool calls: a persisted flag, not an override rewrite — so the
  // Guarded-mode revert restores exactly the previous per-tool behavior.
  const handleSaveTrustedToolCalls = useCallback(
    (next: boolean) => saveFields({ trustedToolCalls: next }),
    [saveFields]
  );

  const handleSaveMcpServers = useCallback(
    (next: string[]) => saveFields({ mcpServers: next }),
    [saveFields]
  );

  // Whether the user and other agents may DM this agent; absent reads as on.
  const dmEnabled = agent.dmEnabled !== false;
  const [dmSaveError, setDmSaveError] = useState<string | null>(null);
  const handleDmEnabledChange = useCallback(
    async (next: boolean) => {
      setDmSaveError(null);
      try {
        await saveFields({ dmEnabled: next });
      } catch (err) {
        setDmSaveError(getErrorMessage(err, 'Save failed'));
      }
    },
    [saveFields]
  );

  // Agent voice for voice mode; null means the deterministic default voice.
  const currentVoice = agent.voice ?? null;
  const handleSaveVoice = useCallback(
    (voiceId: string) => saveFields({ voice: voiceId }),
    [saveFields]
  );

  if (live.deleted) {
    return (
      <EmptyState
        title="This agent was deleted"
        body={`${displayName} no longer exists. Its messages stay in their threads.`}
        action={
          onClosePane ? (
            <Button variant="ghost" size="sm" onClick={onClosePane}>
              Close pane
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div
      className={cn(
        styles.shell,
        preview && !fillsHost && styles.shellPreview,
        preview && fillsHost && styles.shellPreviewFill,
        !preview && fillsHost && styles.shellFixed
      )}
      data-fills-host={fillsHost || undefined}
    >
      <header className={styles.profile}>
        {agent.archived && (
          <div className={styles.archivedNote} role="status">
            <span>
              This agent is archived. Restore it from the Archived drawer to use it again.
            </span>
            {archivedDrawerReachable() && (
              <Button variant="neutral" size="sm" onClick={requestArchivedDrawer}>
                Open Archived
              </Button>
            )}
          </div>
        )}
        <div className={styles.nameRow}>
          <span
            className={`${styles.avatar} ${liveClass('avatar')}`}
            data-testid="agent-avatar"
            data-live-updated={pulsing.has('avatar') || undefined}
          >
            <FlowerAvatar spec={avatar.spec} emotion="neutral" size={76} />
          </span>
          <div
            className={`${styles.nameField} ${liveClass('name')}`}
            ref={nameBoxRef}
            data-live-updated={pulsing.has('name') || undefined}
          >
            <h1 className={styles.profileName} ref={nameRef}>
              {displayName}
            </h1>
          </div>
          <Button size="sm" variant="neutral" onClick={() => void avatar.shuffle()}>
            Shuffle avatar
          </Button>
          {avatar.error && (
            <span className={styles.fieldStatusError} role="alert">
              Couldn't save the avatar
            </span>
          )}
        </div>
        <AgentRoleField
          role={agent.role ?? ''}
          onSave={handleSaveRole}
          conflict={conflicts.role}
          onResolveConflict={resolveRole}
          editingProbe={probes.role}
          saveGate={gates.role}
          waiting={waiting.has('role')}
          live={pulsing.has('role')}
        />
        <Tabs
          value={tab}
          onChange={(next) => setTab(next as AgentPageTab)}
          aria-label="Agent settings"
        >
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="behavior">Behavior</Tabs.Tab>
          <Tabs.Tab value="capabilities">Capabilities</Tabs.Tab>
          <Tabs.Tab value="memories">Memories</Tabs.Tab>
          <Tabs.Tab value="dms">Direct messages</Tabs.Tab>
        </Tabs>
      </header>

      <div
        className={cn(
          styles.panel,
          fillsHost && styles.panelFill,
          tab === 'dms' && !preview && styles.panelWide
        )}
        role="tabpanel"
      >
        {tab === 'overview' && (
          <>
            <SettingGroup
              title="Model"
              hint="The AI model this agent thinks with."
              live={pulsing.has('model')}
            >
              <AgentModelEditor
                value={{
                  providerId: agent.provider || null,
                  modelId: agent.modelId ?? null,
                  credentialId: agent.credentialId ?? null,
                  disableFallback: fallbackDisabled,
                }}
                onSave={handleSaveModel}
                showFallbackToggle={false}
                autosave
              />
              <div className={styles.advanced}>
                <div className={styles.advancedHeader}>
                  <button
                    type="button"
                    className={styles.advancedToggle}
                    aria-expanded={summaryOpen}
                    onClick={() => setSummaryOpen((open) => !open)}
                  >
                    <LeafToggle open={summaryOpen} className={styles.advancedLeaf} />
                    Summary model
                  </button>
                  <HelpTooltip
                    ariaLabel="About the summary model"
                    side="right"
                    label="Optional: use a different, cheaper model to write this agent's thread summaries."
                  />
                </div>
                {summaryOpen && (
                  <div className={styles.advancedBody}>
                    <AgentUtilityModelOverride agentId={agent.id} />
                  </div>
                )}
              </div>
            </SettingGroup>

            <SettingGroup
              title="Voice"
              hint="How this agent sounds in voice mode."
              live={pulsing.has('voice')}
            >
              <VoicePicker value={currentVoice} onSave={handleSaveVoice} />
            </SettingGroup>
          </>
        )}

        {tab === 'behavior' && (
          <>
            {/* Raw channel, mirroring the System prompt field below: the
                expanded `identity` carries literal <doc id=…> wrappers the
                editor renders as broken raw text. rawIdentity keeps
                `![](doc-id)` include chips rendering as framed embeds.
                While someone else's change waits on the user's choice, the
                editor keeps the text it had (`held`). */}
            <SettingGroup
              title="Identity"
              hint="Who the agent is: personality, tone, background."
              live={pulsing.has('identity')}
            >
              <IdentityEditor
                value={held.identity ?? agent.rawIdentity ?? agent.identity ?? ''}
                onSave={handleSaveIdentity}
                conflict={conflicts.identity}
                onResolveConflict={resolveIdentity}
                editingProbe={probes.identity}
                saveGate={gates.identity}
                waiting={waiting.has('identity')}
                onKeepDraft={keepIdentityDraft}
              />
            </SettingGroup>

            <SettingGroup
              title="System prompt"
              hint="Standing instructions the agent follows."
              live={pulsing.has('systemPrompt')}
            >
              <SystemPromptEditor
                value={held.systemPrompt ?? agent.rawSystemPrompt ?? agent.systemPrompt ?? ''}
                onSave={handleSaveSystemPrompt}
                conflict={conflicts.systemPrompt}
                onResolveConflict={resolveSystemPrompt}
                editingProbe={probes.systemPrompt}
                saveGate={gates.systemPrompt}
                waiting={waiting.has('systemPrompt')}
                onKeepDraft={keepSystemPromptDraft}
              />
            </SettingGroup>

            <SettingGroup
              title="Direct messages"
              hint="Let you and other agents send this agent DMs. Existing conversations stay readable when off."
              live={pulsing.has('dmEnabled')}
            >
              <div className={styles.switchLine}>
                <Switch
                  size="md"
                  checked={dmEnabled}
                  onChange={(next) => void handleDmEnabledChange(next)}
                  onLabel="On"
                  offLabel="Off"
                  aria-label="Direct messages"
                />
                {dmSaveError && (
                  <span className={styles.fieldStatusError} role="alert">
                    {dmSaveError}
                  </span>
                )}
              </div>
            </SettingGroup>
          </>
        )}

        {tab === 'capabilities' && (
          <>
            <SettingGroup
              title="Tools"
              hint="What this agent is allowed to do."
              live={pulsing.has('tools')}
            >
              <ToolAccessEditor
                value={agentToolAccess}
                tools={tools}
                onSave={handleSaveToolAccess}
                toolOverrides={agent.toolOverrides}
                onSaveToolOverrides={handleSaveToolOverrides}
                trustedToolCalls={agent.trustedToolCalls === true}
                onSaveTrustedToolCalls={handleSaveTrustedToolCalls}
                autosave
              />
            </SettingGroup>

            <SettingGroup
              title="Skills"
              hint="Reusable know-how the agent can load."
              live={pulsing.has('skills')}
            >
              <AgentSkillsSection agentId={agent.id} onRemoteChange={pulseSkills} />
            </SettingGroup>

            <SettingGroup
              title="MCP servers"
              hint="External tool servers this agent can use."
              live={pulsing.has('mcpServers')}
            >
              <AgentMcpServers
                agentId={agent.id}
                enabled={Array.isArray(agent.mcpServers) ? agent.mcpServers : []}
                onSave={handleSaveMcpServers}
              />
            </SettingGroup>
          </>
        )}

        {tab === 'memories' && (
          <AgentMemoriesTab key={agent.id} agentId={agent.id} agentName={agent.name} />
        )}

        {tab === 'dms' && <AgentDmsTab key={agent.id} agent={agent} />}
      </div>
    </div>
  );
};

/**
 * A quiet settings block: title + plain-English hint, then the control.
 * `live` highlights it briefly after a change made somewhere else.
 */
const SettingGroup: FC<{ title: string; hint?: string; live?: boolean; children: ReactNode }> = ({
  title,
  hint,
  live = false,
  children,
}) => (
  <section
    className={`${styles.group} ${live ? styles.livePulse : ''}`}
    data-live-updated={live || undefined}
  >
    <div className={styles.groupHead}>
      <h2 className={styles.groupTitle}>{title}</h2>
      {hint && <p className={styles.groupHint}>{hint}</p>}
    </div>
    {children}
  </section>
);
