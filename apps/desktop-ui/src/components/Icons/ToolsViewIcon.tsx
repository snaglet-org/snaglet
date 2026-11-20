import { type FC } from 'react';
import { ToolIcon } from './ToolIcon';

/**
 * Activity-bar glyph for the Tools view: the same shovel that marks tool rows
 * (`ToolIcon`), drawn at the rail's 20px in `currentColor`.
 */
export const ToolsViewIcon: FC = () => <ToolIcon size={20} />;
