import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'images',
});

export class ImageView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const imageView = new ImageView();
