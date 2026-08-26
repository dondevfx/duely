/**
 * One player avatar, everywhere.
 *
 * This exists because the same circle was hand-written in twelve places —
 * navbar, sidebar, chat messages, the chat profile popup, leaderboard rows
 * and podium, admin lists and panel, profile header. When profile pictures
 * were added only two of those learned to show one, so a player uploaded a
 * picture and saw it on their profile and nowhere else.
 *
 * The point is not to save lines. It is that the NEXT avatar location, and
 * the next thing an avatar has to show, changes here once instead of being
 * twelve chances to miss one.
 *
 * Falls back to the coloured initial when there is no picture — the default
 * state, not an error state, and still what most players will have.
 */
export default function Avatar({
  username,
  avatarUrl,
  color = '#1250B4',
  // Tailwind sizing classes, passed in rather than a size prop: the call
  // sites already vary (w-8 h-8 lg:w-10 lg:h-10, w-9 h-9, w-20 h-20) and a
  // fixed scale would not fit them.
  className = 'w-9 h-9',
  textClassName = 'text-sm',
  isBot = false,
  style,
  ...rest
}) {
  const ring = color || '#1250B4';

  return (
    <div
      className={`${className} rounded-full overflow-hidden flex items-center justify-center font-bold shrink-0 ${textClassName}`}
      style={{
        backgroundColor: `${ring}22`,
        border: `1.5px solid ${ring}`,
        color: ring,
        ...style,
      }}
      {...rest}
    >
      {isBot
        ? '🤖'
        : avatarUrl
          // object-cover, not contain: these are circles, and a
          // non-square upload letterboxed inside one looks broken.
          ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
          : (username?.[0]?.toUpperCase() ?? '?')}
    </div>
  );
}
