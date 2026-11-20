import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'provider_fallback_credentials',
});

export class ProviderFallbackCredentialView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const providerFallbackCredentialView = new ProviderFallbackCredentialView();
