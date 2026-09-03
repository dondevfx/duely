import ShareLinkButton from './ShareLinkButton';

// Shows the shareable challenge link (primary) with the raw room code as a
// fallback. Used on every game's "waiting for opponent" screen.
//
// Goes through ShareLinkButton so mobile gets the device's own share sheet —
// Messages, WhatsApp, Instagram, AirDrop, whatever they have — instead of a
// silent clipboard copy they then have to paste somewhere themselves. Desktop
// has no navigator.share, so it still copies.
// Keyed by the gameType each page actually passes, which is the same slug that
// goes into the /challenge/:gameType/:code URL — note Coin Flip uses a hyphen
// while the others are camelCase. A miss just falls back to a generic message.
const GAME_NAMES = {
  carDash: 'Rush Hour',
  colorRush: 'Color Rush',
  tower: 'Tower',
  blockBlast: 'Block Burst',
  scrabble: 'Word VS',
  blackjack: 'Blackjack',
  'coin-flip': 'Coin Flip',
};

export default function ChallengeLinkBox({ code, gameType }) {
  if (!code) return null;

  const link = `${window.location.origin}/challenge/${gameType}/${code}`;
  const game = GAME_NAMES[gameType];

  return (
    <div className="mb-6">
      <p className="text-muted mb-3 text-sm">Send this link to a friend — they tap it and join you.</p>

      <ShareLinkButton
        link={link}
        noun="Invite Link"
        title={game ? `Duely — ${game}` : 'Duely'}
        text={game ? `1v1 me on ${game} 🎮` : '1v1 me on Duely 🎮'}
        className="mb-4"
      />

      {/* The code is the fallback for anyone who can't take a link at all —
          read it out, type it into Join Room. The full URL is not printed
          here; the button carries it, and ShareLinkButton reveals it if the
          clipboard is ever blocked. */}
      <div className="text-xs text-muted">
        or share the code:{' '}
        <span className="font-mono font-black tracking-[0.2em] text-primary text-sm select-all">{code}</span>
      </div>
    </div>
  );
}
