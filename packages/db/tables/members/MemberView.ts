import { Model } from '@snaglet/db/Model';
import { View } from '@snaglet/db/View';

const tableModel = new Model<Record<string, unknown>>({
  table: 'members',
});

export class MemberView extends View<typeof tableModel> {
  constructor() {
    super({ model: tableModel });
  }
}

export const memberView = new MemberView();
