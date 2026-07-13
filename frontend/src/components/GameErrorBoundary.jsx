import React from 'react';

// Catches render crashes in a game page so a thrown error shows a readable
// message (and logs to the console) instead of unmounting the whole app to a
// black screen. Without this, any exception during the game render leaves the
// user staring at a blank dark page with no way to recover.
export default class GameErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface the full stack in the console for debugging.
    console.error('[GameErrorBoundary] render crash:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: 'calc(100dvh - 56px)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: 24, textAlign: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 40 }}>🃏💥</div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: '#fff' }}>Something went wrong loading the game.</h2>
          <pre style={{
            maxWidth: 520, width: '100%', overflowX: 'auto',
            fontSize: 12, color: '#f87171',
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 10, padding: 12, textAlign: 'left', whiteSpace: 'pre-wrap',
          }}>{String(this.state.error?.message || this.state.error)}</pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.href = '/'; }}
            style={{
              padding: '12px 24px', borderRadius: 10, fontWeight: 800,
              background: '#1250B4', color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            Back to Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
