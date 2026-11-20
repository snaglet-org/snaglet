type ProviderAuthMode = 'api_key' | 'oauth' | string;

export interface SafeProviderCredential {
  id: string;
  providerId: string;
  authTypeId: string;
  authType: ProviderAuthMode;
  label: string;
  hasSecret: boolean;
  updatedAt: string;
  verificationStatus: 'untested' | 'ok' | 'fail';
}

export interface ExportedProviderCredential {
  providerId: string;
  authTypeId: string;
  authType: ProviderAuthMode;
  label: string;
  secret: string;
  metadata: Record<string, unknown>;
}

export interface SaveProviderCredentialInput {
  providerId: string;
  authTypeId: string;
  authType: ProviderAuthMode;
  label?: string;
  secret: string;
  metadata?: Record<string, unknown>;
}
