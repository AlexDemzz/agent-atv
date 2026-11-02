"""Key name → pyatv RemoteControl call table (DESIGN.md §2.6)."""

from __future__ import annotations

KEYS_WITH_ACTION = ("up", "down", "left", "right", "select", "menu", "home")
KEYS_WITHOUT_ACTION = (
    "home_hold",
    "top_menu",
    "play",
    "pause",
    "play_pause",
    "stop",
    "next",
    "previous",
    "volume_up",
    "volume_down",
    "channel_up",
    "channel_down",
    "screensaver",
    "guide",
    "control_center",
    "skip_forward",
    "skip_backward",
)
KEYS = KEYS_WITH_ACTION + KEYS_WITHOUT_ACTION

INPUT_ACTIONS = {"tap": "SingleTap", "double": "DoubleTap", "hold": "Hold"}


def supports_action(key: str, action: str) -> bool:
    return action == "tap" or key in KEYS_WITH_ACTION
