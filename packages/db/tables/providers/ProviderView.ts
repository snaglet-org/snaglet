import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'providers',
});

export class ProviderView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const providerView = new ProviderView();
