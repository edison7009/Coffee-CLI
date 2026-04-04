import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  /** Fallback label shown in recovery UI */
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error?.message ?? String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[HC] Render error caught by ErrorBoundary:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '32px',
          gap: '16px',
          color: 'var(--text-2, #a0a0a0)',
          textAlign: 'center',
        }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--warning, #f59e0b)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-1, #e0e0e0)', margin: 0 }}>
            {this.props.fallbackLabel ?? 'Render Error'}
          </p>
          <p style={{ fontSize: '12px', margin: 0, maxWidth: '360px', wordBreak: 'break-all', opacity: 0.6 }}>
            {this.state.errorMessage}
          </p>
          <button
            onClick={this.handleReset}
            style={{
              marginTop: '8px',
              padding: '6px 18px',
              fontSize: '12px',
              background: 'var(--accent, #7c6af7)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
