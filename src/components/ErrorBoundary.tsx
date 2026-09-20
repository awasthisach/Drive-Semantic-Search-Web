import * as React from 'react';

type ErrorBoundaryProps = {
  children?: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

/**
 * Class error boundary — keeps the app from white-screening on render errors.
 * Uses namespace import so tsc always resolves Component/setState with React 19.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Unexpected error',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(JSON.stringify({
      source: 'error_boundary',
      message: error?.message,
      stack: error?.stack?.slice?.(0, 500),
      componentStack: info?.componentStack?.slice?.(0, 500),
      ts: new Date().toISOString(),
    }));
  }

  private handleReload = (): void => {
    this.setState({ hasError: false, message: '' });
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6">
          <div className="max-w-md w-full rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4 text-center">
            <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
              Something went wrong
            </h1>
            <p className="text-xs text-zinc-500 break-words">{this.state.message}</p>
            <button
              type="button"
              className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold"
              onClick={this.handleReload}
            >
              Reload app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children ?? null;
  }
}
