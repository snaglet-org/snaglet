import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'models',
});

export class ModelView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const modelView = new ModelView();
