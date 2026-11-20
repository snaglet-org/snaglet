import { View } from '@snaglet/db/View';
import { Memories } from './MemoryModel';

export class MemoryView extends View<typeof Memories> {
  constructor() {
    super({ model: Memories });
  }
}

export const memoryView = new MemoryView();
