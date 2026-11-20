import { View } from '@snaglet/db/View';
import { Agents } from './AgentModel';

export class AgentView extends View<typeof Agents> {
  constructor() {
    super({ model: Agents });
  }
}

export const agentView = new AgentView();
