import type { FC } from 'react';
import { AgentPromptField } from './AgentPromptField';
import type { ConflictChoice, EditingProbe, LiveConflict, SaveGate } from './agentLiveFields';

export interface IdentityEditorProps {
  value: string;
  onSave: (value: string) => Promise<void> | void;
  /** Someone else changed the identity while the user was editing it. */
  conflict?: LiveConflict | null;
  onResolveConflict?: (choice?: ConflictChoice) => void;
  editingProbe?: EditingProbe;
  /** Saves wait while a change to this text is on its way or open. */
  saveGate?: SaveGate;
  waiting?: boolean;
  /** Keeps the draft when the editor closes with a conflict open. */
  onKeepDraft?: (text: string) => void;
}

export const IdentityEditor: FC<IdentityEditorProps> = (props) => (
  <AgentPromptField
    {...props}
    kind="agent-identity"
    testId="agent-identity-editor-section"
    placeholder="Write the agent identity here..."
  />
);
