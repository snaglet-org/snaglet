import type { ProviderDefaultMetadata } from '@snaglet/shared/types';

export interface MetadataField {
  key: string;
  label: string;
  placeholder?: string;
  inputType: 'text' | 'password';
}

export interface ProviderAuthType {
  id: string;
  name: string;
  type: 'oauth' | 'api_key' | string;
  description: string;
  tokenLabel: string | null;
  tokenPlaceholder: string | null;
  tokenHelp: string | null;
  sortOrder: number;
  metadataFields?: MetadataField[];
}

type ProviderType = 'llm' | 'integration' | 'runtime';

export interface Provider {
  id: string;
  name: string;
  description: string;
  website: string | null;
  apiDocs: string | null;
  baseUrl: string | null;
  type: ProviderType;
  enabled: boolean;
  sortOrder: number;
  primaryCredentialId: string | null;
  authTypes: ProviderAuthType[];
  defaultMetadata: ProviderDefaultMetadata;
  /**
   * Honest reason `enabled` is currently false for a provider whose
   * availability is resolved live rather than just toggled by a user (today:
   * only `apple-on-device` — see appleChatResolver's
   * AppleChatUnavailableReason). Absent for every other provider.
   */
  disabledReason?: string;
}
