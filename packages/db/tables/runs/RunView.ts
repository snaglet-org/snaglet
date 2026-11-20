import { View } from '@snaglet/db/View';
import { Runs } from './RunModel';

export class RunView extends View<typeof Runs> {
  constructor() {
    super({ model: Runs });
  }
}

export const runView = new RunView();
