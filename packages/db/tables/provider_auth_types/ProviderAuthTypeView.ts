import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'provider_auth_types',
});

export class ProviderAuthTypeView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const providerAuthTypeView = new ProviderAuthTypeView();
