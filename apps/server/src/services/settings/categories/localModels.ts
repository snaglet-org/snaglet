import { z } from 'zod';
import { defineCategory } from '../defineSetting';

export const localModels = defineCategory('local_models', {
  preferences: {
    key: 'preferences',
    schema: z.object({ disabled: z.array(z.string()) }),
    default: { disabled: [] },
    description: 'Per-model enablement for replaceable local assets.',
  },
});
