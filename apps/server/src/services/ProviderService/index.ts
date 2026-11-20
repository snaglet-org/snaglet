import { Providers } from '@snaglet/db/tables/providers';
import { ProviderAuthTypes } from '@snaglet/db/tables/provider_auth_types';
import { withMetadataFields } from './metadata';
import { gateAppleOnDeviceList, gateAppleOnDeviceGet } from './appleOnDeviceGate';
import type { Provider, ProviderAuthType } from './types';

function mapAuthType(row: {
  id: string;
  name: string;
  type: string;
  description: string;
  tokenLabel: string | null;
  tokenPlaceholder: string | null;
  tokenHelp: string | null;
  sortOrder: number;
}): ProviderAuthType {
  return withMetadataFields({
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    tokenLabel: row.tokenLabel,
    tokenPlaceholder: row.tokenPlaceholder,
    tokenHelp: row.tokenHelp,
    sortOrder: row.sortOrder,
  });
}

export const providerService = {
  async list(): Promise<Provider[]> {
    try {
      const providerRows = await Providers.listAll();
      if (providerRows.length === 0) return [];

      const providerIds = providerRows.map((provider) => provider.id);
      const authRows = await ProviderAuthTypes.listByProviderIds(providerIds);

      const authByProvider = new Map<string, ProviderAuthType[]>();
      for (const row of authRows) {
        const list = authByProvider.get(row.providerId) ?? [];
        list.push(mapAuthType(row));
        authByProvider.set(row.providerId, list);
      }

      const mapped = providerRows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        website: row.website,
        apiDocs: row.apiDocs,
        baseUrl: row.baseUrl,
        type: row.type,
        enabled: row.enabled,
        sortOrder: row.sortOrder,
        primaryCredentialId: row.primaryCredentialId,
        authTypes: authByProvider.get(row.id) ?? [],
        defaultMetadata: row.defaultMetadata ?? {},
      }));
      return await gateAppleOnDeviceList(mapped);
    } catch {
      return [];
    }
  },

  async setPrimaryCredential(
    providerId: string,
    credentialId: string | null
  ): Promise<Provider | null> {
    const updated = await Providers.updatePrimaryCredential(providerId, credentialId);
    if (!updated) return null;
    return this.get(providerId);
  },

  async updateBaseUrl(providerId: string, baseUrl: string | null): Promise<Provider | null> {
    // Reject for the canonical openai provider — its URL is hard-pinned in
    // `openai.ts` (`OPENAI_FALLBACK_BASE_URL`) and should never be redirected
    // through the providers row, so silently allowing a row update would
    // mislead the user into thinking the change took effect.
    if (providerId === 'openai') {
      throw new Error("The 'openai' provider's URL is hard-pinned and cannot be changed.");
    }
    const updated = await Providers.updateBaseUrl(providerId, baseUrl);
    if (!updated) return null;
    return this.get(providerId);
  },

  async get(id: string): Promise<Provider | null> {
    try {
      const row = await Providers.findProvider(id);
      if (!row) return null;

      const authRows = await ProviderAuthTypes.listByProviderId(id);

      const mapped: Provider = {
        id: row.id,
        name: row.name,
        description: row.description,
        website: row.website,
        apiDocs: row.apiDocs,
        baseUrl: row.baseUrl,
        type: row.type,
        enabled: row.enabled,
        sortOrder: row.sortOrder,
        primaryCredentialId: row.primaryCredentialId,
        authTypes: authRows.map(mapAuthType),
        defaultMetadata: row.defaultMetadata ?? {},
      };
      return await gateAppleOnDeviceGet(mapped);
    } catch {
      return null;
    }
  },

  async setEnabled(providerId: string, enabled: boolean): Promise<Provider | null> {
    const updated = await Providers.setEnabled(providerId, enabled);
    if (!updated) return null;
    return this.get(providerId);
  },
};

export type { Provider, ProviderAuthType } from './types';
