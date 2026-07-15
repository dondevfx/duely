import { Component } from 'react';

// Catches render/runtime errors in the page tree so a single broken component
// shows a friendly message instead of blanking the whole app (React unmounts
// the entire tree on an uncaught render error when there's no boundary).
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Reset when the route changes so navigating away recovers automatically.
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center text-center px-6 py-24 gap-4">
          <div className="text-5xl">😵</div>
          <h2 className="text-xl font-bold text-white">Something went wrong on this page</h2>
          <p className="text-muted max-w-md text-sm">
            An unexpected error occurred. You can try reloading, or head back home.
          </p>
          <div className="flex gap-3 mt-2">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-primary text-white font-semibold"
            >
              Reload
            </button>
            <button
              onClick={() => { window.location.href = '/'; }}
              className="px-4 py-2 rounded-lg border border-white/20 text-white font-semibold"
            >
              Go home
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
