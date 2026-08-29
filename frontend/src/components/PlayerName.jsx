import Avatar from './Avatar';

/**
 * A player's picture next to their name.
 *
 * Every place a name appears during a match — the countdown, the two names
 * over a Blackjack or Word VS board, the win/loss/draw/forfeit card, the
 * notifications — was text only. A player uploads a picture and then never
 * sees it, or anyone else's, in the one place they are actually looking at
 * another player.
 *
 * One component so those places cannot drift, and so the layout question
 * ("does it fit?") is answered once: the row never wraps, the name truncates
 * rather than pushing the picture off, and the picture never shrinks. That is
 * what keeps it working in a 120px cell on a phone.
 */
export default function PlayerName({
  username,
  avatarUrl,
  color = '#1250B4',
  isBot = false,
  size = 'w-6 h-6',
  textClassName = '',
  className = '',
  reverse = false,          // picture on the right, for a right-aligned name
}) {
  const pic = (
    <Avatar
      username={username}
      avatarUrl={avatarUrl}
      color={color}
      isBot={isBot}
      className={size}
      textClassName="text-[10px]"
    />
  );
  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 max-w-full ${reverse ? 'flex-row-reverse' : ''} ${className}`}>
      {pic}
      <span className={`truncate min-w-0 ${textClassName}`}>{username}</span>
    </span>
  );
}
