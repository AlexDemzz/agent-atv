# homebridge-agent-atv

A Homebridge plugin that lets AI agents drive an Apple TV. It exposes an authenticated HTTP API that the
[`agent-atv`](https://www.npmjs.com/package/agent-atv) CLI talks to: remote keys, app launching,
keyboard text input, wait conditions, power, volume, seek and optional screen reading (the focused
element after an action, and screenshots). It also publishes a minimal HomeKit TV accessory.

It complements [homebridge-appletv-enhanced](https://github.com/maxileith/homebridge-appletv-enhanced): that
plugin is about HomeKit control, this one is an API for agents. Both can run side by side.

The full guide (setup, pairing, screen reading, the CLI, security, troubleshooting) is the
[main README](https://github.com/AlexDemzz/agent-atv#readme).

## Requirements

- Homebridge 1.8 or 2.x, Node.js 22.12+, 24 or 26.
- Python 3.10 to 3.13 with the `venv` module (`sudo apt-get install python3-venv` on Debian/Ubuntu) and
  OpenSSL 3.0+. On first start the plugin creates its own virtual environment in
  `<storage>/agent-atv/.venv` and installs the pinned [pyatv](https://pyatv.dev) 0.18.0 dependencies from
  PyPI. This takes a few minutes on a Raspberry Pi.
- Screen reading (optional): about 350 MB more in `<storage>/agent-atv/.venv-screen`, and about 100 MB
  of memory per Apple TV. On Python 3.10–3.12 the install compiles one package, so the host needs
  `build-essential python3-dev libssl-dev` (Debian/Raspberry Pi OS).

## Setup

1. Install the plugin from the Homebridge UI (or `npm i -g homebridge-agent-atv`) and add the platform.
2. Open the plugin settings. Apple TVs on the network appear in the device table. Click **Pair**, then type
   the PIN shown on the TV. The plugin pairs Companion first, then AirPlay if the Companion credentials
   don't work for AirPlay (a second PIN), then screen reading when it is on (one more PIN). Check
   **Also enable screen reading** before pairing to turn it on from there.
3. Copy the API token from the same page, then on the agent's machine:

   ```sh
   npm i -g agent-atv
   agent-atv config set url http://<homebridge-host>:8787
   agent-atv config set token -     # paste the token, Enter, Ctrl-D
   agent-atv doctor
   ```

## Security

The API is plain HTTP with a bearer token. The token gives full remote control of every paired Apple TV.

- Prefer binding the API to the host's [Tailscale](https://tailscale.com) IP (`api.bind`), which encrypts
  the traffic. On a LAN, anyone who can sniff the network can read the token.
- The token is stored in `<storage>/agent-atv/token` (mode 0600) and shown in the plugin settings. It is
  never logged. To rotate it, delete that file and restart Homebridge, or set `api.token` (32+ characters).
- Pairing credentials stay in `<storage>/agent-atv/devices/` (mode 0600). They never appear in logs, API
  responses or the settings UI.
- No telemetry: the plugin only talks to your Apple TVs, and to PyPI while installing its pinned packages.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `api.port` | `8787` | HTTP API port |
| `api.bind` | `0.0.0.0` | listen address, e.g. `127.0.0.1`, a LAN IP or the Tailscale IP |
| `api.token` | `""` | overrides the generated token (32+ characters) |
| `discovery.enabled` | `true` | scan on start and every 5 minutes |
| `discovery.hosts` | `[]` | IPs to scan directly (other subnets, Tailscale) |
| `devices[]` | `[]` | per-device `id`, `name`, `address`, `homekit` |
| `homekit.enabled` | `true` | publish one HomeKit TV accessory per paired Apple TV |
| `homekit.inputs` / `homekit.maxInputs` | `[]` / `12` | apps exposed as TV inputs |
| `screen.enabled` | `false` | screen reading: foreground app, focused element, screenshots |
| `python.executable` | `python3` | interpreter used to build the venv |
| `python.forceVenvRecreate` | `false` | rebuild the venv on next start |
| `debug` | `false` | log debug lines at info level |

The HomeKit accessory is published as an external accessory: add it in the Home app with
**Add Accessory > More options** and the Homebridge setup code.

The HTTP API is specified in [DESIGN.md](https://github.com/AlexDemzz/agent-atv/blob/main/DESIGN.md#3-http-api-plugin).

## License

[MIT](https://github.com/AlexDemzz/agent-atv/blob/main/LICENSE)
