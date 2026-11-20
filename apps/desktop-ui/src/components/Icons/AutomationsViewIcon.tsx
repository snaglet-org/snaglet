import { type FC } from 'react';
import { SwirlIcon } from './SwirlIcon';

/**
 * Activity-bar glyph for the Automations view: the same swirl the workspace
 * tree spins on a thread while an agent runs, drawn static at the rail's 20px
 * in `currentColor`. The activity bar spins it while an automation's wake is
 * going.
 */
export const AutomationsViewIcon: FC = () => <SwirlIcon size={20} />;
