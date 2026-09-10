import Avatar from './Avatar';

/**
 * A knockout bracket that fits on a phone.
 *
 * The first attempt laid the rounds out as four columns of bordered cards,
 * each round the same height as the last. Sixteen players is eight matches in
 * the first column, so on a phone it was either too small to read or taller
 * than the screen — and because every match was its own box with its own
 * border, it read as a list of cards rather than as one bracket.
 *
 * Two things fix that.
 *
 * The rounds are drawn as CONNECTED pairs: each match is two stacked rows, and
 * the pair that feeds the next match is joined by a bracket line drawn in the
 * gutter between the columns. That is what makes it look like a bracket rather
 * than a table — the shape is in the connectors, not in the borders.
 *
 * Matches being played right now carry their live score. A bracket where
 * nothing moves for three minutes reads as a bracket that has stopped, and
 * the person most likely to be looking at it is someone who has just been
 * knocked out of it.
 *
 * And it scales itself. The whole thing is laid out in a fixed coordinate
 * space and drawn as SVG, so it fits the width it is given at any bracket size
 * without a horizontal scrollbar and without the rows shrinking below what can
 * be read. Sixteen players is the largest case and the one it is sized for.
 */

const ROW_H = 22;        // one player
const MATCH_GAP = 10;    // between matches in a round
const COL_W = 96;        // a round's column
const COL_GAP = 26;      // the gutter the connectors live in

export default function Bracket({ bracket, players, currentRound = 0, scores = null, className = '' }) {
  if (!bracket?.length) return null;

  const byId = new Map((players || []).map(p => [p.userId, p]));
  const liveScore = new Map();
  for (const s of scores || []) {
    if (s.a != null) liveScore.set(`${s.match}:a`, s.a);
    if (s.b != null) liveScore.set(`${s.match}:b`, s.b);
  }
  const rounds = bracket.length;
  const first = bracket[0].length;

  // Vertical middle of every match, per round. A match in round r sits halfway
  // between the two it came from, which is what makes the connectors meet.
  const centres = [];
  for (let r = 0; r < rounds; r++) {
    if (r === 0) {
      centres.push(bracket[0].map((_, i) => i * (ROW_H * 2 + MATCH_GAP) + ROW_H));
    } else {
      const prev = centres[r - 1];
      centres.push(bracket[r].map((_, i) => (prev[i * 2] + prev[i * 2 + 1]) / 2));
    }
  }

  const width = rounds * COL_W + (rounds - 1) * COL_GAP;
  const height = first * (ROW_H * 2 + MATCH_GAP) - MATCH_GAP;

  const name = (uid, m) => {
    if (uid) return byId.get(uid)?.username || '—';
    // A slot that is empty in a decided match was a bye, not a missing player.
    return m.winner ? 'bye' : '';
  };

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        // Scales to the width it is given. Capped so a 16-player bracket does
        // not become unreadably small on a narrow phone, and does not stretch
        // to absurd row heights on a desktop.
        style={{ maxHeight: '62vh' }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Bracket, round ${currentRound + 1} of ${rounds}`}
      >
        {/* Connectors first, so the rows sit on top of them. */}
        {bracket.slice(0, -1).map((round, r) => {
          const x = r * (COL_W + COL_GAP) + COL_W;
          const mid = x + COL_GAP / 2;
          return round.map((_, i) => {
            if (i % 2) return null;                     // drawn once per pair
            const top = centres[r][i];
            const bot = centres[r][i + 1];
            const next = centres[r + 1][i / 2];
            return (
              <path
                key={`c${r}-${i}`}
                d={`M${x} ${top} H${mid} V${bot} H${x} M${mid} ${next} H${x + COL_GAP}`}
                fill="none"
                stroke="#222"
                strokeWidth="1.5"
              />
            );
          });
        })}

        {bracket.map((round, r) => {
          const x = r * (COL_W + COL_GAP);
          return round.map((m, i) => {
            const c = centres[r][i];
            const live = r === currentRound && !m.winner && m.a && m.b;
            return (
              <g key={`m${r}-${i}`}>
                {['a', 'b'].map((side, k) => {
                  const uid = m[side];
                  const won = m.winner && m.winner === uid;
                  const out = m.winner && uid && m.winner !== uid;
                  const y = c - ROW_H + k * ROW_H;
                  const p = uid ? byId.get(uid) : null;
                  const score = live ? liveScore.get(`${i}:${side}`) : null;
                  return (
                    <g key={side}>
                      <rect
                        x={x} y={y + 1} width={COL_W} height={ROW_H - 2} rx="3"
                        fill={won ? 'rgba(18,80,180,0.28)' : '#0D0D0D'}
                        stroke={live ? '#1250B4' : '#1A1A1A'}
                        strokeWidth={live ? 1.2 : 1}
                      />
                      {p?.avatarUrl && (
                        <image href={p.avatarUrl} x={x + 3} y={y + 4} width="14" height="14"
                               clipPath="inset(0 round 7px)" preserveAspectRatio="xMidYMid slice" />
                      )}
                      {/* No picture uploaded: their colour and their initial,
                          which is what every other avatar on the site falls
                          back to. It was a flat dark circle here, so half a
                          bracket looked like empty seats rather than people. */}
                      {!p?.avatarUrl && uid && (
                        <>
                          <circle cx={x + 10} cy={y + 11} r="7" fill={p?.profileColor || '#1A1A1A'} />
                          <text x={x + 10} y={y + 14.5} fontSize="8" fontWeight={800}
                                textAnchor="middle" fill="#FFFFFF">
                            {(p?.username || '?').charAt(0).toUpperCase()}
                          </text>
                        </>
                      )}
                      <text
                        x={x + (uid ? 21 : 6)} y={y + 15}
                        fontSize="9.5"
                        fontWeight={won ? 700 : 500}
                        fill={won ? '#FFFFFF' : out ? '#4B5563' : uid ? '#D1D5DB' : '#374151'}
                        style={out ? { textDecoration: 'line-through' } : undefined}
                      >
                        {clip(name(uid, m), live && score != null ? 7 : 11)}
                      </text>
                      {/* Right-aligned so the two in a match line up as a
                          scoreline rather than trailing their names. */}
                      {live && score != null && (
                        <text
                          x={x + COL_W - 4} y={y + 15}
                          fontSize="9.5" fontWeight={700} textAnchor="end"
                          fill="#7FB0FF"
                        >
                          {score}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          });
        })}
      </svg>
    </div>
  );
}

// SVG text does not wrap or ellipsise, so a long name would run across the
// next column. Trimmed to what the column holds.
function clip(s, n) {
  const v = String(s || '');
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}
