# Command reference

`agent-atv --help` lists every command and the global flags. This file adds each command's own flags
and what it prints. For the workflow, see [SKILL.md](../SKILL.md).

Global flags go before or after the command. Slow commands (`wait`, `open`, `scan`, `pair`,
`screenshot`) raise the HTTP `--timeout` to what their slowest plugin path needs. Every command accepts
`--json` and then prints exactly one JSON line on stdout: the API response, or `{"error": {...}}`.

## Observe

| command | own flags | prints |
| --- | --- | --- |
| `snapshot` | `--screenshot [path]` (with `--max-width <px>` and `--jpeg` as for `screenshot`), `--no-focus` | the snapshot block; with `--screenshot`, also `Screenshot: <path> (<w>x<h>)` or `Screenshot: unavailable, <reason>: <what to do>`, exit 0 either way |
| `state [field]` | | one line per field, below. Without a field, the snapshot block from the cache, without `App:` and `Focus:` |
| `screenshot [path]` | `--max-width <px>` (160-3840, never scales up), `--jpeg`, `--if-changed` | `<path> (3840x2160, 2.1s)`, or `unchanged <previous path>` |
| `apps` | `--filter <substr>`, `--refresh` | `<bundle id>  <name>` per line, sorted by name |

Snapshot block, top to bottom:

- `Device: <name> (<id>) tvOS <version>, connected|connecting|disconnected|unpaired`
- `Pairing: required (run agent-atv pair)`, only when the Apple TV rejected the credentials
- `Power: on|off|unknown`
- `App: <name> (<bundle id>)`, `App: Home screen`, `App: Screensaver`,
  `App: ambiguous, <name> (<bundle id>), ...` (several apps in front at once, read again), or
  `App: unknown, <reason>: <what to do>`
- `Playing: idle`, or `<state> <mediaType> "<title>" - <artist> (<series> S<n>E<n>) <pos>/<total> in <app>`
  without the parts that are missing; `<app>` is the app that last played; states are
  `idle loading paused playing stopped seeking`
- `Keyboard: unfocused|unknown` or `Keyboard: focused text="..."`
- `Focus: "<label>" (id <identifier>, value <value>)` without the missing parts (and without an id
  equal to the label), or
  `Focus: unavailable, <reason>: <what to do>`
- `Volume: <0-100>` or `Volume: n/a`
- `Seq: <n>`

`state` fields: `power` (`on`), `app` (`com.netflix.Netflix Netflix`, `home screen`, `screensaver` or
`ambiguous: <bundle id> <name>, ...`, read live; exit 8 when screen reading can't answer), `playing`
(`playing video "Chapter One" 12:03/58:10 in Netflix`), `keyboard` (`focused "stran"`), `volume` (`35` or `n/a`), `connection`,
`seq`, `focus` (`"Netflix" (id app-icon/com.netflix.Netflix)`, read live; exit 8 when screen reading
can't answer, and when no `--settle` action or `wait --focus` ran in the last 15 s or so: the focus is
followed only around actions). With `--json`: `{"<field>": value}`.

The default screenshot path is `<tmpdir>/agent-atv/screenshot-<device id>-<YYYYMMDD-HHMMSS>.png` (UTC),
`.jpg` with `--jpeg`. `--if-changed` compares with the last capture of that device, so it reports
`unchanged` only for a capture taken with the same `--max-width` and `--jpeg`.

## Act

| command | own flags | prints |
| --- | --- | --- |
| `press <spec...>` | `--interval <ms>` (default 200, 0-5000), `--hold`, `--double`, `--settle` | `pressed down*2 right select` |
| `press <arrow> --until <text>` | `--max <n>` (default 20, 1-100) | `pressed right*3 until "plex"` and the `Focus:` line, or `pressed nothing: the focus already matches "plex"`; not found: `pressed right*6: "arte" not found` and the numbered list below, exit 5 (`FOCUS_NOT_FOUND`) |
| `press <arrow> --scan` | `--max <n>` (default 20, 1-100) | `scanned right: 3 moves, then no move reported (...)` and the numbered list below |
| `back`, `home` | same as `press` | `pressed menu`, `pressed home` |
| `open <target>` | `--wait-ms <ms>` (default 15000, max 60000), `--no-wait`, `--settle` | `opened Netflix (com.netflix.Netflix)`, or `launched <target>`, or `launched <bundle id> (not in foreground after 15000ms)`, or `launched <bundle id> (foreground app not known, <reason>: <what to do>)` without waiting (exit 0) |
| `type <text>`, `fill <text>`, `clear` | `--settle` | `keyboard: "<text now in the field>"` |
| `power [on\|off\|toggle]` | | `power: on`, once the Apple TV confirms it (up to about 34 s) |
| `volume [level\|up\|down]` | `--step <n>` (1-50) with `up`/`down` | `volume: 40` |
| `seek <90\|+30\|-10\|12:33\|1:02:03>` | | `position: 12:33` |

With `--settle`, `press`, `back`, `home`, `open`, `type`, `fill` and `clear` also wait for the focus to
settle and add a `Focus:` line (formats as in the snapshot block) after the line above; the exit code
doesn't depend on it. After `press` and `open` the line names the element the Apple TV reported after
the last key, about 0.3 s after an arrow and up to about 1 s after other keys and `open`; it ends with
`, no move reported` when the action moved nothing (the end of a row, or a screen that does not report
moves). `--json` carries it as `focus`: `{"available": true, "element": {"label", "value",
"identifier"}, "moved": true|false}` or `{"available": false, "code", "reason", "hint"}`.

`--until` and `--scan` take one arrow and press it one key at a time with the settled focus. Besides
the match, both stop when a press reports no move and leaves the same element (a press that changes
the element's value, as in a Netflix row read as one element, counts as a move), when two elements
come back in the order already seen (a row that wraps around), or after `--max` presses. A focus that cannot
be read stops them after that press: the list so far, then the focus error's exit code and fix. The numbered list starts at `0` with the
element focused before the first press, when the plugin knew it, and marks the focused one:
`2 "Plex" (id AppCell)  <- focus`. `--json`: `{"found": true, "presses", "start", "passed", "focus"}`
for `--until`, `{"stop": "no_move"|"repeat"|"max", "presses", "start", "passed", "focus"}` for
`--scan`; a `--until` not found, and a focus lost on the way, carry `stop` and the same fields in
`error.details`.

Key spec: `<key>[:tap|double|hold][*count]`, count 1-50, at most 100 presses per command. `--hold` and
`--double` apply to specs without their own action. Only `up down left right select menu home` take
`double` or `hold`. An unknown key exits 2 and the hint lists every valid key.

Key aliases, case-insensitive: `enter ok return click` → `select`; `back escape esc` → `menu`;
`arrowup arrowdown arrowleft arrowright` → `up down left right`; `tv` → `home`; `playpause space` →
`play_pause`; `volup voldown` → `volume_up volume_down`; `ff rw` → `skip_forward skip_backward`; `-`
reads as `_`.

`open` takes an app name, a bundle id, or a URL. A name resolves against the installed apps: exact name
first, then a unique prefix; none or several exit 5 (`APP_NOT_FOUND`, `AMBIGUOUS_APP`). A target
containing `://` launches as a link and waits for the app that opens it: `opened TV
(com.apple.TVWatchList)`, or `launched <link> (no app in the foreground after 15000ms: ...)`. When an
app was already in front, the link may open in it: after 3 s that app is taken.

A relative `seek` with nothing playing or paused fails with `NOTHING_PLAYING` (exit 1).

## Wait

| flag | holds when |
| --- | --- |
| `--app <name\|bundle id>` | that app is in the foreground; `home` and `screensaver` match the home screen and the screensaver |
| `--playing`, `--paused`, `--playback <state>` | playback is in that state |
| `--power <on\|off>` | power is in that state |
| `--keyboard`, `--no-keyboard` | a text field is focused, or not |
| `--text <substring>` | the app name, title, artist, album, series name or keyboard text contains it (case-insensitive) |
| `--focus <substring>` | the focused element's label, value or identifier contains it (case-insensitive); adds a `Focus:` line on success |
| `--idle <ms>` | the state hasn't changed for that long; it always waits at least that long |
| `--timeout <ms>` | default 25000, 1-300000 |

Prints `ok app idle (2340ms)`; a bare `wait <ms>` prints `ok waited 2000ms`. A timeout exits 7 with
`hint: Current state: ...`, naming the app as `--app` takes it (`app home`, `app screensaver`). A
dropped connection doesn't end a wait; only the timeout does.

## Devices and pairing

| command | own flags | prints |
| --- | --- | --- |
| `devices` | | `<id>  <name>  <connection>  paired\|unpaired  tvOS <version>  <address>` |
| `scan` | | `<id>  <name>  paired\|unpaired  tvOS <version>  <address>` |
| `pair [device]` | `--no-input`, `--screen` (screen reading only) | `pairing <id> started (step 1/3, companion): run agent-atv pair --pairing <id> --pin <PIN>` |
| `pair --pairing <id> --pin <PIN>` | | the next step in the same format, or `paired <name> (<id>)` (a `warning:` on stderr when screen reading couldn't be paired) |
| `pair --cancel <id>` | | `cancelled <id>` |
| `unpair <device>` | `--yes`, required without a TTY | `unpaired <device>` |

Without a device, `pair` takes the only known Apple TV, paired or not. Steps: `companion`, `airplay`
(skipped when the Companion credentials work for it), `remotepairing` (screen reading, when the plugin
has it on). Its PIN may be longer than 4 digits; a PIN that isn't 4 to 8 digits exits 2.
`PAIRING_BACKOFF` (exit 1) means too many attempts; the hint gives the delay.

## Setup and diagnostics

| command | prints |
| --- | --- |
| `doctor` | one `ok\|warn\|fail <check>: <detail>[; hint: <what to do>]` line per check: config, health, token, bridge, paired, device, screen. Exit 1 if any check fails |
| `config show` | url, device, token (masked as `…last4`) and timeout, each with its source: flag, env, file or default |
| `config set url\|device <value>` | `<key>: <value> (saved to <path>)` |
| `config set token -` | reads the token from stdin |
| `config path` | the config file path |
| `skills list`, `skills get <name> [--full]` | the bundled skills |
