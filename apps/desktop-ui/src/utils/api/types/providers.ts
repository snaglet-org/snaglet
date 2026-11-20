/**
 * Type definitions for providers, credentials, models, and usage reporting.
 */

import type { ModelMetadata, ProviderDefaultMetadata } from '@snaglet/shared/types';

export type { ModelMetadata } from '@snaglet/shared/types';

export interface MetadataField {
  key: string;
  label: string;
  placeholder?: string;
  inputType: 'text' | 'password';
}

export interface ProviderAuthType {
  id: string;
  name: string;
  type: 'oauth' | 'api_key' | 'local' | string;
  description: string;
  tokenLabel?: string | null;
  tokenPlaceholder?: string | null;
  tokenHelp?: string | null;
  sortOrder: number;
  /** Present when this auth type requires more than one input field. */
  metadataFields?: MetadataField[];
}

export type ProviderType = 'llm' | 'integration' | 'runtime';

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
}

export interface ProviderCredential {
  id: string;
  providerId: string;
  authTypeId: string;
  authType: string;
  label: string;
  hasSecret: boolean;
  updatedAt: string;
  verificationStatus: 'untested' | 'ok' | 'fail';
}

export interface ExportedProviderCredential {
  providerId: string;
  authTypeId: string;
  authType: string;
  label: string;
  secret: string;
  metadata: Record<string, unknown>;
}

export interface ProviderVerifyResult {
  valid: boolean;
  message: string;
}

/** The model an agent with none would take now: a connected provider's default model. */
export interface ProviderDefaultModel {
  providerId: string;
  modelId: string;
  displayName: string;
}

export interface ModelRow {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  description: string;
  family: string | null;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  isActive: boolean;
  sortOrder: number;
  type: string;
  metadata: ModelMetadata;
}

export interface ProviderFallbackCredential {
  id: string;
  providerId: string;
  credentialId: string;
  fallbackIndex: number;
  createdAt: string;
}
