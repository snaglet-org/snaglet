import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'user_provider_credentials',
});

export class UserProviderCredentialView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const userProviderCredentialView = new UserProviderCredentialView();
