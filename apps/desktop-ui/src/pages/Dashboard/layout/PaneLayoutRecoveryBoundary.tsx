import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type FC,
  type ReactNode,
} from 'react';

import { PaneLayout, type PaneCallbacks } from './PaneLayout';
import type { LayoutNode } from './paneTree';

interface PaneLayoutRecoveryBoundaryProps {
  layout: LayoutNode;
  activeLeafId: string | null;
  callbacks: PaneCallbacks;
  onReset: () => void;
}

interface CatcherProps {
  children: ReactNode;
  onCrash: () => void;
}

interface CatcherState {
  crashed: boolean;
}

class PaneLayoutCrashCatcher extends Component<CatcherProps, CatcherState> {
  state: CatcherState = { crashed: false };

  static getDerivedStateFromError(): CatcherState {
    return { crashed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    this.props.onCrash();
  }

  render(): ReactNode {
    if (this.state.crashed) return <div role="status">Recovering pane layout…</div>;
    return this.props.children;
  }
}

interface SplitDiagnostic {
  splitId: string;
  childIds: string[];
  ratios: number[];
}

function paneLayoutStructure(
  layout: LayoutNode,
  splits: SplitDiagnostic[] = []
): SplitDiagnostic[] {
  if (layout.kind === 'leaf') return splits;
  splits.push({
    splitId: layout.id,
    childIds: layout.children.map((child) => child.id),
    ratios: layout.ratios.slice(),
  });
  for (const child of layout.children) paneLayoutStructure(child, splits);
  return splits;
}

const RecoveryCommit: FC<{ onCommit: () => void }> = ({ onCommit }) => {
  useEffect(onCommit, [onCommit]);
  return null;
};

/**
 * Isolates react-resizable-panels failures to the pane surface. One crash
 * resets only pane state and remounts the boundary; if that safe render also
 * crashes before committing, the fallback remains instead of entering a reset
 * loop. The diagnostic intentionally contains structure only.
 */
export const PaneLayoutRecoveryBoundary: FC<PaneLayoutRecoveryBoundaryProps> = ({
  layout,
  activeLeafId,
  callbacks,
  onReset,
}) => {
  const [generation, setGeneration] = useState(0);
  const recoveryPendingRef = useRef(false);
  const markCommitted = useCallback(() => {
    recoveryPendingRef.current = false;
  }, []);
  const handleCrash = useCallback(() => {
    console.error('[pane-layout] renderer crashed', {
      source: 'render-crash',
      rootId: layout.id,
      rootKind: layout.kind,
      splits: paneLayoutStructure(layout),
    });
    if (recoveryPendingRef.current) return;
    recoveryPendingRef.current = true;
    onReset();
    setGeneration((current) => current + 1);
  }, [layout, onReset]);

  return (
    <PaneLayoutCrashCatcher key={generation} onCrash={handleCrash}>
      <PaneLayout layout={layout} activeLeafId={activeLeafId} callbacks={callbacks} />
      <RecoveryCommit onCommit={markCommitted} />
    </PaneLayoutCrashCatcher>
  );
};
