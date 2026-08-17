/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // md drops from Tailwind's default 768px to 720px so it catches the iPad
      // Mini, which is 744pt wide in portrait and was the one iPad still falling
      // into the phone layout after the shell moved to md:.
      //
      // Nothing else meaningful lives in 720-767: a phone in landscape is
      // already 844pt or wider, so it was getting md: before this change too.
      screens: {
        md: '720px',
      },
      colors: {
        bg:           '#000000',
        surface:      '#0D0D0D',
        surfaceLight: '#1A1A1A',
        border:       '#222222',
        primary:      '#1250B4',
        accent:       '#00BFFF',
        muted:        '#6B7280',
        danger:       '#EF4444',
        success:      '#22C55E',
        warning:      '#EAB308',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        glow:         '0 0 20px rgba(18,80,180,0.45)',
        'glow-lg':    '0 0 40px rgba(18,80,180,0.65)',
        'glow-accent':'0 0 20px rgba(0,191,255,0.45)',
        'glow-green': '0 0 20px rgba(34,197,94,0.45)',
        'glow-red':   '0 0 20px rgba(239,68,68,0.45)',
        'glow-yellow':'0 0 20px rgba(234,179,8,0.45)',
      },
      animation: {
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'fade-in':    'fadeIn 0.3s ease-out',
        'slide-up':   'slideUp 0.4s ease-out',
        'scale-in':   'scaleIn 0.2s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
      },
      keyframes: {
        pulseGlow: {
          '0%,100%': { boxShadow: '0 0 20px rgba(18,80,180,0.45)' },
          '50%':     { boxShadow: '0 0 40px rgba(18,80,180,0.9)' },
        },
        fadeIn:        { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp:       { from: { transform: 'translateY(20px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } },
        scaleIn:       { from: { transform: 'scale(0.95)', opacity: 0 }, to: { transform: 'scale(1)', opacity: 1 } },
        slideInRight:  { from: { transform: 'translateX(20px)', opacity: 0 }, to: { transform: 'translateX(0)', opacity: 1 } },
      },
    },
  },
  plugins: [],
};
