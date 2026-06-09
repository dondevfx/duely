const config = {
  wait: {
    label: 'WAIT',
    bg: 'bg-danger/10',
    border: 'border-danger',
    text: 'text-danger',
    shadow: 'shadow-glow-red',
    pulse: false,
  },
  ready: {
    label: 'READY',
    bg: 'bg-warning/10',
    border: 'border-warning',
    text: 'text-warning',
    shadow: 'shadow-glow-yellow',
    pulse: true,
  },
  go: {
    label: 'GO!',
    bg: 'bg-success/10',
    border: 'border-success',
    text: 'text-success',
    shadow: 'shadow-glow-green',
    pulse: false,
  },
  idle: {
    label: '',
    bg: 'bg-surfaceLight',
    border: 'border-surfaceLight',
    text: 'text-muted',
    shadow: '',
    pulse: false,
  },
};

export default function StatusIndicator({ state = 'idle', countdown }) {
  const c = config[state] || config.idle;

  return (
    <div className={`
      w-48 h-48 sm:w-64 sm:h-64 rounded-full flex flex-col items-center justify-center mx-auto
      border-4 ${c.bg} ${c.border} ${c.shadow}
      transition-all duration-300
      ${c.pulse ? 'animate-pulse-glow' : ''}
    `}>
      {state === 'countdown' ? (
        <span className="text-7xl font-black text-white">{countdown}</span>
      ) : (
        <span className={`text-5xl font-black ${c.text}`}>{c.label}</span>
      )}
    </div>
  );
}
