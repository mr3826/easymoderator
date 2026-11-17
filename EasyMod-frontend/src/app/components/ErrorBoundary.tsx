
import React, { Component, ReactNode } from 'react';
import i18n from '@/i18n';
// ...existing code...

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // ...existing code...
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('Error caught by boundary:', error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-em-bg-app flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-em-bg-surface rounded-lg shadow-lg p-6 text-center">
            <div className="w-16 h-16 bg-em-danger-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-em-danger-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-em-text-primary mb-2">{i18n.t('shell.boundary.title')}</h1>
            <p className="text-em-text-secondary mb-6">
              {i18n.t('shell.boundary.message')}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="w-full min-h-11 bg-em-violet-600 text-white py-2 px-4 rounded-lg hover:bg-em-violet-700 transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none"
            >
              {i18n.t('shell.boundary.refresh')}
            </button>
            {import.meta.env.DEV && this.state.error && (
              <details className="mt-4 text-left">
                <summary className="cursor-pointer text-sm text-em-text-secondary">{i18n.t('shell.boundary.details')}</summary>
                <pre className="mt-2 text-xs bg-em-bg-muted p-2 rounded overflow-auto">
                  {this.state.error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
