import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'thread_participants',
});

export class ThreadParticipantView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const threadParticipantView = new ThreadParticipantView();
