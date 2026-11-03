---
name: agent-atv
description: Apple TV control through the agent-atv CLI. Use when the user wants to drive or inspect an Apple TV (tvOS) - open an app ("open Netflix on the TV"), search, play or pause, change volume or power, use it like a TV remote, check what is playing or selected on screen, or take a screenshot of the TV.
allowed-tools: Bash(agent-atv:*), Bash(npx agent-atv:*)
---

# agent-atv

The `agent-atv` CLI drives an Apple TV through the homebridge-agent-atv Homebridge plugin.

Before running any other `agent-atv` command, load the usage guide that ships with the installed CLI,
and observe the TV in the same call:

```bash
agent-atv skills get core && agent-atv snapshot
```

If `agent-atv` isn't installed or configured, the user sets it up once (the token is in the plugin
settings in the Homebridge UI):

```bash
npm i -g agent-atv
agent-atv config set url http://<homebridge-host>:8787
agent-atv config set token -        # paste the token, Enter, Ctrl-D
agent-atv doctor
```
