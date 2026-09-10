import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useShowBottomBar } from '../components/BottomNav';
import Avatar from '../components/Avatar';
import Bracket from '../components/Bracket';
import GameDraw from '../components/GameDraw';
import { api } from '../utils/api';

/**
 * The screen a player waits on: who is in, how the bracket stands, and what
 * is being played next.
 *
 * Three states, one screen. While the pool is filling it is a lobby — the
 * seats taken so far, and how many are left. Between rounds it is the draw and
 * the bracket. During a round it is the bracket, with the matches still being
 * played marked. Keeping them as one screen means the player is never moved
 * anywhere: the same faces are rearranged into pairs, and then into results.
 *
 * Live over the socket, with the poll kept underneath it. The socket carries
 * everything as it happens; the poll is what makes a reload, a slept tab or a
 * dropped connection catch up on its own rather than showing a bracket frozen
 * at whatever it last heard.
 */
export default function TournamentBracket() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const { socket } = useSocket();
  useShowBottomBar(true);

  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);
  // The round about to start: { round, game, at }. Present only between
  // rounds, which is exactly when the draw is worth showing.
  const [drawing, setDrawing] = useState(null);
  const [sudden, setSudden] = useState(null);
  // What every match in the round currently reads, sampled by the server.
  // The bracket a knocked-out player is watching has to move.
  const [scores, setScores] = useState(null);
  const [over, setOver] = useState(null);
  const [now, setNow] = useState(Date.now());
  const navRef = useRef(navigate);
  navRef.current = navigate;

  const me = session?.user?.id || null;

  // ── The poll, underneath everything ──────────────────────────────────────
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
        setError(null);
      } catch (e) {
        // A 404 means it is genuinely gone; anything else is the network, and
        // saying "lost contact" to someone whose tournament simply ended is a
        // different and more alarming thing than what happened.
        if (alive && !over) {
          setError(e?.status === 404
            ? 'That tournament has finished or never started.'
            : 'Lost contact with the tournament.');
        }
      }
      if (alive) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, over]);

  // ── The socket, on top of it ─────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const mine = (p) => !p?.poolId || p.poolId === id;

    const onUpdate = (p) => { if (p?.pool?.id === id) { setPool(p.pool); setError(null); } };
    const onRoundStarting = (p) => {
      if (!mine(p)) return;
      setSudden(null);
      setScores(null);        // last round's numbers are not this round's
      setDrawing({ round: p.round, game: p.game, at: p.at });
    };
    const onResult = (p) => { if (mine(p)) setSudden(null); };
    const onScores = (p) => { if (mine(p)) setScores(p.scores); };
    const onSudden = (p) => { if (mine(p)) setSudden(p); };
    const onOver = (p) => { if (mine(p)) { setDrawing(null); setOver(p); } };
    const onCancelled = (p) => {
      if (!mine(p)) return;
      setError(p?.reason || 'That tournament was cancelled and your entry returned.');
    };

    // The one event that moves the player off this screen. The game screen
    // reports in when it has mounted; see useTournamentRound.
    const onMatch = (m) => {
      if (!mine(m) || !m?.game || !m?.roomId) return;
      setDrawing(null);
      navRef.current(`/game/${m.game}`, {
        state: {
          tournament: {
            poolId: id, roomId: m.roomId, round: m.round, match: m.match,
            game: m.game, deadline: m.deadline, sudden: !!m.sudden,
            opponent: m.opponent,
          },
        },
      });
    };

    socket.on('tournament_update', onUpdate);
    socket.on('tournament_round_starting', onRoundStarting);
    socket.on('tournament_result', onResult);
    socket.on('tournament_scores', onScores);
    socket.on('tournament_sudden_death', onSudden);
    socket.on('tournament_over', onOver);
    socket.on('tournament_cancelled', onCancelled);
    socket.on('tournament_match', onMatch);
    return () => {
      socket.off('tournament_update', onUpdate);
      socket.off('tournament_round_starting', onRoundStarting);
      socket.off('tournament_result', onResult);
      socket.off('tournament_scores', onScores);
      socket.off('tournament_sudden_death', onSudden);
      socket.off('tournament_over', onOver);
      socket.off('tournament_cancelled', onCancelled);
      socket.off('tournament_match', onMatch);
    };
  }, [socket, id]);

  // One ticking clock for the whole screen rather than one per countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const byId = useMemo(() => {
    const m = new Map();
    for (const p of pool?.players || []) m.set(p.userId, p);
    return m;
  }, [pool]);

  if (error && !pool) {
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
  const rounds = pool.rounds ?? 4;

  // The draw comes from the socket when it can and from the pool when it
  // cannot.
  //
  // `tournament_round_starting` fires the instant the round is scheduled,
  // which for a bot bracket is the instant the player is still navigating here
  // from the bet screen — so it is missed, and missed for good. The pool
  // carries the same fact, so a screen that arrived late still shows the draw
  // instead of sitting on a bracket that never changes.
  const drawn = drawing?.round === pool.round
    ? drawing
    : pool.phase === 'intermission' && pool.roundGames?.[pool.round]
      ? { round: pool.round, game: pool.roundGames[pool.round], at: pool.nextRoundAt }
      : null;

  // Named only once the round is actually being played. The server does not
  // send a round's game before it is drawn, so there is nothing here to leak.
  const game = pool.phase === 'playing' ? pool.roundGames?.[pool.round] : null;
  const startsIn = drawn?.at ? Math.max(0, drawn.at - now) : 0;

  // Where this player stands, which is the first thing they look for.
  const myMatch = !filling && pool.bracket
    ? (pool.bracket[pool.round] || []).findIndex(m => m.a === me || m.b === me)
    : -1;
  const knockedOut = !filling && me && myMatch === -1 && !over;

  return (
    <div className="w-full max-w-lg animate-slide-up pt-4 sm:pt-6">
      <div className="text-center mb-4">
        <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold">
          {over ? 'Finished'
            : filling ? 'Waiting for players'
            : roundName(pool.round, rounds)}
        </div>
        <div className="text-3xl sm:text-4xl font-black text-white leading-tight">
          {filling
            ? `${pool.players.length} / ${pool.size}`
            : over ? 'Results'
            : drawing ? ' '
            : titleOf(game)}
        </div>
        <div className="text-xs text-muted mt-1">
          {pool.entryFee} coin entry
          {filling && seatsLeft > 0 && ` · ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left`}
        </div>
      </div>

      {sudden && (
        // A draw does not stop a knockout. Said plainly, because the players
        // in it are about to be sent straight back into a game.
        <div className="mb-3 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-center">
          <div className="text-xs font-black uppercase tracking-widest text-primary">Sudden death</div>
          <div className="text-xs text-muted mt-0.5">
            {[sudden.players?.[0], sudden.players?.[1]].map(u => byId.get(u)?.username || '—').join(' vs ')}
            {' · '}{sudden.seconds}s
          </div>
        </div>
      )}

      {over ? (
        <Podium awards={over.awards || []} free={over.free} me={me} />
      ) : drawn ? (
        <>
          {/* The reel runs through every game a tournament can draw, not just
              the ones already played — the point is not knowing which. */}
          <GameDraw game={drawn.game} games={ALL_GAMES} />
          <p className="text-center text-xs text-muted">
            {roundName(drawn.round, rounds)} starts in {Math.ceil(startsIn / 1000)}s
          </p>
          <div className="mt-4 opacity-60">
            <Bracket bracket={pool.bracket} players={pool.players} currentRound={pool.round} />
          </div>
        </>
      ) : filling ? (
        // The lobby: everyone in so far, and the empty seats, so the screen
        // shows the pool filling rather than a list that silently grows.
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {Array.from({ length: pool.size }).map((_, i) => {
            const p = pool.players[i];
            return (
              <div key={i}
                   className={`rounded-xl border p-2 flex flex-col items-center gap-1 ${
                     p ? 'bg-surface border-border animate-slide-up' : 'bg-bg border-border/50 border-dashed'
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
          scores={scores}
        />
      )}

      <p className="mt-4 text-center text-xs text-muted">
        {over ? (over.free ? 'A practice bracket — nothing was staked.' : 'Prizes have been paid into your balance.')
          : filling ? 'The bracket is drawn as soon as the last seat is taken.'
          : knockedOut ? 'You are out of this one. It plays on — this screen follows along.'
          : 'Rounds play automatically. You will be taken into your game when it starts.'}
      </p>

      {(over || knockedOut) && (
        <div className="mt-4 text-center">
          <button onClick={() => navigate('/tournaments')}
                  className="px-5 py-2.5 rounded-xl bg-primary text-white font-bold">
            Back to tournaments
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * First in the middle and largest, second to its left, third to its right —
 * the same arrangement as the bet screen, so the two read as one thing.
 */
function Podium({ awards, free, me }) {
  const by = (place) => awards.find(a => a.place === place) || null;
  const order = [by(2), by(1), by(3)];
  return (
    <div className="grid grid-cols-3 gap-2 items-end">
      {order.map((a, i) => {
        const first = i === 1;
        if (!a) return <div key={i} />;
        return (
          <div key={a.userId}
               className={`rounded-2xl border p-3 text-center ${
                 first ? 'bg-primary/10 border-primary/40 py-5' : 'bg-surface border-border'
               } ${a.userId === me ? 'ring-1 ring-primary' : ''}`}>
            <div className="text-[0.625rem] uppercase tracking-widest text-muted font-bold">
              {a.place === 1 ? '1st' : a.place === 2 ? '2nd' : '3rd'}
            </div>
            <div className={`font-black text-white truncate ${first ? 'text-lg' : 'text-sm'}`}>
              {a.username}
            </div>
            {!free && (
              <div className={`font-black text-primary ${first ? 'text-2xl' : 'text-base'}`}>
                {a.amount}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function roundName(index, total) {
  const fromEnd = total - index;
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semi-finals';
  if (fromEnd === 3) return 'Quarter-finals';
  return `Round ${index + 1}`;
}

const ALL_GAMES = ['block-blast', 'car-dash', 'color-rush', 'tower', 'scrabble'];

const TITLES = {
  'block-blast': 'Block Burst',
  'car-dash': 'Rush Hour',
  'color-rush': 'Color Rush',
  tower: 'Tower',
  scrabble: 'Word VS',
};
const titleOf = (slug) => TITLES[slug] || slug || '';
