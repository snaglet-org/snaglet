import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'agent_activity_log',
});

export class AgentActivityLogView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const agentActivityLogView = new AgentActivityLogView();
