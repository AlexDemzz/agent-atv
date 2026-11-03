"""Seam W1: the screen worker protocol, with pymobiledevice3 faked at its boundary (tests/fake_pmd3)."""

from __future__ import annotations

import asyncio
import dataclasses
import os
import struct
import tempfile
import unittest
import zlib

from agent_atv_screen import inbound_queue
from agent_atv_screen.backend_pmd3 import Pmd3Backend, Timings
from agent_atv_screen.server import serve
from tests import fake_pmd3
from tests.bridge_process import BridgeProcess
from tests.in_process_bridge import InProcessBridge

RECORD = "0A1B2C3D-0000-4000-8000-00000000AA01"
# The first retarget after a lost session makes the focus unknown: FAST never retargets, only LostSessionTest does.
FAST = Timings(retry_s=(0.05, 0.1), health_s=0.05, call_timeout_s=0.5, connect_timeout_s=0.5, browse_s=0.3, session_close_s=0.05, retarget_s=60)
RETARGET = dataclasses.replace(FAST, retarget_s=0.15)
IDLE = dataclasses.replace(FAST, follow_idle_s=0.3)

try:
    from PIL import Image
except ImportError:  # Pillow comes with the screen venv (requirements-screen.txt)
    Image = None


def decodable_png(width: int, height: int) -> bytes:
    """A real RGB PNG, unlike fake_png's header-only one, for the captures the worker re-encodes."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + b"\x20\x80\xe0" * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def restore_userspace_tun(test: unittest.TestCase) -> None:
    """inbound_queue.install() patches the class for the whole process; give it back as it was."""
    stock = {name: vars(fake_pmd3.UserspaceTun)[name] for name in ("write", "close")}
    test.addCleanup(lambda: [setattr(fake_pmd3.UserspaceTun, name, value) for name, value in stock.items()])


class ScreenWorkerTestCase(unittest.IsolatedAsyncioTestCase):
    identifier = RECORD
    records = [RECORD]
    record_addresses: dict = {}
    timings = FAST

    async def asyncSetUp(self) -> None:
        restore_userspace_tun(self)
        self.pmd3 = fake_pmd3.FakePmd3()
        self.pmd3.records = list(self.records)
        self.pmd3.record_addresses = dict(self.record_addresses)
        self.worker = self.start_worker()

    def start_worker(self, identifier=None, address="192.168.1.50") -> InProcessBridge:
        backend = Pmd3Backend(
            self.pmd3.modules(),
            address=address,
            identifier=identifier if identifier is not None else self.identifier,
            timings=self.timings,
        )
        return InProcessBridge(backend, serve)

    async def asyncTearDown(self) -> None:
        await self.worker.close()

    async def connected(self):
        return await self.status("connected")

    async def following(self) -> None:
        """What an agent action does first: the tunnel up, then the worker asked to follow the focus."""
        await self.connected()
        self.assertIn("moves", await self.worker.call("follow"))

    async def status(self, tunnel: str):
        while True:
            event = await self.worker.next_event("status")
            if event["data"]["tunnel"] == tunnel:
                return event["data"]

    async def move_focus(self, element) -> None:
        """Moves the tvOS focus and waits until the worker has handled the Apple TV's event."""
        self.pmd3.move_focus(element)
        for _ in range(200):
            if self.pmd3.highlighted is None:
                return
            await asyncio.sleep(0.005)
        self.fail("the worker did not handle the focus change")

    async def kill_worker(self) -> None:
        """What the Apple TV sees of a killed worker: its tunnel goes, with the session it carried."""
        for tunnel in list(self.pmd3.open_tunnels):
            tunnel.fake_drop()
        await self.worker.close()


class TunnelTest(ScreenWorkerTestCase):
    async def test_ready_reports_the_backend_and_pymobiledevice3_version(self) -> None:
        ready = await self.worker.next_event("ready")
        self.assertEqual(ready["data"]["backend"], "pmd3")
        self.assertEqual(ready["data"]["pymobiledevice3"], "11.49.1")
        self.assertEqual(ready["data"]["protocolVersion"], 1)

    async def test_opens_the_tunnel_over_wifi_remotepairing_on_the_device_ipv4_address(self) -> None:
        status = await self.connected()

        self.assertEqual(status, {"tunnel": "connected", "identifier": RECORD, "error": None})
        tunnel = self.pmd3.open_tunnels[0]
        self.assertEqual((tunnel.rsd.fake_provider.hostname, tunnel.rsd.fake_provider.port), ("192.168.1.50", 49155))
        self.assertEqual(self.pmd3.discoveries, [RECORD])
        others = [s for s in self.pmd3.discovered if s is not tunnel.rsd.fake_provider]
        self.assertTrue(others and all(s.fake_closed for s in others))

    async def test_raises_the_dtx_buffer_limit_for_hdr_4k_captures(self) -> None:
        await self.connected()
        self.assertGreaterEqual(fake_pmd3.MAX_BUFFERED_SIZE, 128 * 1024 * 1024)

    async def test_ping_reports_the_tunnel(self) -> None:
        await self.connected()
        self.assertEqual(
            await self.worker.call("ping"),
            {"pong": True, "tunnel": "connected", "identifier": RECORD, "error": None},
        )

    async def test_reconnects_after_the_tunnel_drops_and_reuses_the_known_endpoint(self) -> None:
        await self.connected()
        self.pmd3.open_tunnels[0].fake_drop()

        await self.status("connecting")
        await self.connected()

        self.assertEqual(self.pmd3.tunnel_opens, 2)
        self.assertEqual(self.pmd3.discoveries, [RECORD])
        self.assertEqual(self.pmd3.direct_connects[-1], (RECORD, "192.168.1.50", 49155))

    async def test_keeps_retrying_while_the_apple_tv_is_unreachable(self) -> None:
        self.pmd3.reachable = False
        await self.worker.close()
        self.pmd3 = fake_pmd3.FakePmd3()
        self.pmd3.records = [RECORD]
        self.pmd3.reachable = False
        self.worker = self.start_worker()

        down = await self.status("disconnected")
        self.assertIn("not found", down["error"])
        self.pmd3.reachable = True
        await self.connected()

    async def test_stays_unpaired_without_a_pair_record_and_answers_screen_not_paired(self) -> None:
        await self.worker.close()
        self.pmd3 = fake_pmd3.FakePmd3()
        self.worker = self.start_worker()

        self.assertEqual((await self.worker.next_event("status"))["data"]["tunnel"], "unpaired")
        error = await self.worker.error("focus")
        self.assertEqual(error["code"], "SCREEN_NOT_PAIRED")
        self.assertEqual(self.pmd3.tunnel_opens, 0)


class MigratedRecordTest(ScreenWorkerTestCase):
    identifier = ""
    records = ["OTHER-RECORD", RECORD]

    record_addresses = {"OTHER-RECORD": ["192.168.1.60"]}

    async def test_without_an_identifier_picks_the_record_whose_device_has_the_address_and_reports_it(self) -> None:
        status = await self.connected()
        self.assertEqual(status["identifier"], RECORD)
        self.assertEqual(self.pmd3.discoveries, [None])


class OtherAppleTvRecordTest(ScreenWorkerTestCase):
    identifier = ""
    records = ["OTHER-RECORD"]
    record_addresses = {"OTHER-RECORD": ["192.168.1.60"]}

    async def test_without_an_identifier_never_takes_the_record_of_an_apple_tv_at_another_address(self) -> None:
        status = await self.status("unpaired")

        self.assertIsNone(status["identifier"])
        self.assertIn("192.168.1.50", status["error"])
        self.assertEqual(self.pmd3.open_tunnels, [])
        self.assertEqual((await self.worker.error("focus"))["code"], "SCREEN_NOT_PAIRED")


ARROW = b"\x02arrow"
ARROW_FOCUS = {"label": "Swipe up for full screen", "value": None, "identifier": "top-shelf/swipe-up-affordance/arrow"}


class FocusTest(ScreenWorkerTestCase):
    async def test_answers_the_element_tvos_moved_the_focus_to(self) -> None:
        await self.following()

        await self.move_focus(ARROW)

        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_says_how_long_ago_the_focus_moved(self) -> None:
        await self.following()
        await self.move_focus(b"\x03last")
        await asyncio.sleep(0.2)

        before = await self.worker.call("focus")
        await self.move_focus(ARROW)
        after = await self.worker.call("focus")

        self.assertGreaterEqual(before["ageMs"], 200)
        self.assertLess(after["ageMs"], 200)
        self.assertEqual(after["focus"], ARROW_FOCUS)

    async def test_the_age_of_a_move_leaves_out_the_time_the_read_takes(self) -> None:
        # The plugin dates the move from when it sent the read; a slow read must not age it.
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.attributes_delay_s = 0.3

        read = await self.worker.call("focus")

        self.assertLess(read["ageMs"], 100)

    async def test_the_focus_is_unknown_until_it_moves(self) -> None:
        await self.following()

        error = await self.worker.error("focus")

        self.assertEqual(error["code"], "FOCUS_UNKNOWN")
        self.assertIn("moves", error["message"])

    async def test_never_takes_the_first_or_last_element_for_the_focus(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        await self.worker.call("focus")

        selectors = [call[0] for call in self.pmd3.ax_calls]
        self.assertNotIn("deviceFetchSpecialElement:", selectors)
        self.assertFalse(any("move" in s.lower() or "press" in s.lower() for s in selectors))

    async def test_clears_the_highlight_the_apple_tv_draws_on_every_newly_focused_element(self) -> None:
        await self.following()

        for element in (ARROW, b"\x03last", ARROW):
            self.pmd3.move_focus(element)
            self.assertEqual(self.pmd3.highlighted, element)
            await self.move_focus(element)

        self.assertIsNone(self.pmd3.highlighted)

    async def test_clears_the_highlight_the_apple_tv_draws_again_on_a_layout_change(self) -> None:
        await self.following()
        await self.move_focus(ARROW)

        self.pmd3.relayout()
        self.assertEqual(self.pmd3.highlighted, ARROW)
        await self.drain_events()

        self.assertIsNone(self.pmd3.highlighted)

    async def test_keeps_one_accessibility_session_across_reads(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        sessions = self.pmd3.ax_sessions
        for _ in range(3):
            await self.worker.call("focus")
        self.assertEqual(self.pmd3.ax_sessions, sessions)

    async def test_the_focus_is_unknown_when_the_apple_tv_reports_a_move_to_no_element(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.move_focus(None)
        await asyncio.sleep(0.05)

        self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN")

    async def test_the_focus_is_unknown_when_the_focused_element_reads_empty(self) -> None:
        # Seen in a video player while "Info" was focused: Label, Value and Identifier all empty.
        await self.following()
        self.pmd3.elements[b"\x04blank"] = {"Label": "", "Value": "", "Identifier": ""}
        self.pmd3.elements[b"\x05none"] = {}
        for element in (b"\x04blank", b"\x05none"):
            await self.move_focus(element)
            self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN", element)

    async def drain_events(self) -> None:
        """Lets the worker take the events already sent; a focus read then waits behind them."""
        await asyncio.sleep(0.05)

    async def test_the_focus_is_unknown_once_the_screen_or_its_layout_changes(self) -> None:
        await self.following()
        for notification in ("UIAccessibilityScreenChangedNotification", "UIAccessibilityLayoutChangedNotification"):
            await self.move_focus(ARROW)

            self.pmd3.post_notification(notification)
            await self.drain_events()

            self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN", notification)

    async def test_a_layout_change_that_keeps_the_focused_element_keeps_the_focus_and_its_move_time(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        await asyncio.sleep(0.2)

        self.pmd3.relayout()
        await self.drain_events()

        read = await self.worker.call("focus")
        self.assertEqual(read["focus"], ARROW_FOCUS)
        self.assertGreaterEqual(read["ageMs"], 200)

    async def test_a_layout_change_that_names_another_element_leaves_the_focus_unknown(self) -> None:
        # A move that sent no event, as inside apps: the daemon now inspects an element never reported.
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.focused = b"\x03last"

        self.pmd3.relayout()
        await self.drain_events()

        self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN")

    async def test_after_a_screen_change_the_focus_stays_unknown_through_a_layout_change(self) -> None:
        await self.following()
        await self.move_focus(ARROW)

        self.pmd3.post_notification("UIAccessibilityScreenChangedNotification")
        self.pmd3.relayout()
        await self.drain_events()

        self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN")

    async def test_a_layout_change_then_a_focus_move_reports_the_new_element(self) -> None:
        await self.following()
        await self.move_focus(b"\x03last")

        self.pmd3.post_notification("UIAccessibilityLayoutChangedNotification")
        await self.move_focus(ARROW)

        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_a_screen_change_during_the_read_makes_the_focus_unknown(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.attributes_delay_s = 0.2

        reading = self.worker.send("focus")
        await asyncio.sleep(0.1)
        self.pmd3.post_notification("UIAccessibilityScreenChangedNotification")

        self.assertEqual((await self.worker.response(reading))["error"]["code"], "FOCUS_UNKNOWN")

    async def test_a_move_during_the_read_reports_the_new_element(self) -> None:
        await self.following()
        await self.move_focus(b"\x03last")
        self.pmd3.attributes_delay_s = 0.1

        reading = self.worker.send("focus")
        await asyncio.sleep(0.05)
        self.pmd3.move_focus(ARROW)

        self.assertEqual((await self.worker.response(reading))["result"]["focus"], ARROW_FOCUS)

    async def test_an_announcement_keeps_the_focus(self) -> None:
        await self.following()
        await self.move_focus(ARROW)

        self.pmd3.post_notification("UIAccessibilityAnnouncementNotification")
        await self.drain_events()

        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_reads_the_label_value_and_identifier_in_one_round_trip(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.attributes_delay_s = 0.15

        started = asyncio.get_running_loop().time()
        await self.worker.call("focus")

        self.assertLess(asyncio.get_running_loop().time() - started, 0.3)


LAST = b"\x03last"
SETTLE = {"waitMs": 300, "quietMs": 50}


class SettleTest(ScreenWorkerTestCase):
    """What an action that asked for the settled focus gets: the move its keys caused, or none."""

    async def baseline(self) -> int:
        await self.connected()
        return (await self.worker.call("follow"))["moves"]

    def move_later(self, delay_s: float, element: bytes) -> None:
        asyncio.get_running_loop().call_later(delay_s, self.pmd3.move_focus, element)

    async def test_follow_counts_the_focus_moves(self) -> None:
        before = await self.baseline()

        await self.move_focus(ARROW)

        self.assertEqual((await self.worker.call("follow"))["moves"], before + 1)

    async def test_answers_the_move_that_comes_after_the_baseline(self) -> None:
        moves = await self.baseline()
        self.move_later(0.1, ARROW)

        read = await self.worker.call("focus", {"afterMoves": moves, **SETTLE})

        self.assertEqual(read["focus"], ARROW_FOCUS)
        self.assertTrue(read["moved"])

    async def test_answers_once_the_focus_stops_moving(self) -> None:
        moves = await self.baseline()
        self.move_later(0.05, LAST)
        self.move_later(0.08, ARROW)

        read = await self.worker.call("focus", {"afterMoves": moves, **SETTLE})

        self.assertEqual(read["focus"], ARROW_FOCUS)

    async def test_without_a_move_in_time_answers_the_element_still_focused_as_not_moved(self) -> None:
        await self.baseline()
        await self.move_focus(ARROW)
        moves = (await self.worker.call("follow"))["moves"]

        started = asyncio.get_running_loop().time()
        read = await self.worker.call("focus", {"afterMoves": moves, **SETTLE})

        self.assertEqual(read["focus"], ARROW_FOCUS)
        self.assertFalse(read["moved"])
        self.assertGreaterEqual(asyncio.get_running_loop().time() - started, 0.3)

    async def test_without_a_move_on_a_screen_that_changed_the_focus_is_unknown(self) -> None:
        await self.baseline()
        await self.move_focus(ARROW)
        moves = (await self.worker.call("follow"))["moves"]
        self.pmd3.post_notification("UIAccessibilityScreenChangedNotification")

        error = await self.worker.error("focus", {"afterMoves": moves, **SETTLE})

        self.assertEqual(error["code"], "FOCUS_UNKNOWN")

    async def test_a_move_before_the_baseline_does_not_count(self) -> None:
        await self.baseline()
        await self.move_focus(LAST)
        moves = (await self.worker.call("follow"))["moves"]
        self.move_later(0.1, ARROW)

        read = await self.worker.call("focus", {"afterMoves": moves, **SETTLE})

        self.assertEqual(read["focus"], ARROW_FOCUS)
        self.assertTrue(read["moved"])

    async def test_waits_for_the_apple_tv_to_confirm_the_element_after_a_layout_change(self) -> None:
        moves = await self.baseline()
        self.move_later(0.05, ARROW)
        asyncio.get_running_loop().call_later(0.06, self.pmd3.post_notification, "UIAccessibilityLayoutChangedNotification")
        asyncio.get_running_loop().call_later(0.3, self.pmd3.relayout)

        read = await self.worker.call("focus", {"afterMoves": moves, **SETTLE})

        self.assertEqual(read["focus"], ARROW_FOCUS)

    async def test_takes_null_timings_for_the_defaults(self) -> None:
        moves = await self.baseline()
        self.move_later(0.05, ARROW)

        read = await self.worker.call("focus", {"afterMoves": moves, "waitMs": None, "quietMs": None})

        self.assertTrue(read["moved"])

    async def test_a_plain_read_says_nothing_about_a_move(self) -> None:
        await self.baseline()
        await self.move_focus(ARROW)

        self.assertNotIn("moved", await self.worker.call("focus"))

    async def test_rejects_a_baseline_that_is_not_a_count(self) -> None:
        await self.baseline()

        error = await self.worker.error("focus", {"afterMoves": "3", **SETTLE})

        self.assertEqual((error["code"], error["details"]["field"]), ("BAD_REQUEST", "afterMoves"))

    async def test_the_focus_is_unknown_again_after_another_inspector_takes_over_then_followed_again(self) -> None:
        await self.following()
        await self.move_focus(ARROW)

        self.pmd3.set_monitored_type(1)
        await asyncio.sleep(0.05)

        self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN")
        await self.move_focus(b"\x03last")
        self.assertEqual((await self.worker.call("focus"))["focus"]["label"], "M6+")

    async def test_stops_following_the_focus_on_shutdown(self) -> None:
        await self.following()
        await self.move_focus(ARROW)

        await self.worker.close()

        self.assertEqual(self.pmd3.monitored_type, 0)
        self.assertEqual(self.pmd3.ax_calls[-1], ("deviceInspectorShowVisuals:", (0,)))
        self.assertEqual(self.pmd3.open_sessions, [])

    async def test_a_worker_started_after_another_shut_down_follows_the_focus_once_the_apple_tv_disposes_of_lost_sessions(self) -> None:
        self.pmd3.close_flush_s = 0.02
        await self.following()
        await self.worker.close()

        self.worker = self.start_worker()
        await self.following()
        self.pmd3.dispose_lost_sessions()

        await self.move_focus(ARROW)
        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_after_a_failed_read_the_fresh_session_follows_the_focus_once_the_apple_tv_disposes_of_lost_sessions(self) -> None:
        self.pmd3.close_flush_s = 0.02
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.fail_next = [ConnectionResetError("stale tunnel")]
        await self.worker.error("focus")

        self.pmd3.dispose_lost_sessions()

        await self.move_focus(ARROW)
        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_a_failed_read_retries_on_a_fresh_tunnel_where_the_focus_is_known_after_the_next_move(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.fail_next = [ConnectionResetError("stale tunnel")]

        error = await self.worker.error("focus")

        self.assertEqual(error["code"], "FOCUS_UNKNOWN")
        self.assertEqual(self.pmd3.tunnel_opens, 2)
        await self.move_focus(ARROW)
        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_fails_with_screen_failed_when_the_retry_fails_too(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        self.pmd3.ax_broken = ConnectionResetError("daemon gone")

        error = await self.worker.error("focus")

        self.assertEqual(error["code"], "SCREEN_FAILED")
        self.assertIn("daemon gone", error["message"])

    async def test_logs_a_session_that_keeps_failing_to_open_once_then_its_recovery(self) -> None:
        await self.following()
        with self.assertLogs("agent_atv_screen", "INFO") as logs:
            self.pmd3.ax_broken = ConnectionResetError("daemon gone")
            self.pmd3.open_tunnels[0].fake_drop()
            await asyncio.sleep(FAST.health_s * 8)
            self.pmd3.ax_broken = None
            await asyncio.sleep(FAST.health_s * 4)

        failures = [line for line in logs.output if "Cannot follow the focus" in line]
        self.assertEqual(len(failures), 1, logs.output)
        self.assertIn("daemon gone", failures[0])
        self.assertTrue(any("Following the focus again" in line for line in logs.output), logs.output)

    async def test_waits_for_the_tunnel_when_asked_while_connecting(self) -> None:
        self.pmd3.tunnel_delay_s = 0.2
        error = await self.worker.error("focus")
        self.assertEqual(error["code"], "FOCUS_UNKNOWN")
        self.assertEqual(self.pmd3.tunnel_opens, 1)

    async def test_answers_screen_unavailable_when_the_apple_tv_cannot_be_reached(self) -> None:
        await self.connected()
        self.pmd3.open_tunnels[0].fake_drop()
        self.pmd3.reachable = False

        error = await self.worker.error("focus")

        self.assertEqual(error["code"], "SCREEN_UNAVAILABLE")


class OnDemandFollowingTest(ScreenWorkerTestCase):
    """The inspector highlights every focus move while it follows: only around agent actions."""

    timings = IDLE

    async def test_a_move_with_no_agent_following_shows_no_highlight(self) -> None:
        await self.connected()

        self.pmd3.move_focus(ARROW)

        self.assertIsNone(self.pmd3.highlighted)
        self.assertEqual(self.pmd3.open_sessions, [])

    async def test_a_worker_started_after_one_killed_while_following_leaves_no_highlight(self) -> None:
        await self.following()
        await self.kill_worker()

        self.worker = self.start_worker()
        await self.connected()
        self.pmd3.move_focus(ARROW)

        self.assertIsNone(self.pmd3.highlighted)

    async def test_after_follow_a_move_is_reported_and_its_highlight_cleared(self) -> None:
        await self.following()

        self.pmd3.move_focus(ARROW)
        self.assertEqual(self.pmd3.highlighted, ARROW)
        await self.move_focus(ARROW)

        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_stops_following_once_no_agent_asked_for_a_while(self) -> None:
        await self.following()
        await self.move_focus(ARROW)

        await asyncio.sleep(IDLE.follow_idle_s + 0.1)
        self.pmd3.move_focus(b"\x03last")

        self.assertIsNone(self.pmd3.highlighted)
        self.assertEqual(self.pmd3.open_sessions, [])
        self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN")

    async def test_a_focus_read_while_following_keeps_it_following(self) -> None:
        await self.following()
        await self.move_focus(ARROW)
        await asyncio.sleep(0.2)

        await self.worker.call("focus")
        await asyncio.sleep(0.2)
        await self.move_focus(b"\x03last")

        self.assertEqual((await self.worker.call("focus"))["focus"]["label"], "M6+")

    async def test_a_focus_read_while_not_following_answers_unknown_with_the_fix_and_opens_no_session(self) -> None:
        await self.connected()
        sessions = self.pmd3.ax_sessions

        error = await self.worker.error("focus")

        self.assertEqual(error["code"], "FOCUS_UNKNOWN")
        self.assertIn("agent-atv press down --settle", error["message"])
        self.assertEqual(self.pmd3.ax_sessions, sessions)
        self.pmd3.move_focus(ARROW)
        self.assertIsNone(self.pmd3.highlighted)

    async def test_follows_the_focus_when_asked_right_after_the_reset_session_closed(self) -> None:
        # The daemon learns of the reset session's end late, then untargets whichever session follows.
        await self.worker.close()
        self.pmd3.close_flush_s = 0.02
        self.worker = self.start_worker()
        await self.following()
        await asyncio.sleep(0.05)

        await self.move_focus(ARROW)

        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_follow_answers_screen_not_paired_without_a_pair_record(self) -> None:
        await self.worker.close()
        self.pmd3 = fake_pmd3.FakePmd3()
        self.worker = self.start_worker()

        self.assertEqual((await self.worker.error("follow"))["code"], "SCREEN_NOT_PAIRED")

    async def test_logs_an_inspector_reset_that_keeps_failing_once(self) -> None:
        await self.connected()
        with self.assertLogs("agent_atv_screen", "INFO") as logs:
            self.pmd3.ax_broken = ConnectionResetError("daemon gone")
            for _ in range(3):
                self.pmd3.open_tunnels[0].fake_drop()
                await self.status("connecting")
                await self.connected()

        failures = [line for line in logs.output if "Cannot reset the accessibility inspector" in line]
        self.assertEqual(len(failures), 1, logs.output)
        self.assertIn("daemon gone", failures[0])


class LostSessionTest(ScreenWorkerTestCase):
    timings = RETARGET

    async def test_a_worker_started_after_another_was_killed_follows_the_focus_once_the_apple_tv_disposes_of_the_lost_session(self) -> None:
        await self.following()
        await self.kill_worker()

        self.worker = self.start_worker()
        await self.following()
        self.pmd3.dispose_lost_sessions()
        await asyncio.sleep(RETARGET.retarget_s + 0.05)

        await self.move_focus(ARROW)
        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_follows_the_focus_again_when_the_apple_tv_disposes_of_the_lost_session_after_the_first_retarget(self) -> None:
        await self.following()
        await self.kill_worker()
        self.worker = self.start_worker()
        await self.following()
        await asyncio.sleep(RETARGET.retarget_s + 0.05)

        self.pmd3.dispose_lost_sessions()
        await asyncio.sleep(RETARGET.retarget_s + 0.05)

        await self.move_focus(ARROW)
        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_the_focus_stays_known_across_retargets_once_the_first_after_a_lost_session_has_passed(self) -> None:
        await self.following()
        await asyncio.sleep(RETARGET.retarget_s + 0.05)
        await self.move_focus(ARROW)

        await asyncio.sleep(2 * RETARGET.retarget_s + 0.05)

        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)

    async def test_the_focus_is_unknown_once_followed_again_after_moves_the_disposal_hid(self) -> None:
        await self.following()
        await self.kill_worker()
        self.worker = self.start_worker()
        await self.following()
        await self.move_focus(ARROW)

        self.pmd3.dispose_lost_sessions()
        self.pmd3.move_focus(b"\x03last")
        await asyncio.sleep(RETARGET.retarget_s + 0.05)

        self.assertEqual((await self.worker.error("focus"))["code"], "FOCUS_UNKNOWN")

    async def test_after_the_tunnel_drops_under_a_session_the_reconnected_one_follows_the_focus_once_the_apple_tv_disposes_of_it(self) -> None:
        await self.following()
        # Past the first session's own retarget, so only the lost tunnel can call for another.
        await asyncio.sleep(RETARGET.retarget_s + 0.05)
        self.pmd3.open_tunnels[0].fake_drop()
        await self.status("connecting")
        await self.following()

        self.pmd3.dispose_lost_sessions()
        await asyncio.sleep(RETARGET.retarget_s + 0.05)

        await self.move_focus(ARROW)
        self.assertEqual((await self.worker.call("focus"))["focus"], ARROW_FOCUS)


def packet(index: int, size: int = 1000) -> bytes:
    return fake_pmd3.LOOPBACK_HEADER + index.to_bytes(4, "big") + bytes(size - 4)


async def received(tun: fake_pmd3.UserspaceTun, expected: int) -> list:
    """The packet indexes that reach the stack's end, in arrival order."""
    indexes = []
    loop = asyncio.get_running_loop()
    quiet_until = loop.time() + 0.2
    while len(indexes) < expected and loop.time() < quiet_until:
        try:
            frame = tun._pend.recv(65535)
        except (BlockingIOError, InterruptedError):
            await asyncio.sleep(0.001)
            continue
        quiet_until = loop.time() + 0.2
        assert frame[:14] == fake_pmd3._ETH_HDR_TO_STACK
        indexes.append(int.from_bytes(frame[14:18], "big"))
    return indexes


class InboundPacketsTest(unittest.IsolatedAsyncioTestCase):
    """The Apple TV sends a capture in bursts larger than the tunnel's capped socketpair buffer."""

    async def asyncSetUp(self) -> None:
        restore_userspace_tun(self)
        inbound_queue.install(fake_pmd3)
        self.tun = fake_pmd3.UserspaceTun()
        self.addAsyncCleanup(self.tun.close)

    async def test_queues_the_packets_a_full_tunnel_buffer_would_drop_and_delivers_them_in_order(self) -> None:
        for index in range(200):
            self.tun.write(packet(index))

        self.assertEqual(await received(self.tun, 200), list(range(200)))

    async def test_a_queue_at_its_bound_drops_the_newest_packets_and_keeps_the_order_of_the_rest(self) -> None:
        sent = 2000
        for index in range(sent):
            self.tun.write(packet(index))

        indexes = await received(self.tun, sent)

        self.assertGreater(len(indexes), 512)
        self.assertLess(len(indexes), sent)
        self.assertEqual(indexes, list(range(len(indexes))))

    async def test_a_queued_packet_the_socket_refuses_is_dropped_alone(self) -> None:
        for index in range(100):
            self.tun.write(packet(index))
        # Larger than the socket buffer (doubled by Linux): EMSGSIZE when its turn comes.
        self.tun.write(packet(9999, size=60000))
        for index in range(100, 200):
            self.tun.write(packet(index))

        self.assertEqual(await received(self.tun, 200), list(range(200)))

    async def test_packets_arriving_while_the_tunnel_closes_leave_no_writer_on_its_socket(self) -> None:
        for index in range(200):
            self.tun.write(packet(index))
        fd = self.tun._peer.fileno()
        closing = asyncio.ensure_future(self.tun.close())
        while not self.tun._closed:
            await asyncio.sleep(0)
        for index in range(200, 400):
            self.tun.write(packet(index))

        await closing

        self.assertFalse(asyncio.get_running_loop().remove_writer(fd))


class InboundQueueInstallTest(ScreenWorkerTestCase):
    async def test_the_worker_queues_the_tunnel_packets_once_started(self) -> None:
        await self.connected()
        tun = fake_pmd3.UserspaceTun()
        self.addAsyncCleanup(tun.close)

        for index in range(200):
            tun.write(packet(index))

        self.assertEqual(await received(tun, 200), list(range(200)))


class ScreenshotTest(ScreenWorkerTestCase):
    async def test_writes_the_png_to_the_requested_path_with_mode_0600(self) -> None:
        await self.connected()
        directory = tempfile.mkdtemp()
        path = os.path.join(directory, "shot.png")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))

        result = await self.worker.call("screenshot", {"path": path})

        with open(path, "rb") as f:
            data = f.read()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", data[16:24]), (3840, 2160))
        self.assertEqual(result["bytes"], len(data))
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    async def test_runs_one_capture_at_a_time(self) -> None:
        await self.connected()
        self.pmd3.capture_delay_s = 0.1
        directory = tempfile.mkdtemp()
        first = self.worker.send("screenshot", {"path": os.path.join(directory, "a.png")})
        second = self.worker.send("screenshot", {"path": os.path.join(directory, "b.png")})
        started = asyncio.get_running_loop().time()

        await self.worker.response(first)
        await self.worker.response(second)

        self.assertGreaterEqual(asyncio.get_running_loop().time() - started, 0.2)

    async def test_requires_an_absolute_path(self) -> None:
        error = await self.worker.error("screenshot", {"path": "shot.png"})
        self.assertEqual((error["code"], error["details"]), ("BAD_REQUEST", {"field": "path"}))

    def shot_path(self, name: str) -> str:
        path = os.path.join(tempfile.mkdtemp(), name)
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        return path

    @unittest.skipIf(Image is None, "Pillow is not installed")
    async def test_writes_a_jpeg_scaled_down_to_max_width_keeping_the_aspect_ratio(self) -> None:
        await self.connected()
        self.pmd3.png = decodable_png(640, 360)
        path = self.shot_path("shot.jpg")

        result = await self.worker.call("screenshot", {"path": path, "maxWidth": 320, "format": "jpeg"})

        with Image.open(path) as image:
            self.assertEqual((image.format, image.size), ("JPEG", (320, 180)))
        self.assertEqual(result["bytes"], os.path.getsize(path))
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    @unittest.skipIf(Image is None, "Pillow is not installed")
    async def test_never_scales_up_and_keeps_the_captured_png_when_it_fits(self) -> None:
        await self.connected()
        self.pmd3.png = decodable_png(640, 360)
        path = self.shot_path("shot.png")

        await self.worker.call("screenshot", {"path": path, "maxWidth": 1280})

        with open(path, "rb") as f:
            self.assertEqual(f.read(), self.pmd3.png)

    @unittest.skipIf(Image is None, "Pillow is not installed")
    async def test_scales_a_png_down_without_changing_its_format(self) -> None:
        await self.connected()
        self.pmd3.png = decodable_png(640, 360)
        path = self.shot_path("shot.png")

        await self.worker.call("screenshot", {"path": path, "maxWidth": 160, "format": "png"})

        with Image.open(path) as image:
            self.assertEqual((image.format, image.size), ("PNG", (160, 90)))

    async def test_rejects_an_unknown_format_or_a_max_width_that_is_not_a_positive_integer(self) -> None:
        path = self.shot_path("shot.png")
        for params, field in (
            ({"format": "gif"}, "format"),
            ({"maxWidth": 0}, "maxWidth"),
            ({"maxWidth": 12.5}, "maxWidth"),
            ({"maxWidth": "1280"}, "maxWidth"),
            ({"maxWidth": True}, "maxWidth"),
        ):
            error = await self.worker.error("screenshot", {"path": path, **params})
            self.assertEqual((error["code"], error["details"]), ("BAD_REQUEST", {"field": field}), params)


class ForegroundTest(ScreenWorkerTestCase):
    async def foreground(self, *shown: str):
        self.pmd3.show(*shown)
        return await self.worker.call("foreground")

    async def test_the_home_screen_is_headboard_in_the_foreground(self) -> None:
        await self.connected()
        self.assertEqual(await self.foreground("com.apple.HeadBoard"), {"kind": "home"})

    async def test_the_accessibility_overlay_left_in_front_after_a_focus_move_is_not_an_app(self) -> None:
        await self.connected()
        self.assertEqual(await self.foreground("com.apple.HeadBoard", "com.apple.AccessibilityUIServer"), {"kind": "home"})

    async def test_names_the_app_in_the_foreground_by_its_display_name(self) -> None:
        await self.connected()
        self.assertEqual(
            await self.foreground("com.disney.disneyplus"),
            {"kind": "app", "bundleId": "com.disney.disneyplus", "name": "Disney+"},
        )

    async def test_an_app_still_launching_over_the_home_screen_is_the_foreground_app(self) -> None:
        await self.connected()
        self.assertEqual(
            await self.foreground("com.netflix.Netflix", "com.apple.HeadBoard"),
            {"kind": "app", "bundleId": "com.netflix.Netflix", "name": "Netflix"},
        )

    async def test_the_screensaver_is_idlescreen_in_the_foreground(self) -> None:
        await self.connected()
        self.assertEqual(
            await self.foreground("com.apple.HeadBoard", "AerialPoster", "com.apple.IdleScreen"),
            {"kind": "screensaver"},
        )

    async def test_several_apps_in_the_foreground_are_reported_without_a_guess(self) -> None:
        await self.connected()
        self.assertEqual(
            await self.foreground("com.netflix.Netflix", "com.apple.TVSettings"),
            {
                "kind": "ambiguous",
                "apps": [
                    {"bundleId": "com.apple.TVSettings", "name": "Settings"},
                    {"bundleId": "com.netflix.Netflix", "name": "Netflix"},
                ],
            },
        )

    async def test_fails_when_nothing_but_the_system_shell_is_in_the_foreground(self) -> None:
        await self.connected()
        self.pmd3.show()

        error = await self.worker.error("foreground")

        self.assertEqual(error["code"], "SCREEN_FAILED")
        self.assertIn("no app in the foreground", error["message"])

    async def test_reads_over_the_tunnel_the_worker_holds_and_retries_on_a_fresh_one(self) -> None:
        await self.connected()
        await self.foreground("com.apple.HeadBoard")
        self.assertEqual(self.pmd3.tunnel_opens, 1)
        self.pmd3.fail_next = [ConnectionResetError("stale tunnel")]

        self.assertEqual(await self.foreground("com.apple.HeadBoard"), {"kind": "home"})

        self.assertEqual(self.pmd3.tunnel_opens, 2)

    async def test_answers_screen_not_paired_without_a_pair_record(self) -> None:
        await self.worker.close()
        self.pmd3 = fake_pmd3.FakePmd3()
        self.worker = self.start_worker()

        self.assertEqual((await self.worker.error("foreground"))["code"], "SCREEN_NOT_PAIRED")
        self.assertEqual(self.pmd3.proclist_reads, 0)


class PairingTest(ScreenWorkerTestCase):
    identifier = ""
    records = []

    async def test_pairs_with_the_pin_from_pair_pin_then_opens_the_tunnel(self) -> None:
        await self.status("unpaired")

        self.assertEqual(await self.worker.call("pair.begin"), {})
        identifier, host, port, thread = self.pmd3.manual_connects[0]
        self.assertEqual((identifier, host, port), (self.pmd3.pairing_identifier, "192.168.1.50", 49160))

        result = await self.worker.call("pair.pin", {"pin": "123456"})

        self.assertEqual(result, {"identifier": self.pmd3.pairing_identifier})
        status = await self.connected()
        self.assertEqual(status["identifier"], self.pmd3.pairing_identifier)

    async def test_a_wrong_pin_fails_the_pairing_and_leaves_no_record(self) -> None:
        await self.worker.call("pair.begin")

        error = await self.worker.error("pair.pin", {"pin": "000000"})

        self.assertEqual(error["code"], "PAIRING_FAILED")
        self.assertEqual(self.pmd3.records, [])
        self.assertEqual((await self.worker.error("pair.pin", {"pin": "123456"}))["code"], "PAIRING_NOT_FOUND")

    async def test_begin_fails_when_the_apple_tv_does_not_offer_manual_pairing(self) -> None:
        self.pmd3.advertises_manual_pairing = False

        error = await self.worker.error("pair.begin")

        self.assertEqual(error["code"], "PAIRING_FAILED")
        self.assertIn("Remote App and Devices", error["message"])
        self.assertGreaterEqual(self.pmd3.manual_browses, 2)

    async def test_begin_reports_a_rejection_from_the_apple_tv(self) -> None:
        self.pmd3.pairing_rejection = "BackOff"
        error = await self.worker.error("pair.begin")
        self.assertEqual(error["code"], "PAIRING_FAILED")
        self.assertIn("BackOff", error["message"])

    async def test_cancel_ends_a_pairing_waiting_for_its_pin(self) -> None:
        await self.worker.call("pair.begin")
        self.assertEqual(await self.worker.call("pair.cancel"), {})
        self.assertEqual((await self.worker.error("pair.pin", {"pin": "123456"}))["code"], "PAIRING_NOT_FOUND")
        self.assertEqual((await self.worker.call("pair.begin")), {})

    async def test_a_pairing_confirmed_after_pair_pin_gave_up_still_opens_the_tunnel(self) -> None:
        self.pmd3.pairing_confirm_delay_s = 0.8
        await self.worker.call("pair.begin")

        self.assertEqual((await self.worker.error("pair.pin", {"pin": "123456"}))["code"], "DEVICE_TIMEOUT")

        status = await self.connected()
        self.assertEqual(status["identifier"], self.pmd3.pairing_identifier)

    async def test_pin_must_be_digits(self) -> None:
        await self.worker.call("pair.begin")
        error = await self.worker.error("pair.pin", {"pin": "12ab"})
        self.assertEqual(error["details"], {"field": "pin"})


class FakeWorkerStdioTest(unittest.TestCase):
    """`python -m agent_atv_screen --fake`, which the plugin's tests and e2e run (DESIGN.md §6.4)."""

    def start(self, *args: str) -> BridgeProcess:
        worker = BridgeProcess("--fake", "--address", "127.0.0.1", *args, module="agent_atv_screen")
        self.addCleanup(worker.stop)
        return worker

    def test_announces_ready_then_its_tunnel_status(self) -> None:
        worker = self.start()
        ready = worker.next_message()
        self.assertEqual((ready["event"], ready["data"]["backend"], ready["data"]["pymobiledevice3"]), ("ready", "fake", None))
        self.assertEqual(worker.next_message()["data"], {"tunnel": "unpaired", "identifier": None, "error": None})

    def test_pairs_with_pin_1234_then_reads_focus_and_captures(self) -> None:
        worker = self.start()
        self.assertEqual(worker.request("focus")["error"]["code"], "SCREEN_NOT_PAIRED")
        self.assertEqual(worker.request("follow")["error"]["code"], "SCREEN_NOT_PAIRED")
        self.assertTrue(worker.request("pair.begin")["ok"])
        self.assertEqual(worker.request("pair.pin", {"pin": "1234"})["result"], {"identifier": "FAKE-REMOTEPAIRING-0001"})
        self.assertEqual(worker.request("follow")["result"], {"moves": 0})
        # Its focus has always just moved, so a focus read after any key press finds it.
        self.assertEqual(
            worker.request("focus")["result"],
            {"focus": {"label": "Fake focus", "value": None, "identifier": "fake/focus"}, "ageMs": 0},
        )
        path = os.path.join(tempfile.mkdtemp(), "fake.png")
        self.assertTrue(worker.request("screenshot", {"path": path})["ok"])
        with open(path, "rb") as f:
            self.assertEqual(struct.unpack(">II", f.read(24)[16:24]), (1920, 1080))
        os.remove(path)

    def test_its_scaled_down_jpeg_carries_the_scaled_size(self) -> None:
        worker = self.start("--identifier", "FAKE-REMOTEPAIRING-0001")
        path = os.path.join(tempfile.mkdtemp(), "fake.jpg")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))

        self.assertTrue(worker.request("screenshot", {"path": path, "maxWidth": 1280, "format": "jpeg"})["ok"])

        with open(path, "rb") as f:
            data = f.read()
        # SOI, then a baseline SOF0 segment: length, precision, height, width.
        self.assertEqual(data[:4], b"\xff\xd8\xff\xc0")
        self.assertEqual(struct.unpack(">HH", data[7:11]), (720, 1280))

    def test_its_apple_tv_shows_the_home_screen(self) -> None:
        worker = self.start("--identifier", "FAKE-REMOTEPAIRING-0001")
        self.assertEqual(worker.request("foreground")["result"], {"kind": "home"})

    def test_starts_paired_when_given_an_identifier_and_exits_on_shutdown(self) -> None:
        worker = self.start("--identifier", "FAKE-REMOTEPAIRING-0001")
        self.assertEqual(worker.request("ping")["result"]["tunnel"], "connected")
        self.assertEqual(worker.request("teleport")["error"]["code"], "UNKNOWN_METHOD")
        self.assertTrue(worker.request("shutdown")["ok"])
        self.assertEqual(worker.proc.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
