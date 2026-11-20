# Clarcade

Two-player Caro (Gomoku) on your LAN, inside Claude Code, while your agents work. No internet, no external server and no npm dependencies. Each game runs in a background process on your machine, so it survives closing the pane, switching threads and reloading the mod.

## Features

- Public or private rooms (4–6 digit PIN). Join by invite link, by room name or from a list of rooms on your LAN.
- Two rule sets: **Freestyle** (the default; five or more in a row wins) and **Blocked ends** (a line blocked by the opponent at both ends does not win).
- The board grows with the game, up to ±100 cells on each axis.
- Undo requests, draw offers, resignation and rematches. The first player alternates between games.
- Room options: a per-move clock, a move limit and how long to hold the room when the opponent disconnects.
- Statistics overall and per opponent: wins, losses, draws, streaks, and splits by rule set and by X/O.
- English and Vietnamese interface.

## Requirements

| Component | Requirement |
|---|---|
| Claude Code | 2.1.319 or later. Playable in the terminal and in Claude Desktop. VS Code and mobile only show the room status |
| Operating system | macOS (tested). Linux is untested. Windows is not supported |
| Node.js | 22 or later |
| Perl | `/usr/bin/perl` with `flock` support. The launcher uses it to keep a single background process running |
| Network | Both machines on the same LAN. The firewall must allow UDP port 47979 and incoming TCP connections to Node |

If Clarcade cannot find Node, enter its absolute path in **Settings → Advanced → Absolute Node path** (for example `/opt/homebrew/bin/node`).

## Install

In a Claude Code session, run these commands **one at a time**. Add the marketplace first and wait for it to finish, then install the plugin:

```text
/plugin marketplace add DNDark12/clarcade
/plugin install clarcade@clarcade
```

Choose an install scope when prompted. From a terminal, use the equivalent commands:

```sh
claude plugin marketplace add DNDark12/clarcade
```

```sh
claude plugin install clarcade@clarcade
```

After installation, start a new Claude Code session and run `/clarcade`. The first time, the pane asks for your display name. That name is the only information about you sent over the network.

## How to play

### Create a room

1. Run `/clarcade` → **Create room**.
2. Enter a room name, choose the rules, public or private and the other options, then press **Create room**.
3. Press **Copy link** and send the `clarcade://j/K7M2QX` link to the other player.

If the other player cannot find the room (office Wi-Fi or a network that blocks multicast), use **Copy link with address**. That link looks like `clarcade://j/K7M2QX@192.168.1.20:51234` and connects straight to your machine.

### Join a room

There are three ways:

- **Paste the link** into the prompt. When the whole message is a single Clarcade link, the mod joins the room and the message is not sent to the model. A link inside a sentence is sent as usual.
- **Run** `/clarcade join <link>` or `/clarcade join <room name>`. A private room appears when you type its exact name, and the pane then asks for the PIN.
- **Find a LAN room** in the pane to list public rooms on your network. The list refreshes while the pane is open.

### Placing stones and moving around the board

- Click a cell to place a stone. The first move is always at the center.
- After clicking the board, use the arrow keys to move the cursor and `Enter` or `Space` to place a stone.
- `Shift` + arrow moves 5 cells, `C` jumps to the last move and `H` to the center. `Esc` returns the keyboard to the prompt.

### Blocked ends

`X` is the line being checked, `O` is the opponent and `.` is an empty cell. The board edge does not count as a block.

| Row | Result |
|---|---|
| `. X X X X X .` | Win |
| `O X X X X X .` | Win (blocked at one end only) |
| `O X X X X X O` | No win |
| `O X X X X X X .` | Win (six stones, one open end) |

### Disconnects and leaving

- When the opponent disconnects, the clock stops and the room is held for the time the host chose (5 minutes, 30 minutes or 2 hours). After that, the host can press **Wait longer** or **Claim win**.
- Leaving during a game while the opponent is connected counts as a loss, whether you are the host or the guest.

## Playing across threads

Each Claude Code thread loads its own copy of the mod, but all of them share one game in the background process.

- A line above the prompt shows whose turn it is in every thread that has Clarcade loaded. Press **Open** to show the game in the current thread.
- In Claude Desktop, use **Open in → Split view** to keep the board in one half of the window while you work in the other.
- Toasts and sounds only play in the thread you used most recently, so you are not notified twice.

## Settings

Change these in the pane's **Settings** tab or in the plugin configuration in Claude Code.

| Setting | Default | Meaning |
|---|---|---|
| Language | System | English or Vietnamese |
| Sounds | On | Sound effects for moves, your turn and the end of a game |
| Turn notifications | Band | A line above the prompt, a toast, a sound, or off |
| Board and pieces | Grid, X/O | Grid or dots; X/O, circles or squares |
| LAN discovery port | 47979 | UDP port used to find rooms. Both machines must use the same port |
| Tailscale IPv4 | Off | Allow the 100.64.0.0/10 range |
| IPv6 ULA | Off | Allow the fd00::/8 range |

Changes to the discovery port, Tailscale or IPv6 ULA apply right away when no room is open. If you are in a room, they apply after the room closes. After a plugin update, the background process from the previous version is replaced automatically.

## Network, security and privacy

- Clarcade only accepts private LAN addresses: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `169.254.0.0/16`. Tailscale and IPv6 ULA must be enabled separately.
- Room discovery uses multicast `239.255.67.75` and broadcast on UDP port 47979. The host accepts TCP connections on a port chosen by the operating system. If macOS asks whether Node may accept incoming connections, choose **Allow**.
- **Traffic between the two machines is not encrypted.** Anyone else on the network can read moves, player names and the PIN of a private room, and could pose as the host to a reconnecting guest. Only play on networks you trust, and never reuse a PIN that protects something else.
- Wrong PINs are limited to 5 per minute per IP address, and an address is blocked from the room after 10. After 30 wrong PINs in total, the room stops accepting PINs and the host needs to create a new room.
- Clarcade never sends your email or Claude account details. On macOS, the name field is prefilled with your full name from the system so you can change it before saving. Public rooms announce the host's name to every machine on the LAN.

## Data and uninstalling

Data lives in `~/.claude/clarcade`, or in `$CLAUDE_CONFIG_DIR/clarcade` when that variable is set:

| File | Contents |
|---|---|
| `player.json` | Your random player ID. Statistics follow this ID, so changing your name keeps them |
| `stats.json` | Game history |
| `room.json` | The current room and game |
| `daemon.log` | Background process log |

If a file cannot be read, Clarcade renames it to `<file>.corrupt-<timestamp>` and continues with empty data. The old file is kept so you can recover it by hand.

The background process exits after 10 minutes without a room and without any Claude Code session using Clarcade. To remove it completely:

```sh
kill $(lsof -t ~/.claude/clarcade/daemon.lock)
```

```sh
rm -rf ~/.claude/clarcade
```

Then uninstall the plugin with `/plugin uninstall clarcade@clarcade`.

## Troubleshooting

| Problem | What to do |
|---|---|
| The room does not show up | Check that both machines are on the same network and use the same discovery port. Use **Copy link with address** if the network blocks multicast |
| Node cannot be found | Enter the absolute Node path in Settings → Advanced, then press **Reconnect** |
| Lost connection to the background process | Press **Reconnect**. If it keeps failing, check `daemon.log` |
| The board is larger than the pane | Scroll with the arrow keys; `C` jumps to the last move |

## Development

```sh
npm test
```

```sh
claude plugin test plugins/clarcade
```

| Path | Role |
|---|---|
| `plugins/clarcade/hooks/` | The mod: command, pane, prompt band, settings and the client for the background process |
| `plugins/clarcade/helper/` | The background process: rooms, LAN protocol, discovery and statistics |
| `plugins/clarcade/games/gomoku/` | Rules and board rendering |
| `tests/` | Node tests for the rules, protocol and background process |

## License

[MIT](LICENSE)
