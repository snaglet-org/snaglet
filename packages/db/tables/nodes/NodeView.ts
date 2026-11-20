import { View } from '@snaglet/db/View';
import { Nodes } from './NodeModel';

export class NodeView extends View<typeof Nodes> {
  constructor() {
    super({ model: Nodes });
  }
}

export const nodeView = new NodeView();
