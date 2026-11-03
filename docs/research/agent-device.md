# agent-device: what it teaches agent-atv

Researched 2026-11-03. Sources: [agent-device.dev](https://agent-device.dev/),
[Expo's page](https://docs.expo.dev/agents/agent-device/), npm `agent-device` 0.21.36, and the source
at [callstack/agent-device@c8ad8fb](https://github.com/callstack/agent-device/tree/c8ad8fb1257787ce0973cf74271cb9a4fafb51d9).
Paths below are relative to that commit (append `#Lx-Ly` on GitHub). **V** = verified in source or
docs, **I** = inference.

## 1. tvOS support (the key finding)

- **V** It supports the tvOS Simulator and physical Apple TVs, through its own XCUITest runner, not
  WebDriverAgent: "XCTest for iOS interactions, physical iOS, and tvOS" (`README.md#L158`); the
  capability tables mark snapshot, selectors, remote keys and deep links "Yes" for "tvOS device"
  (`website/docs/docs/capabilities.md#L36-L43`, `#L266-L279`). Those tables come from command
  admission rules and do not establish that every operation works (`capabilities.md#L6`).
- **V** The runner is an XCTest UI-test bundle that runs an HTTP server on the device;
  the host posts JSON to `POST /command` with a per-launch token (`apple/runner/README.md#L82-L86`).
  The Mac builds it with `xcodebuild` (`appletvos` destination,
  `packages/apple-runner/src/apple-runner-platform.ts#L55`) and keeps it running with
  `xcodebuild test-without-building` (`packages/apple-runner/src/runner-process-launch.ts#L65-L82`).
- **V** The host reaches a physical device over usbmux when cabled, else at its CoreDevice tunnel
  address, `http://[tunnelIp]:port/command`, re-resolved through `devicectl` (cached 30 s)
  (`packages/apple-runner/src/runner-command-route.ts#L4`, `#L30-L40`, `#L110`). An Apple TV
  has no cable, so it takes the tunnel route (**I**).
- **V** Requirements: a Mac with Xcode (`devicectl`, `xctrace`), the device paired and in Developer Mode,
  the developer disk image, a signed runner (`AGENT_DEVICE_IOS_TEAM_ID`, Automatic Signing,
  `-allowProvisioningUpdates`) (`website/docs/docs/installation.md#L110-L127`,
  `packages/apple-runner/src/runner-cache-metadata.ts#L265-L292`, `runner-artifact.ts#L892`). These
  are documented for iOS only; nothing documents a physical tvOS setup apart from them (**I**: the same
  steps). Physical tvOS runners are "never exercised across a daemon restart"
  (`apple-runner-platform.ts#L161-L162`). A Linux agent can use `agent-device proxy` against a Mac
  host, so the Mac is still needed at runtime (agent-device.dev).
- **V** On tvOS, **acting on a target does not navigate to it**. `press @ref` presses Select only if the
  target already has the focus, else it answers `UNSUPPORTED_OPERATION`, "Move focus to the target
  element first" (`apple/runner/.../RunnerTests+TvRemote.swift#L137-L150`); a coordinate tap is
  refused (`RunnerTests+Interaction.swift#L564`). Keys go through `XCUIRemote.shared.press`
  (`RunnerTests+TvRemote.swift#L35-L47`); `scroll <dir>` becomes one remote key press
  (`packages/platform-apple/src/interactions.ts#L442-L451`). The help says: "Do not assume
  press/click @ref works on Android TV, tvOS, or Vega OS until the desired element is focused"
  (`src/commands/schema/cli-help.ts#L252`).
- **V** What it does give on tvOS is the **full tree with the focus marked**: each node's `focused` comes
  from XCTest's `hasFocus`/`hasKeyboardFocus` (`RunnerTests+SnapshotAcquisition.swift#L524-L531`) and
  the text output prints `focused` on that line (`packages/capture-kit/src/snapshot/snapshot-lines.ts#L216`).
  The focused element is found with the predicate `hasFocus == true` (`RunnerTests+TvRemote.swift#L175-L185`).

## 2. Architecture and latency

- **V** Observe: XCTest recursive snapshot, shaped on the host into a visible-first tree. iOS
  simulators get a faster private bridge, but "tvOS and visionOS Simulators … and physical devices keep
  XCTest" (`docs/adr/0004-ios-snapshot-backend-strategy.md#L737`).
- **V** Tree read speed: there are no published numbers for tvOS (the perf suite does not time TV,
  `scripts/perf/README.md#L65`). The budgets show the cost: an XCTest capture above 3 s counts as slow,
  some screens "grind ~4-8s", the tree slice gets 8 s and the whole plan 20 s
  (`RunnerTests.swift#L169-L178`, `RunnerTests+SnapshotCapturePlan.swift#L116`); on a deep tree
  XCTest "costs seconds per capture" (ADR 0004 #L601). **I**: expect about 1 s on simple tvOS screens
  and several seconds on rich ones, plus the Wi-Fi tunnel.
- **V** `--settle`: after the act, snapshot every 300 ms until the tree stays the same for 500 ms (timeout
  10 s), then return the diff against the pre-action tree, capped at 80 lines, in the same response
  (`packages/command-runtime/.../stable-capture.ts#L37-L83`, `settle.ts#L41-L73`). It never fails the
  action; a screen that never settles gets its own hint (`settle.ts#L54-L76`). So one settled key costs
  two or more tree reads plus 500 ms.

## 3. Agent interface: what keeps agents fast

- Snapshot `-i`: one line per interactive element, `@e12 [button] label="Add to cart" enabled hittable`;
  off-screen content collapsed to `[off-screen below] 3 interactive items: "Privacy", …`; scope `-s`,
  depth `-d`, `diff snapshot` (`cli-help.ts#L93`, `website/docs/docs/snapshots.md#L75-L111`).
- Reaching a target in one command: `scroll <dir> --until <selector>`, 12 passes by default, 200 at most
  (`packages/contracts/src/scroll-command.ts#L7-L8`). Each stop reason has its own code and hint:
  `scroll_until_edge_reached`, `scroll_until_pass_limit`, `scroll_until_no_progress`,
  `scroll_until_capture_unreadable` (`packages/daemon/src/execution/scroll-until.ts#L163-L235`).
  The code comment: "The content ran out, or the budget did. Separate messages: the corrective action differs."
- Batching: `batch --steps '<json>'`, and plain `&&` chains (`cli-help.ts#L80-L82`, `#L184-L187`).
- The skill is 24 lines (`skills/agent-device/SKILL.md`). The parts that make agents fast:
  - "Do not probe first with `--help`, `--version`, `devices`, … `snapshot`" (`#L8`); `open` "returns the
    initial interactive snapshot" (`#L14`).
  - "Reaching an off-screen target is one command, not a scroll-and-check loop … Repeated bare `scroll
    down` calls are the slow way" (`#L18`).
  - "Error output includes corrective hints; follow them instead of re-planning" (`#L22`).
  - "Chain confident consecutive steps with &&… Fall back to one command at a time when a step is
    uncertain (ambiguous match, network-backed result, unseen screen)" (`cli-help.ts#L80-L81`).
  - "Lifecycle facts (trust these instead of probing)" (`cli-help.ts#L130`); "a bare
    screenshot/snapshot is not verification. Before declaring a task done, confirm the requested end
    state" (`cli-help.ts#L123`).
  - On TV: "move focus with remote/D-pad buttons, then activate the focused control"; when focus
    metadata is missing, use `screenshot --overlay-refs` as visual truth (`cli-help.ts#L202`, `#L249-L251`).

## 4. Comparison with agent-atv

| | agent-device on tvOS | agent-atv |
| --- | --- | --- |
| Observe | full XCTest tree with `focused`, about 1 to 8 s (I) | focused element only, event about 50 ms after the key, 0.2 s read (DESIGN §6.1) |
| Act | `XCUIRemote` inside the runner; no navigation to a target | pyatv keys; same limit |
| Runtime host | Mac + Xcode + signed runner | Pi, no Mac, no Xcode |
| Feedback after an act | settled tree diff (polling) | `Focus:` line (event) |
| Reach a target | `scroll --until` checks visibility, not focus (I) | planned `press --until` |

agent-device does not solve TV navigation either: its agent still moves the focus key by key. Its edge
is seeing the whole screen. Ours is a much cheaper per-key observation, which makes on-device loops
(`--until`, `scan`) fast in a way its snapshot-per-pass loop cannot be.

On a WDA-style tree for us: agent-device confirms XCTest is the only full-tree route on tvOS, that it
needs a signed XCTest bundle, and that tree reads take seconds. **I**: its runner (MIT) could be built and
signed once on a Mac and started from the Pi with `pymobiledevice3 developer dvt xcuitest`, like WDA.
That is not verified, and with a free (Personal Team) account the profile expires after 7 days.

## 5. Ranked ideas

| # | Idea | Why | Effect | Cost |
| --- | --- | --- | --- | --- |
| 1 | **Take**: rewrite the skill in agent-device's style (plan 1): no probing; plan a key sequence and chain it when the layout is known; one command to reach a target; follow hints; a list of facts to trust; verify the end state | its biggest speed levers are words, not code | a series launch from about 40 turns / 3 min to about 5 to 8 turns / 30 to 60 s (I) | hours, docs only |
| 2 | **Take**: `press <dir> --until "<label>" --max N` with stable codes `found`, `edge` (focus did not move), `max`, `focus_unknown`, `screen_changed`, each with its own hint (plan 3) | the `scroll_until_*` design, run on focus events | a row search goes from N turns to 1, about 0.3 s per key | 1 to 2 days, Pi only |
| 3 | **Take**: an event-driven settle that never fails the act and returns `moved` / `no move` / `unknown` separately (plan 2) | their settle contract; our event is about 10 times faster than their 300 ms polling | removes the "did it move?" turns; 1 to 2 s off each key | about 1 day |
| 4 | **Take**: `scan <dir>`: walk an axis and return every label, like their `[off-screen below] … items` summary | the closest we get to a tree without XCTest; lets the agent plan whole sequences | one turn replaces exploring a row; about 0.3 s per item | about 1 day on top of 2 |
| 5 | **Take**: `open` returns the first observation (app + focus) and arms focus following; keep it armed for a whole task rather than 15 s | their `open` returns a snapshot; LLM turns often exceed our 15 s window, so the first `Focus:` read comes back unknown | saves one turn per screen; cuts the "move to learn the focus" keys | small; the trade-off is the green frame on the user's own moves |
| 6 | **Take**: machine-readable `reason` next to `hint` in every error and stop | they branch on `details.reason` | fewer re-plans | small |
| 7 | **Take, light**: chain with `&&` and multi-spec `press`; **not** a JSON `batch` | `press 'down*3' right` already batches | marginal | none |
| 8 | **Take**: check playback via now-playing as "the end state" (plan 5); deep links (plan 4) and per-app recipes (plan 6) unchanged | "a bare screenshot is not verification"; agent-device has no TV deep-link or app recipes to copy | unchanged | as planned |
| 9 | **Defer**: a full tree via an XCUITest runner over the tunnel | only route to the whole screen, but needs a Mac to sign (weekly with a free team), seconds per read, still no act-on-target | could make planning on unknown screens one-shot | high, unverified on a Pi |
| 10 | **Don't take**: refs, ref pinning, tree diffs, device claims, proxy | no tree; one TV; our plugin is already the remote host | none | none |
