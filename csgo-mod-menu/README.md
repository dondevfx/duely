# CS:GO Offline Mod Menu

A keybind-driven "mod menu" built entirely from CS:GO's built-in `sv_cheats 1`
console commands. No memory injection, no external process, no DLLs — just a
`.cfg` script, so it can't trigger VAC and only works on servers you control
(offline bot matches, LAN, or your own listen server).

## Install
1. Copy `modmenu.cfg` into:
   `<Steam>/steamapps/common/Counter-Strike Global Offensive/csgo/cfg/`
2. Launch CS:GO, start **Play > Offline with Bots**.
3. Open console (`~`) and run:
   ```
   exec modmenu
   ```
4. Use the F1–F12 binds (listed in-game console output and below).

## Binds
| Key | Effect |
|-----|--------|
| F1  | Toggle infinite ammo |
| F2  | Toggle noclip |
| F3  | Toggle god mode |
| F4  | Toggle low gravity |
| F5  | Toggle speed boost (timescale 1.5x, affects whole game) |
| F6  | Give grenades + defuser + armor |
| F7  | Give AK-47, AWP, Deagle |
| F8  | Max money + armor |
| F9  | Toggle slow-motion (timescale 0.3x) |
| F10 | Instant respawn on death + buy anywhere |
| F11 | Long rounds, no freeze time |
| F12 | Reset everything to default |

## Why this approach instead of an overlay/injector
- Works immediately, survives game updates (it's just console commands Valve ships).
- Zero risk of a VAC flag — these are sanctioned dev/cheat commands gated
  behind `sv_cheats 1`, which Valve already disables on any server you don't
  control.
- An external memory-reading overlay (ESP/aimbot) is fragile, breaks every
  patch, and is the actual category of tool VAC and game ToS target — not
  something to build even for offline use.

## Customizing
Open `modmenu.cfg` in a text editor and tweak values, e.g. change
`sv_gravity 200` to a different number, or rebind keys by changing the
`bind "F1" ...` lines to any other key.
