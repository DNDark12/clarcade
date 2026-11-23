# Clarcade

Two-player Caro (Gomoku) on your LAN, inside Claude Code, while your agents work. Without Claude Code (for example on the Free plan), you can still join a game from the Chat tab of Claude Desktop with the [Chat extension](#play-from-claude-desktop-chat-without-claude-code). No internet, no external server and no npm dependencies. Each game runs in a background process on your machine, so it survives closing the pane, switching threads and reloading the mod.

## Features

- Public or private rooms (4–6 digit PIN). Join by invite link, by room name or from a list of rooms on your LAN.
- Two rule sets: **Freestyle** (the default; five or more in a row wins) and **Blocked ends** (a line blocked by the opponent at both ends does not win).
- New games use a fixed 15×15 board. Filling it without a winner ends the game in a draw.
- Undo requests, draw offers, resignation and rematches. The first player alternates between games.
- Room options include a per-move clock and how long to hold the room when the opponent disconnects.
- Statistics overall and per opponent: wins, losses, draws, streaks, and splits by rule set and by X/O.
- English and Vietnamese interface.

## Requirements

| Component | Requirement |
|---|---|
| Claude Code | 2.1.319 or later. Playable in the terminal and in Claude Desktop. VS Code and mobile only show the room status |
| Without Claude Code | Claude Desktop with the Chat extension, to join games only. See [Play from Claude Desktop Chat](#play-from-claude-desktop-chat-without-claude-code) |
| Operating system | macOS (tested). Linux is untested. Windows is not supported |
| Node.js | 22 or later |
| Perl | `/usr/bin/perl` with `flock` support. The launcher uses it to keep a single background process running |
| Network | Both machines on the same LAN. The firewall must allow UDP port 47979 and incoming TCP connections to Node |

If Clarcade cannot find Node, enter its absolute path in **Settings → Advanced → Network** (for example `/opt/homebrew/bin/node`).

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

### Updates

Clarcade updates itself. A few seconds after each Claude Code session starts (skipping a session within 10 minutes of the last check), it refreshes its marketplace and installs a newer version with the Claude Code CLI, the same two commands as below. It skips the check while a game is being played and when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. When a new version is installed, a toast asks you to restart Claude Code to load it.

Turn this off in **Settings → Update automatically**, or update at once with **Update now** or `/clarcade update`. If your installed version does not offer these options, run both commands in a terminal:

```sh
claude plugin marketplace update clarcade
```

```sh
claude plugin update clarcade@clarcade
```

Start a new Code session after updating. Run `claude plugin list` in a terminal to check which version is installed.

## Play from Claude Desktop Chat (without Claude Code)

**Clarcade for Chat** is a Claude Desktop extension (listed as **Clarcade**) for people without Claude Code, such as Free plan accounts. It shows the board inside a Chat or Cowork conversation and plays on the same LAN as the Claude Code plugin.

| | |
|---|---|
| What it can do | **Join** a room and play. Someone using Clarcade in Claude Code creates the room |
| What it cannot do | Create rooms, statistics, settings, turn notifications |
| Language | English, or Vietnamese when Claude Desktop is set to Vietnamese |
| App | Claude Desktop on macOS. Not the web or mobile app |
| Node.js | 22 or later installed on the machine (`node` on PATH, `/opt/homebrew/bin/node` or `/usr/local/bin/node`) |
| Network | Same LAN as the host. Allow incoming connections for Node if macOS Firewall asks |

### Install the extension

1. Download `clarcade-chat-<version>.mcpb` from the [latest release](https://github.com/DNDark12/clarcade/releases/latest). If you installed **Clarcade Chat Preview** 0.1.1, uninstall it first in **Settings → Extensions**; your game data is kept.
2. Double-click the file, or drag it onto the Claude Desktop window. You can also open **Settings → Extensions → Advanced settings → Install Extension…** and choose the file.
3. Press **Install**, then check that **Clarcade** is turned on in **Settings → Extensions**.

### Open the board

1. Start a new chat. In the **+** menu, open **Connectors** and check that **Clarcade** is on.
2. Send a short message such as `Open Clarcade` (or `Mở Clarcade`). Claude opens the board in its reply. If Claude asks for permission, choose **Always allow** so later games open without the prompt.
3. Paste the invitation link from the host (`clarcade://j/…`), enter your name and, for a private room, the PIN. Press **Join**.
4. Click a cell to place your stone. **Expand** shows the board full screen, **Leave** leaves the room.
5. When the game ends, press **Play again**. The next game starts once the host also agrees, and the first player alternates.

### Open it again without typing

Chat only shows the board in a reply from Claude, so there is no menu button that opens it on its own. To avoid typing each time, keep one conversation for Clarcade:

1. After the board opens the first time, rename that chat to `Clarcade` and star it.
2. Next time, open it from **Starred** in the sidebar. The board in that chat reads the current game from the background process on your machine, so a game in progress continues where it was.
3. If the board in the old message does not respond, send `Open Clarcade` again in the same chat.

The game itself runs in a background process, not in the chat. Closing the chat or Claude Desktop does not end it while the host keeps the room open.

### Updates

From version 0.1.3 the extension updates itself. Each time Claude Desktop starts it, it looks for a newer release on GitHub a few seconds later (skipping a start within 10 minutes of the last check), checks the download against the SHA-256 digest GitHub publishes for it, and unpacks it into its data folder. The new version runs the next time Claude Desktop starts the extension, so a game in progress is not interrupted. Restart Claude Desktop to switch at once.

- To turn this off, open **Settings → Extensions → Clarcade** and turn off **Update automatically**.
- Updates come only from releases of this repository. Your name and game data are never sent.
- Installing a newer `.mcpb` by hand still works, and the newer of the two copies runs.

One manual step is left: if you have 0.1.2 or the 0.1.1 preview, install 0.1.3 by hand once. For 0.1.1, uninstall **Clarcade Chat Preview** first.

### Data and uninstalling

The extension keeps its data in `~/.clarcade-chat-preview`, separate from the Claude Code plugin. To remove it, open **Settings → Extensions**, choose **Clarcade** and uninstall it, then delete that folder.

## How to play

### Create a room

1. Run `/clarcade` → **Create room**.
2. Choose the rules and visibility, enter a room name and press **Create room**. Open **Room options** to change the turn clock or reconnect window.
3. For a public room, the other player can select it from **Join room**. To send an invitation, press **Copy link**. For a private room, share the PIN separately.

When the guest joins, an open host pane switches from the waiting screen to the board. The host places the first stone in the center. If you closed the pane, run `/clarcade` again to see the current board.

If the other player cannot find the room, open **Connection help**, select your LAN address and press **Copy link**. The resulting link connects straight to your machine.

### Join a room

Open **Join room** to see public rooms on your LAN. Select a room from the list, or enter the exact room name or an invite link in the search field. Private rooms ask for the PIN.

You can also run `/clarcade join <link|room name>` or paste an invite link on its own into the prompt.

### Placing stones and moving around the board

- Press and release on a cell to place a stone. While holding the mouse button, drag to another cell to change the target or release outside the board to cancel. The first move is always at the center.
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

Change these in the pane's **Settings** tab or in the plugin configuration in Claude Code. Open **Advanced** for notifications and board settings, or **Advanced → Network** for connection settings.

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
| The room does not show up | Check that both machines are on the same network and use the same discovery port. Open **Connection help**, select your LAN address and press **Copy link** if discovery fails |
| The host still sees the waiting screen after the guest joins | Update the host to 0.1.6 or later. The board refreshes while statistics load |
| Node cannot be found | Enter the absolute Node path in Settings → Advanced → Network, then press **Reconnect** |
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
| `plugins/clarcade-chat/` | The Claude Desktop extension for Chat: launcher with self-update (`bootstrap.mjs`), MCP server and board |
| `tests/` | Node tests for the rules, protocol and background process |

To release the Chat extension, build it with `sh plugins/clarcade-chat/pack.sh /absolute/path/clarcade-chat-<version>.mcpb`, tag the commit `clarcade-chat-v<version>` and publish a GitHub release with that file attached under exactly that name. Installed extensions pick up only releases that follow this pattern and are neither drafts nor pre-releases.

## License

[MIT](LICENSE)
