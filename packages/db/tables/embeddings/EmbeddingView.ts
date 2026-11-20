import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'embeddings',
});

export class EmbeddingView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const embeddingView = new EmbeddingView();
