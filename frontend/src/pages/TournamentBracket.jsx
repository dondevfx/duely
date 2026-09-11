import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useShowBottomBar } from '../components/BottomNav';
import { useGameScrollLock } from '../hooks/useGameScrollLock';
import Avatar from '../components/Avatar';
import Bracket from '../components/Bracket';
import { fmt as fmtClock } from '../components/TournamentClock';
import TournamentDraw from './TournamentDraw';
import { api } from '../utils/api';
import { getSudden } from '../hooks/tournamentSuddenStore';

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
  // Pinned, like a game is.
  //
  // The bracket is where a player waits, and waiting means scrolling around.
  // Whatever offset they left it at was still there when the round started and
  // dropped them into a game — so the board arrived half off the screen, on a
  // screen they had no reason to think they had moved. Nothing here is taller
  // than the viewport, so there is nothing to lose by pinning it; the second
  // argument re-pins on every change of phase, which is what carries the fix
  // through filling -> playing -> the next round.

  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);
  // The round about to start: { round, game, at }. Present only between
  // rounds, which is exactly when the draw is worth showing.
  const [drawing, setDrawing] = useState(null);
  // Seeded from the store: a draw decided at the deadline sends the player here
  // from the game screen a moment AFTER sudden death was announced, and a
  // banner that only listened would never show it.
  const [sudden, setSudden] = useState(() => getSudden(id));
  const { state: navState } = useLocation();
  // What every match in the round currently reads, sampled by the server.
  // The bracket a knocked-out player is watching has to move.
  const [scores, setScores] = useState(null);
  const [roundEnds, setRoundEnds] = useState(null);
  const [roundSudden, setRoundSudden] = useState(false);
  const [now, setNow] = useState(Date.now());
  const navRef = useRef(navigate);
  navRef.current = navigate;

  const me = session?.user?.id || null;

  // ── A match handed over from the game screen ─────────────────────────────
  // The sudden-death replay arrives while the player is still on the game they
  // drew. That screen cannot restart itself, so it sends the match here and
  // this sends them straight on into it — the same route every other match
  // takes, which is what mounts the game fresh.
  useEffect(() => {
    const m = navState?.pending;
    if (!m?.game || !m?.roomId) return;
    navRef.current(`/game/${m.game}`, {
      replace: true,
      state: { tournament: { ...m, poolId: id, sudden: !!m.sudden } },
    });
  }, [navState, id]);

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

        // A seat given up is a seat gone.
        //
        // Refreshing while waiting for a bracket to fill takes the seat back
        // and refunds the entry — that is what leaving means, and a refresh is
        // indistinguishable from leaving. What used to happen next is that the
        // screen reloaded, found the pool still filling with other people in
        // it, and showed the waiting room as though the seat were still held.
        // The lobby is where somebody with no seat belongs.
        if (me && p.state === 'filling' && !p.players.some(x => x.userId === me)) {
          navRef.current('/tournaments', { replace: true });
          return;
        }

        setPool(p);
        setError(null);
      } catch (e) {
        // A 404 means it is genuinely gone; anything else is the network, and
        // saying "lost contact" to someone whose tournament simply ended is a
        // different and more alarming thing than what happened.
        // 410: they left a running tournament and are out of it. There is
        // nothing to watch and no way back in, so they are not left sitting on
        // a bracket that says otherwise.
        if (e?.status === 410 || e?.data?.kicked) {
          if (alive) navRef.current('/tournaments', { replace: true });
          return;
        }
        if (alive) {
          setError(e?.status === 404
            ? 'That tournament has finished or never started.'
            : 'Lost contact with the tournament.');
        }
      }
      if (alive) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, me]);

  // ── The socket, on top of it ─────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const mine = (p) => !p?.poolId || p.poolId === id;

    const onUpdate = (p) => { if (p?.pool?.id === id) { setPool(p.pool); setError(null); } };
    const onRoundStarting = (p) => {
      if (!mine(p)) return;
      setSudden(null);
      setScores(null);        // last round's numbers are not this round's
      setRoundEnds(null);
      setRoundSudden(false);
      setDrawing({ round: p.round, game: p.game, at: p.at, reelAt: p.reelAt });
    };
    const onResult = (p) => { if (mine(p)) setSudden(null); };
    const onScores = (p) => {
      if (!mine(p)) return;
      setScores(p.scores);
      // The round's own clock, so the people waiting see the same
      // countdown as the people playing. A bracket in the middle of a
      // three-minute game otherwise looks like a bracket that stopped.
      setRoundEnds(p.endsAt || null);
      setRoundSudden(!!p.sudden);
    };
    const onSudden = (p) => { if (mine(p)) setSudden(p); };
    // The tournament ending sends everyone still here back to the lobby.
    //
    // This used to become a results screen of its own — the podium, again,
    // one screen after the result card had already shown the player where
    // they came and what they won. Two endings for one tournament, and the
    // second one arrived after they had stopped reading.
    const onOver = (p) => {
      if (!mine(p)) return;
      setDrawing(null);
      navRef.current('/tournaments', { replace: true });
    };
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
          // The whole payload, not a hand-picked copy of it.
          //
          // This used to list the fields one by one, so every field the server
          // added had to be added here too — and the first one that was not
          // was `pays`, what the final and the playoff are worth. The server
          // sent it, this dropped it, and the result card had nothing to show
          // a champion. A screen that forwards a message should forward the
          // message.
          tournament: { ...m, poolId: id, sudden: !!m.sudden },
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

  useGameScrollLock(true, `${pool?.state ?? 'load'}:${pool?.phase ?? ''}:${pool?.round ?? ''}`);

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

  // Where this player stands, which is the first thing they look for.
  const myMatch = !filling && pool.bracket
    ? (pool.bracket[pool.round] || []).findIndex(m => m.a === me || m.b === me)
    : -1;
  const knockedOut = !filling && me && myMatch === -1;

  // Its own screen, not a panel on this one. Everything below — the heading,
  // the bracket, the seats — is what you come back to afterwards.
  if (drawn) {
    return (
      <TournamentDraw
        round={drawn.round}
        rounds={rounds}
        game={drawn.game}
        games={ALL_GAMES}
        reelAt={drawn.reelAt}
        at={drawn.at}
        entryFee={pool.entryFee}
      />
    );
  }

  return (
    <div className="w-full max-w-lg animate-slide-up pt-4 sm:pt-6">
      <div className="text-center mb-4">
        <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold">
          {filling ? 'Waiting for players'
            : roundName(pool.round, rounds)}
        </div>
        <div className="text-3xl sm:text-4xl font-black text-white leading-tight">
          {filling
            ? `${pool.players.length} / ${pool.size}`
            : game ? titleOf(game)
            : ' '}
        </div>
        <div className="text-xs text-muted mt-1">
          {pool.entryFee} coin entry
          {filling && seatsLeft > 0 && ` · ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left`}
        </div>

        {/* What the round has left to run, directly under the entry line.
            Only while one is being played — between rounds there is nothing to
            count, and the people waiting here see the same clock as the people
            in the games. */}
        {roundEnds && roundEnds > now && (
          <div className="mt-1.5 flex items-center justify-center gap-2">
            {roundSudden && (
              <span className="text-[0.5rem] font-black uppercase tracking-widest text-danger">
                Sudden death
              </span>
            )}
            <span className="text-[0.625rem] uppercase tracking-widest text-muted font-bold">
              Round ends in
            </span>
            <span className="font-mono font-black tabular-nums text-lg leading-none"
                  style={{ color: roundEnds - now <= 30000 ? '#F87171' : '#FFFFFF' }}>
              {fmtClock(roundEnds - now)}
            </span>
          </div>
        )}
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
          {/* The two players in it get the same countdown and button the
              result card has — they land here instead of on a card when the
              draw was decided at the deadline. */}
          {me && sudden.players?.includes(me) && sudden.startsAt > now && (
            <>
              <div className="my-1 text-4xl font-black text-white tabular-nums">
                {Math.max(0, Math.ceil((sudden.startsAt - now) / 1000))}
              </div>
              <button
                onClick={() => socket?.emit('tournament_sudden_ready', { poolId: id })}
                className="w-full mt-1 py-2.5 rounded-xl font-black text-sm bg-primary text-white hover:bg-blue-500 transition-all"
              >
                Play sudden death
              </button>
            </>
          )}
        </div>
      )}

      {filling ? (
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
                    {/* avatarUrl and className, which are the props this
                        component actually takes. It was being handed `url`
                        and `size`, so every seat in the lobby — bots and real
                        players alike — fell back to a bare initial with no
                        picture and no colour. */}
                    <Avatar username={p.username} avatarUrl={p.avatarUrl}
                            color={p.profileColor || '#1250B4'}
                            className="w-8 h-8" textClassName="text-[0.625rem]" />
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


      {knockedOut && (
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
