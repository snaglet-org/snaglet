import { View } from '@snaglet/db/View';
import { Users } from './UserModel';

export class UserView extends View<typeof Users> {
  constructor() {
    super({ model: Users });
  }
}

export const userView = new UserView();
