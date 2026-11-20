import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.scss';

interface Props {
  children: ReactNode;
  /**
   * Optional label surfaced in the error UI — e.g. the pane's node title.
   * Helps the user understand which surface crashed without reading a stack.
   */
  label?: string;
  /**
   * Custom fallback rendered instead of the default error panel. Pass `null`
   * to degrade silently to nothing (e.g. an overlay that should simply close
   * on a render error rather than paint a panel over the whole app). When
   * omitted the default in-place panel is shown.
   */
  fallback?: ReactNode;
  /**
   * Invoked from `componentDidCatch` with the thrown error. Lets a parent
   * react to the crash — e.g. flip an `open` flag so a crashed overlay closes.
   */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in a pane body so a single view crash
 * does not take down the whole Dashboard. Shows a minimal in-pane
 * message with a reset button instead of a white screen.
 *
 * React requires a class component for error boundaries.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the browser console so dev tools / Tauri logs capture it.
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
    this.props.onError?.(error);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // A caller-supplied fallback wins — `null` is a valid choice (render
    // nothing), so distinguish "provided" from "omitted" via `undefined`.
    if (this.props.fallback !== undefined) return this.props.fallback;

    const { label } = this.props;

    return (
      <div className={styles.root}>
        <div className={styles.inner}>
          <span className={styles.icon}>&#x26A0;</span>
          <p className={styles.heading}>
            {label ? `${label} failed to render` : 'Something went wrong'}
          </p>
          <p className={styles.detail}>{error.message}</p>
          <button className={styles.resetBtn} onClick={this.handleReset}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
