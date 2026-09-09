import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useShowBottomBar } from '../components/BottomNav';
import Avatar from '../components/Avatar';
import GameIcon from '../components/GameIcon';
import Bracket from '../components/Bracket';
import { api } from '../utils/api';

/**
 * The screen a player waits on: who is in, and how the bracket stands.
 *
 * Two states, one screen. While the pool is filling it is a lobby — the seats
 * taken so far, and how many are left. Once it starts it is the bracket, with
 * the current round marked and results filling in behind it. Keeping them as
 * one screen means the player is not moved anywhere when it begins; the same
 * faces are simply arranged into pairs.
 *
 * Polled rather than pushed, for now. A socket is the right answer for the
 * live rounds and will replace this, but polling is honest about what exists
 * today and does not pretend to a liveness it does not have.
 */
export default function TournamentBracket() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  useShowBottomBar(true);

  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    let timer = null;

    const tick = async () => {
      try {
        // Through the shared client, not a bare relative fetch.
        //
        // VITE_API_URL points the app at the backend's own host; a hardcoded
        // "/api/..." asks the site that served the page, which has no such
        // route. That is the whole of "Lost contact with the tournament" — the
        // request 404'd on the wrong host every time.
        const { pool: p } = await api.get(`/tournaments/${id}`);
        if (!alive) return;
        if (!p) { setError('That tournament has finished or never started.'); return; }
        setPool(p);
      } catch (e) {
        // A 404 means it is genuinely gone; anything else is the network, and
        // saying "lost contact" to someone whose tournament simply ended is a
        // different and more alarming thing than what happened.
        if (alive) {
          setError(e?.status === 404
            ? 'That tournament has finished or never started.'
            : 'Lost contact with the tournament.');
        }
      }
      if (alive) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id]);

  const byId = useMemo(() => {
    const m = new Map();
    for (const p of pool?.players || []) m.set(p.userId, p);
    return m;
  }, [pool]);

  if (error) {
    return (
      <div className="w-full max-w-md animate-slide-up pt-6 text-center">
        <p className="text-muted mb-4">{error}</p>
        <button onClick={() => navigate('/tournaments')}
                className="px-5 py-2.5 rounded-xl bg-primary text-white font-bold">
          Back to tournaments
        </button>
      </div>
    );
  }

  if (!pool) {
    return <div className="w-full max-w-md pt-6 text-center text-muted">Loading…</div>;
  }

  const filling = pool.state === 'filling';
  const seatsLeft = pool.size - pool.players.length;
  // Not while it is still filling. The round's game is drawn when the round
  // starts, and naming it on the waiting screen tells everyone what is coming
  // before the bracket even exists.
  const game = filling ? null : pool.roundGames?.[pool.round];

  return (
    <div className="w-full max-w-lg animate-slide-up pt-4 sm:pt-6">
      <div className="text-center mb-4">
        <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold">
          {filling ? 'Waiting for players' : `Round ${pool.round + 1} of ${pool.roundGames?.length ?? 4}`}
        </div>
        <div className="text-3xl sm:text-4xl font-black text-white leading-tight">
          {filling
            ? `${pool.players.length} / ${pool.size}`
            : game
              ? <span className="inline-flex items-center gap-2">
                  <GameIcon game={game} size={28} />{titleOf(game)}
                </span>
              : 'Drawing the game…'}
        </div>
        <div className="text-xs text-muted mt-1">
          {pool.entryFee} coin entry
          {filling && seatsLeft > 0 && ` · ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left`}
        </div>
      </div>

      {filling ? (
        // The lobby: everyone in so far, and the empty seats, so the screen
        // shows the pool filling rather than a list that silently grows.
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {Array.from({ length: pool.size }).map((_, i) => {
            const p = pool.players[i];
            return (
              <div key={i}
                   className={`rounded-xl border p-2 flex flex-col items-center gap-1 ${
                     p ? 'bg-surface border-border' : 'bg-bg border-border/50 border-dashed'
                   }`}>
                {p ? (
                  <>
                    <Avatar username={p.username} url={p.avatarUrl} size={32} />
                    <span className="text-[0.625rem] text-white truncate w-full text-center">
                      {p.username}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="w-8 h-8 rounded-full bg-surfaceLight/40" />
                    <span className="text-[0.625rem] text-muted">…</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        // One drawn bracket rather than columns of bordered cards. See
        // components/Bracket.jsx for why: the shape is in the connectors.
        <Bracket
          bracket={pool.bracket}
          players={pool.players}
          currentRound={pool.round}
        />
      )}

      <p className="mt-4 text-center text-xs text-muted">
        {filling
          ? 'The bracket is drawn as soon as the last seat is taken.'
          : 'Rounds play automatically. This screen follows along.'}
      </p>
    </div>
  );
}

function roundName(index, total) {
  const fromEnd = total - index;
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semis';
  if (fromEnd === 3) return 'Quarters';
  return `Round ${index + 1}`;
}

const TITLES = {
  'block-blast': 'Block Burst',
  'car-dash': 'Rush Hour',
  'color-rush': 'Color Rush',
  tower: 'Tower',
  scrabble: 'Word VS',
};
const titleOf = (slug) => TITLES[slug] || slug || '';
