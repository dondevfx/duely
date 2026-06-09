const fs = require("fs");
const path = require("path");
const cp1252 = {
  0x80:0x20AC,0x81:0x0081,0x82:0x201A,0x83:0x0192,0x84:0x201E,
  0x85:0x2026,0x86:0x2020,0x87:0x2021,0x88:0x02C6,0x89:0x2030,
  0x8A:0x0160,0x8B:0x2039,0x8C:0x0152,0x8D:0x008D,0x8E:0x017D,
  0x8F:0x008F,0x90:0x0090,0x91:0x2018,0x92:0x2019,0x93:0x201C,
  0x94:0x201D,0x95:0x2022,0x96:0x2013,0x97:0x2014,0x98:0x02DC,
  0x99:0x2122,0x9A:0x0161,0x9B:0x203A,0x9C:0x0153,0x9D:0x009D,
  0x9E:0x017E,0x9F:0x0178
};
const rev = {};
for(const [b,cp] of Object.entries(cp1252)) rev[cp] = parseInt(b);
for(let i=0;i<=0x7F;i++) rev[i]=i;
for(let i=0xA0;i<=0xFF;i++) rev[i]=i;

function fix(file){
  let s = fs.readFileSync(file,"utf8");
  if(s.charCodeAt(0)===0xFEFF) s=s.slice(1); // strip BOM
  const bytes=[];
  for(let i=0;i<s.length;i++){
    const cp=s.codePointAt(i);
    if(cp>0xFFFF)i++; // skip low surrogate
    const b=rev[cp];
    if(b!==undefined){
      bytes.push(b);
    } else {
      // Char not in CP1252 – write as UTF-8 (shouldn't happen in these files)
      for(const x of Buffer.from(String.fromCodePoint(cp),"utf8")) bytes.push(x);
    }
  }
  fs.writeFileSync(file, Buffer.from(bytes).toString("utf8"), "utf8");
}

const dir = "e:\\C1v1\\frontend\\src\\pages";
const files = [
  "AimGame.jsx","AsteroidsGame.jsx","BlockBlastGame.jsx","CheckersGame.jsx",
  "ChessGame.jsx","ClickRace.jsx","ConnectFour.jsx","CrossroadGame.jsx",
  "DartGame.jsx","GalagaGame.jsx","Game.jsx","Game2048.jsx","MemoryGame.jsx",
  "PianoGame.jsx","RockPaperScissors.jsx","SnakeGame.jsx","StarshipGame.jsx",
  "TetrisGame.jsx","TicTacToe.jsx","TypeGame.jsx","UnoGame.jsx"
];

for(const f of files){
  try { fix(path.join(dir,f)); console.log("Fixed:",f); }
  catch(e) { console.error("Error:",f,e.message); }
}
console.log("Done.");
