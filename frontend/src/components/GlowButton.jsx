export default function GlowButton({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled = false,
  className = '',
  type = 'button',
}) {
  const base = 'font-semibold rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary: 'bg-primary hover:bg-blue-500 text-white shadow-glow hover:shadow-glow-lg focus:ring-primary',
    accent: 'bg-accent hover:bg-sky-400 text-bg shadow-glow-accent hover:shadow-glow-lg focus:ring-accent',
    outline: 'border border-primary text-primary hover:bg-primary hover:text-white focus:ring-primary',
    danger: 'bg-danger hover:bg-red-600 text-white shadow-glow-red focus:ring-danger',
    success: 'bg-success hover:bg-green-600 text-white shadow-glow-green focus:ring-success',
    ghost: 'text-muted hover:text-white hover:bg-surfaceLight focus:ring-primary',
  };

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-5 py-2.5 text-sm',
    lg: 'px-7 py-3.5 text-base',
    xl: 'px-10 py-4 text-lg',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}
