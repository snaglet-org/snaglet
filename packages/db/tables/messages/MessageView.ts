import { View } from '@snaglet/db/View';
import { Messages } from './MessageModel';

export class MessageView extends View<typeof Messages> {
  constructor() {
    super({ model: Messages });
  }
}

export const messageView = new MessageView();
