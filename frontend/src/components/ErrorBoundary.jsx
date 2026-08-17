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

          {/* The escape hatch for a crash that reloading cannot fix.
              Something stored in this browser — a half-written session, a
              value from an older version of the app — can make the app throw
              on every single load, and then Reload just reproduces it forever.
              Clearing signs them out, so it is last resort and labelled as
              such, but it beats a browser that can never open the site. */}
          {this.props.allowReset && (
            <button
              onClick={() => {
                try { localStorage.clear(); sessionStorage.clear(); } catch {}
                window.location.href = '/';
              }}
              className="mt-2 text-xs text-muted underline hover:text-white"
            >
              Still broken? Reset the app (signs you out)
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
