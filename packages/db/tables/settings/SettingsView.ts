import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'settings',
});

export class SettingsView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const settingsView = new SettingsView();
