import { View } from '@snaglet/db/View';
import { Threads } from './ThreadModel';

export class ThreadView extends View<typeof Threads> {
  constructor() {
    super({ model: Threads });
  }
}

export const threadView = new ThreadView();
