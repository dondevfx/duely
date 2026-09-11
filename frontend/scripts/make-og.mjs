// Share images: one 1200x630 card per game, made from its poster.
//
// Run by hand when a poster changes (needs ffmpeg on PATH):
//   node scripts/make-og.mjs
// Output is committed under public/og/, so the build does not need ffmpeg.
//
// The card is the site's own look — black, the game's frame on the right, its
// name and the address on the left — so a shared link reads as Duely, and the
// poster is the same still the home grid shows for that game.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clips = join(root, 'public', 'game-clips');
const out = join(root, 'public', 'og');
mkdirSync(out, { recursive: true });

const CARDS = [
  ['tournament',  'Tournaments', '16 players · 4 rounds'],
  ['block-blast', 'Block Burst', '1v1 block puzzle'],
  ['color-rush',  'Color Rush',  '1v1 colour reaction'],
  ['car-dash',    'Rush Hour',   '1v1 highway dodge'],
  ['coin-flip',   'Coin Flip',   'Heads or tails, 1v1'],
  ['tower',       'Tower',       '1v1 block stacking'],
  ['scrabble',    'Word VS',     '1v1 word guessing'],
  ['blackjack',   'Blackjack',   'Head-to-head 21'],
];

// ffmpeg's filter syntax needs the drive colon escaped.
const FONT = process.platform === 'win32'
  ? 'C\\:/Windows/Fonts/arialbd.ttf'
  : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const text = (s) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019");

for (const [slug, title, tag] of CARDS) {
  const poster = join(clips, `${slug}.jpg`);
  if (!existsSync(poster)) { console.warn(`skip ${slug}: no poster`); continue; }
  const filter = [
    // The poster, square-ish, filling the right-hand side with a margin.
    `[1:v]scale=-1:560[p]`,
    `[0:v][p]overlay=W-w-40:35[bg]`,
    `[bg]drawtext=fontfile='${FONT}':text='${text(title)}':fontcolor=white:fontsize=78:x=64:y=210`,
    `drawtext=fontfile='${FONT}':text='${text(tag)}':fontcolor=0x5E9BEE:fontsize=38:x=66:y=310`,
    `drawtext=fontfile='${FONT}':text='Duely':fontcolor=0x1250B4:fontsize=54:x=64:y=64`,
    `drawtext=fontfile='${FONT}':text='www.duely.us':fontcolor=0x9CA3AF:fontsize=30:x=66:y=540`,
  ].join(';').replace(/;drawtext/g, ',drawtext');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=1200x630',
    '-i', poster,
    '-filter_complex', filter,
    '-frames:v', '1', '-q:v', '3',
    join(out, `${slug}.jpg`),
  ]);
  console.log(`og/${slug}.jpg`);
}
