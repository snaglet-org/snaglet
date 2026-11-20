const WORKSPACE_ITEM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_WORKSPACE_ITEM_NAME_LENGTH = 64;

/**
 * Validate a workspace-backed item name that is also used as its folder id.
 */
export function validateWorkspaceItemName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name is required.';
  if (trimmed.length > MAX_WORKSPACE_ITEM_NAME_LENGTH) {
    return `Name must be ${MAX_WORKSPACE_ITEM_NAME_LENGTH} characters or fewer.`;
  }
  if (!/^[a-zA-Z]/.test(trimmed)) return 'Name must start with a letter.';
  if (!WORKSPACE_ITEM_NAME_RE.test(trimmed)) {
    return 'Name must contain only letters, numbers, "-", or "_".';
  }
  return null;
}
