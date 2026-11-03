# agent-atv

Apple TV control for AI agents: a command-line tool, `agent-atv`, and the Homebridge plugin it talks
to, `homebridge-agent-atv`. An agent drives the TV with one loop: **observe** (`snapshot`,
`screenshot`) → **act** (`press`, `open`, `type`, `fill`; add `--settle` to see the focused element it
leads to) → **wait** for a condition → observe again.

```bash
$ agent-atv open Netflix
opened Netflix (com.netflix.Netflix)
$ agent-atv press down --settle
pressed down
Focus: "Chapter One" (id title-card/80057281)
$ agent-atv snapshot
Device: Living Room (A1B2C3D4E5F6) tvOS 27.2, connected
Power: on
App: Netflix (com.netflix.Netflix)
Playing: idle
Keyboard: unfocused
Focus: "Chapter One" (id title-card/80057281)
Volume: 35
Seq: 182
```

The `App:` and `Focus:` lines need [screen reading](#screen-reading-optional), an option of the plugin.

## How it works

```
agent's machine: agent-atv CLI ──HTTP + Bearer token──▶ Homebridge host: homebridge-agent-atv ──▶ Python bridge (pyatv) ──▶ Apple TV
                                                                  └──▶ screen worker (pymobiledevice3, optional) ──▶ Apple TV
```

- The **plugin** runs on your Homebridge host. It exposes an authenticated HTTP API and keeps a
  connection to each paired Apple TV through a bundled Python bridge built on
  [pyatv](https://pyatv.dev): remote keys, app launching, keyboard text input, power, volume, seek and
  playback state. It also publishes a minimal HomeKit TV accessory.
- **Screen reading** is optional. A second helper built on
  [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) reads the focused element and the
  foreground app and takes screenshots, over the network, with no root, no jailbreak and nothing to
  install on the Apple TV. It needs one extra pairing PIN.
- The **CLI** runs wherever your agent runs (any machine that can reach the Homebridge host). It has no
  runtime dependencies and bundles the agent skill that teaches an agent how to use it.

| package | what | runs on |
| --- | --- | --- |
| [`homebridge-agent-atv`](packages/homebridge-agent-atv) | Homebridge plugin: HTTP API, Python bridge, screen reading, HomeKit accessory | your Homebridge host |
| [`agent-atv`](packages/agent-atv) | CLI and bundled agent skill | the machine your agent runs on |

## Requirements

- Homebridge 1.8 or 2.x on Node.js 22 (≥ 22.12), 24 or 26.
- Python 3.10–3.13 with `venv` on the Homebridge host (Debian/Raspberry Pi OS: `sudo apt-get install
  python3-venv`), and OpenSSL 3.0 or later. On first start the plugin creates its own virtualenv in
  `<homebridge storage>/agent-atv/.venv` and installs a pinned pyatv 0.18.0 from PyPI.
- An Apple TV on a network the Homebridge host can reach.
- For screen reading: about 350 MB more disk on the host and about 100 MB of memory per Apple TV.
- For the CLI: Node.js 22 or later on the agent's machine.

## Install the plugin

In the Homebridge UI, open **Plugins**, search for `homebridge-agent-atv` and install it. Or from a
shell on the Homebridge host:

```sh
npm i -g homebridge-agent-atv
```

Then add the platform. The plugin settings page writes this for you; the minimal block is:

```json
{
  "platform": "AgentATV",
  "name": "Agent ATV"
}
```

Restart Homebridge. The plugin discovers Apple TVs on the network, starts the HTTP API on port 8787 and
generates an API token. Copy it from the plugin settings page. The Homebridge log only says that a token
was created and where it is stored (`<storage>/agent-atv/token`, mode 0600), never the token itself.

### Configuration

| key | default | meaning |
| --- | --- | --- |
| `api.port` | `8787` | HTTP API port |
| `api.bind` | `0.0.0.0` | address the API listens on: `127.0.0.1`, a LAN IP, or the host's Tailscale IP (see [Security](#security)) |
| `api.token` | `""` | your own token (at least 32 characters) instead of the generated one |
| `discovery.enabled` | `true` | scan on start and every 5 minutes; every tvOS device found is added |
| `discovery.hosts` | `[]` | IP addresses to scan directly (other subnets, Tailscale) |
| `devices[]` | `[]` | optional per-device entries: `id` (required), `name`, `address`, `homekit` |
| `homekit.enabled` | `true` | publish a HomeKit TV accessory per paired Apple TV |
| `homekit.inputs` | `[]` | bundle ids exposed as TV inputs; empty means the first `homekit.maxInputs` apps by name |
| `homekit.maxInputs` | `12` | 1–40 |
| `screen.enabled` | `false` | screen reading: the foreground app, the focused element and screenshots, see [Screen reading](#screen-reading-optional) |
| `python.executable` | `python3` | interpreter used to create the virtualenv |
| `python.forceVenvRecreate` | `false` | rebuild the virtualenv on next start |
| `debug` | `false` | log debug lines at info level |

The HomeKit accessory is deliberately minimal (power, inputs, remote keys, volume). It is published as
an external accessory: add it in the Home app with your Homebridge setup code. The plugin's main
purpose is the API.

## Pair your Apple TV

Open the plugin settings in the Homebridge UI. The device table lists the Apple TVs found on the
network; press **Pair** and type the 4-digit PIN that appears on the TV. Pairing has up to three steps:
Companion (remote control and keyboard), then AirPlay (needed for playback state and titles), then, with
screen reading on, RemotePairing (its own PIN). The plugin first tries to reuse the Companion
credentials for AirPlay and only asks for the AirPlay PIN if that fails. The Apple TV lists the pairing
as `agent-atv (<host name>)`.

You can also pair from the CLI once it is configured ([Configure the CLI](#configure-the-cli)):

```bash
agent-atv scan                 # find the Apple TV and its id
agent-atv pair A1B2C3D4E5F6    # prompts for each PIN shown on the TV
```

If commands fail with `ACCESS_DENIED`, the Apple TV restricts who may control it: in the Home app, go to
*Home Settings > Speakers & TVs* and allow "Everyone" or "Anyone on the Same Network" (no password), and
check *Settings > AirPlay and HomeKit > Allow Access* on the Apple TV.

The plugin can run alongside homebridge-appletv-enhanced; the two pair separately. This combination is
expected to work but hasn't been tested yet.

## Install the CLI

On the machine your agent runs on:

```bash
npm i -g agent-atv
```

## Configure the CLI

```bash
agent-atv config set url http://<homebridge-host>:8787
agent-atv config set token -       # paste the token from the plugin settings, Enter, Ctrl-D
agent-atv doctor
```

`doctor` checks the config, the API, the token, the Python bridge, pairing, the connection and
screen reading, one line each, with what to do next for anything not ok:

```
ok config: url http://100.64.0.10:8787 (file), token …k3Qz (file), device default (default)
ok health: homebridge-agent-atv 0.1.0 at http://100.64.0.10:8787
ok token: accepted
ok bridge: ready (pyatv backend, pyatv 0.18.0, python 3.11.2)
ok paired: 1 paired: Living Room
ok device: Living Room (A1B2C3D4E5F6) connected
ok screen: connected (pymobiledevice3 11.49.1)
```

Settings are resolved as flag > environment > config file > default:

| setting | flag | env | config key |
| --- | --- | --- | --- |
| API URL | `--url` | `AGENT_ATV_URL` | `url` |
| token | `--token` (discouraged: shell history) | `AGENT_ATV_TOKEN` | `token` |
| device | `-d, --device` | `AGENT_ATV_DEVICE` | `device` |
| HTTP timeout | `--timeout <ms>` | `AGENT_ATV_TIMEOUT_MS` | |

The config file is `$AGENT_ATV_CONFIG`, else `$XDG_CONFIG_HOME/agent-atv/config.json`, else
`~/.config/agent-atv/config.json`, written with mode 0600. `agent-atv config show` prints each resolved
value and its source, with the token masked.

The device defaults to `default`, the only paired Apple TV (for `pair`, the only known one, so a first
`agent-atv pair` needs no id). With several, pass `-d "<name or id>"` or run
`agent-atv config set device "<name>"`.

## Quick start

```bash
# Open an app and wait until it is in the foreground
agent-atv open Netflix

# Search
agent-atv open com.apple.TVSearch
agent-atv wait --keyboard
agent-atv fill "stranger things"
agent-atv wait --idle 1500
agent-atv press down select

# Playback
agent-atv press play_pause
agent-atv wait --playing
agent-atv seek +30
agent-atv state playing

# Navigate
agent-atv press down*2 right select
agent-atv press down --until "Saison 2"   # steer to an element by name (screen reading)
agent-atv press right --scan              # list a row, numbered from the focus
agent-atv back
agent-atv home

# Volume and power
agent-atv volume 30
agent-atv volume down --step 3
agent-atv power toggle

# Machine-readable output
agent-atv snapshot --json
```

### Commands

`agent-atv --help` lists every command. In short:

| command | does |
| --- | --- |
| `snapshot [--screenshot [path] [--max-width <px>] [--jpeg]]` | device, power, app, playback, keyboard, focused element, volume |
| `state [field]` | one field: `power app playing keyboard volume connection seq` from the cached state, or `focus` |
| `screenshot [path] [--max-width <px>] [--jpeg] [--if-changed]` | PNG of the TV screen, or a smaller JPEG |
| `press <key[:action][*n]...>` | remote keys; `back` and `home` are shortcuts |
| `press <arrow> --until <text>` / `press <arrow> --scan` | steer to an element by name / list a row (screen reading) |
| `open <name\|bundle id\|url>` | launch and wait for the foreground (`--no-wait`, `--wait-ms`) |
| `type <text>` / `fill <text>` / `clear` | append to / replace / empty the focused text field |
| `wait [ms] [--app --playing --paused --playback --power --keyboard --no-keyboard --text --focus --idle --timeout]` | wait until every condition holds |
| `power [on\|off\|toggle]`, `volume [level\|up\|down]`, `seek <pos>` | controls |
| `apps [--filter] [--refresh]` | installed apps |
| `devices`, `scan`, `pair [--screen]`, `unpair` | devices and pairing |
| `doctor`, `config`, `skills` | setup and diagnostics |

Exit codes: 0 success, 1 failed, 2 usage or config, 3 plugin unreachable, 4 bad token, 5 not found,
6 device not ready, 7 wait timeout, 8 screen reading unavailable. Actions print only their own line;
with `--settle` they also wait for the focus to settle and print the `Focus:` line, without ever
failing because of it. Every error says what to do next. The full reference is in
[packages/agent-atv/skills/core/references/commands.md](packages/agent-atv/skills/core/references/commands.md).

## Use it from an agent

The CLI bundles its own skill, so the instructions always match the installed version:

```bash
agent-atv skills get core          # the usage guide for agents
agent-atv skills get core --full   # plus the command reference, safety rules and a template script
```

For agents that load skills from a directory (Claude Code and others), install the discovery stub
[`skills/agent-atv/SKILL.md`](skills/agent-atv/SKILL.md). It tells the agent when to use the CLI and to
load the full guide with `agent-atv skills get core`, so the stub never goes stale:

```bash
npx skills add AlexDemzz/agent-atv
```

or copy it by hand, for example for Claude Code:

```bash
mkdir -p ~/.claude/skills/agent-atv && curl -fsSL -o ~/.claude/skills/agent-atv/SKILL.md \
  https://raw.githubusercontent.com/AlexDemzz/agent-atv/main/skills/agent-atv/SKILL.md
```

## Screen reading (optional)

With screen reading on, the plugin reads the element that has the focus on the TV (its label, value
and identifier) and the app in the foreground, and takes screenshots. An action with `--settle` then answers with the element it led
to, so an agent sees where it is after each key press. It needs no root, no system service and no setup on the
host.

1. On the plugin's pairing page, check **Also enable screen reading** before pressing **Pair**: the
   page turns it on, waits for the install, then asks for one more PIN, and step 2 below is done. Otherwise,
   in the plugin settings, turn on **Screen reading** (`screen.enabled`) and restart Homebridge. The
   plugin installs pymobiledevice3 11.49.1 in its own virtualenv (`<storage>/agent-atv/.venv-screen`,
   about 350 MB, about 90 s on a Raspberry Pi) and runs one helper process per Apple TV (about 100 MB
   of memory each). On Python 3.10–3.12 the install compiles one package: the host needs a C compiler
   and the Python and OpenSSL headers (Debian: `sudo apt-get install build-essential python3-dev
   libssl-dev`).
2. Pair screen reading. On the Apple TV open *Settings > Remotes and Devices > Remote App and
   Devices*, then press **Pair screen reading** in the device table (or run
   `agent-atv pair <id> --screen`) and type the PIN shown there. A new pairing asks for it as its
   last step.

`agent-atv doctor` then reports `ok screen: connected`. A RemotePairing record made earlier with
pymobiledevice3 (`remote_<identifier>.plist`) can be copied into
`<storage>/agent-atv/pmd3-home/.local/share/pymobiledevice3/` (owned by the Homebridge user, mode 0600)
instead of pairing again.

An arrow key with `--settle` answers in about 0.3 s on a Pi, other keys within about 1 s. The Apple TV reports
the focus only when it moves, and the plugin follows it only around agent actions: from an action with
`--settle` (or a `wait --focus`) until about 15 s after the last one. So the plugin says the focus is
not known rather than guess: outside those actions (`state focus` or `snapshot` on their own), and
after the screen, the app or the playback changed, until the next move made with `--settle`. A key that
moved nothing says `no move reported`. A 4K screenshot takes
up to about 15 s on a Pi depending on its size (frames reach 30 MB), so agents use
`screenshot --if-changed`, and `--max-width 1280 --jpeg` (about 110 KB) when the full resolution
isn't needed, which matters most over a slow remote link. DRM-protected video captures black.

## HTTP API

The CLI is a thin client of the plugin's HTTP API, which any other client can use too. All routes are
under `http://<homebridge-host>:8787/v1`, take and return JSON, and need
`Authorization: Bearer <token>` except `GET /v1/health`:

```bash
curl -s -H "Authorization: Bearer $AGENT_ATV_TOKEN" http://<homebridge-host>:8787/v1/devices/default/state
curl -s -H "Authorization: Bearer $AGENT_ATV_TOKEN" -H 'Content-Type: application/json' \
  -d '{"keys": [{"key": "select"}]}' http://<homebridge-host>:8787/v1/devices/default/keys
```

Routes cover devices and scanning, state, keys, apps and `open`, keyboard text, power, volume, seek,
`wait`, the focused element, screenshots and pairing. Errors are
`{"error": {"code", "message", "hint"}}` with a stable code. The full contract is in
[DESIGN.md §3](DESIGN.md#3-http-api-plugin).

## Security

- **The token is a remote control.** Anyone with it can control the Apple TV: launch apps, type, change
  power and volume. Every API route except `GET /v1/health` requires `Authorization: Bearer <token>`.
- **The API is plain HTTP.** On a LAN, the token and every command travel unencrypted. Prefer
  [Tailscale](https://tailscale.com): set `api.bind` to the Homebridge host's Tailscale IP (e.g.
  `100.64.0.10`) so the API only listens on the tailnet, which is encrypted, and point the CLI at
  `http://100.64.0.10:8787`. Use `127.0.0.1` when the agent runs on the Homebridge host itself. Leave
  `0.0.0.0` only on a network you trust.
- **Keep the token out of shell history.** Use `agent-atv config set token -` (stdin) or
  `AGENT_ATV_TOKEN`, not `--token`. The CLI config file is created with mode 0600 and the CLI warns if it
  becomes readable by others. The plugin stores its token in `<storage>/agent-atv/token` (mode 0600)
  and never writes it to the Homebridge log, which is often readable by every user on the host. Rotate
  it by deleting that file and restarting Homebridge, or set your own with `api.token`.
- Pairing credentials stay on the Homebridge host (`<storage>/agent-atv/devices/`, mode 0600) and never
  appear in logs, API responses or the UI.
- No telemetry. The plugin only talks to your Apple TVs, and to PyPI while installing its pinned Python
  packages.
- The bundled agent skill tells agents to treat everything shown on the TV as untrusted data, and never to
  buy, rent, subscribe, delete, sign out or change account or parental settings without your explicit
  confirmation.

## Limitations

- Screen reading gives the focused element, not the whole screen; the rest is only in screenshots.
- To follow the focus, screen reading uses the Apple TV's accessibility inspector, which frames each
  newly focused item in green. The plugin turns it on only around agent actions (about 15 s after the
  last one) and removes the frame right away meanwhile, so it can flash for a moment then, also on
  moves made with the remote. Outside agent actions the inspector is off and the TV shows no frame.
  Without screen reading, in-app navigation relies on `wait --idle` and looking again.
- The foreground app (`App:`, `wait --app`, `open` waiting for its app) needs screen reading; without
  it `App:` says `unknown` with the fix and `open` returns as soon as the launch is sent.
- Typing works only while a tvOS text field is focused; some apps use custom keyboards that never report
  focus.

## Troubleshooting

Run `agent-atv doctor`. It checks each link of the chain (CLI config, the API, the token, the Python
bridge, pairing, the connection to the Apple TV, screen reading) and prints, for anything not ok, what
to do next. Every CLI error also ends with the fix. The plugin logs to the Homebridge log, screen reading
connection changes included; set `debug` to `true` for one line per API request. If you are stuck, open an
[issue](https://github.com/AlexDemzz/agent-atv/issues) with the `agent-atv doctor` output.

## Development

```bash
npm install
npm run build
npm test                 # CLI and plugin tests (vitest)
npm run test:python      # Python bridge and screen worker tests
npm run test:e2e         # CLI -> standalone plugin -> fake bridge and screen worker
```

Without Homebridge or an Apple TV, run the plugin core in standalone mode against the fake Apple TV
(and, with `screen.enabled`, the fake screen worker, PIN `1234`):

```bash
AGENT_ATV_FAKE_BRIDGE=1 node packages/homebridge-agent-atv/dist/standalone.js \
  --config /tmp/agent-atv-dev/config.json --storage /tmp/agent-atv-dev
```

`DESIGN.md` is the contract between the packages.

## License

[MIT](LICENSE) © AlexDemzz
