import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IdentityEditor } from './IdentityEditor';
import { SystemPromptEditor } from './SystemPromptEditor';

const workspaceEditorProps: Array<{ onSave: (next: string) => unknown }> = [];

vi.mock('@desktop/features/rich-markdown/workspace-editor', () => ({
  WorkspaceEditor: (props: { onSave: (next: string) => unknown }) => {
    workspaceEditorProps.push(props);
    return <div data-testid="workspace-editor" />;
  },
  EditorSaveHint: () => null,
  useEditorSaveStatus: () => ({
    status: { state: 'pristine', error: null },
    onSaveStateChange: vi.fn(),
  }),
}));

describe('Agent prompt editors', () => {
  it('IdentityEditor returns the async save promise to WorkspaceEditor autosave', () => {
    workspaceEditorProps.length = 0;
    const savePromise = Promise.resolve();
    const onSave = vi.fn(() => savePromise);

    render(<IdentityEditor value="old identity" onSave={onSave} />);

    expect(screen.getByTestId('workspace-editor')).toBeTruthy();
    expect(workspaceEditorProps[0]?.onSave('new identity')).toBe(savePromise);
    expect(onSave).toHaveBeenCalledWith('new identity');
  });

  it('SystemPromptEditor returns the async save promise to WorkspaceEditor autosave', () => {
    workspaceEditorProps.length = 0;
    const savePromise = Promise.resolve();
    const onSave = vi.fn(() => savePromise);

    render(<SystemPromptEditor value="old prompt" onSave={onSave} />);

    expect(screen.getByTestId('workspace-editor')).toBeTruthy();
    expect(workspaceEditorProps[0]?.onSave('new prompt')).toBe(savePromise);
    expect(onSave).toHaveBeenCalledWith('new prompt');
  });
});
