# agent-atv

A CLI that lets AI agents observe and drive an Apple TV (snapshot, press, open, type, wait,
screenshot). It talks to the
[homebridge-agent-atv](https://www.npmjs.com/package/homebridge-agent-atv) Homebridge plugin, which
must be installed and paired first. Setup, pairing, screen reading and security are covered in the
[main README](https://github.com/AlexDemzz/agent-atv#readme).

Node.js 22 or later, no runtime dependencies.

## Install and configure

```bash
npm i -g agent-atv
agent-atv config set url http://<homebridge-host>:8787
agent-atv config set token -       # paste the token from the plugin settings, Enter, Ctrl-D
agent-atv doctor
```

Settings resolve as flag > env > config file > default: `--url` / `AGENT_ATV_URL`, `--token` /
`AGENT_ATV_TOKEN` (prefer env or the config file over the flag), `-d, --device` / `AGENT_ATV_DEVICE`
(default `default`, the only paired device; for `pair`, the only known device), `--timeout <ms>` / `AGENT_ATV_TIMEOUT_MS` (default 30000).

## The loop

```bash
agent-atv snapshot                       # observe
agent-atv open com.apple.TVSearch        # act; actions print only their own line
agent-atv wait --keyboard                # wait
agent-atv fill "stranger things"
agent-atv press down --settle            # Focus: "Stranger Things" (id …), with screen reading
agent-atv press select
agent-atv press down --until "Saison 2"  # steer to an element by name, one command
agent-atv screenshot --if-changed        # look at the whole screen
```

Every command accepts `--json` and prints one JSON line. Exit codes: 0 success, 1 failed, 2 usage or
config, 3 plugin unreachable, 4 bad token, 5 not found, 6 device not ready, 7 wait timeout,
8 screen reading unavailable. Errors and warnings say what to do next.

## For agents

```bash
agent-atv skills get core          # usage guide
agent-atv skills get core --full   # plus command reference, safety rules, template script
```

## License

MIT
