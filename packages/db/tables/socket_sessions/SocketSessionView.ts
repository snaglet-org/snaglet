import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'socket_sessions',
});

export class SocketSessionView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const socketSessionView = new SocketSessionView();
