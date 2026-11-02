#!/bin/bash
# Template: search the Apple TV and play the first result
# Purpose: the agent-atv core loop (observe -> act -> wait -> observe) as a script
# Usage: ./search-and-play.sh "<query>" [device]
#
# The first search result is a guess: check its Focus: line (or ask the user) before relying on it.
# Never use this to buy or rent anything; stop if a purchase screen appears.

set -euo pipefail

QUERY="${1:?Usage: $0 \"<query>\" [device]}"
if [[ -n "${2:-}" ]]; then
  export AGENT_ATV_DEVICE="$2"
fi

# Observe: is the TV reachable, on, and paired?
agent-atv snapshot

if [[ "$(agent-atv state power)" != "on" ]]; then
  agent-atv power on
  agent-atv wait --power on --timeout 15000
fi

# Act: open the Search app, then wait for its text field to be focused
agent-atv open com.apple.TVSearch
agent-atv wait --keyboard --timeout 15000

agent-atv fill "$QUERY"

# Act and observe: move to the first result; --settle prints the Focus: line that names it
agent-atv press down --settle

# Act: open its detail page
agent-atv press select
agent-atv wait --idle 1500

# Act: start playback from the detail page and wait for it
agent-atv press select
if agent-atv wait --playing --timeout 20000; then
  agent-atv state playing
else
  # Exit 7: not playing yet. Show where we are instead of pressing more keys blindly.
  agent-atv snapshot --screenshot
  exit 1
fi
