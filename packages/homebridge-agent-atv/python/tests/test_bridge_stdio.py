"""Seam B1: the bridge binary over stdio, fake backend (DESIGN.md §2, §2.8)."""

import platform
import re
import time
import unittest

from tests.bridge_process import BridgeProcess


FAKE_ID = "FAKE00000001"
COMPANION = "fake-companion-creds"
AIRPLAY = "fake-airplay-creds"


class BridgeStdioTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bridge = BridgeProcess("--fake")
        self.addCleanup(self.bridge.stop)

    def test_first_line_is_the_ready_event(self) -> None:
        self.assertEqual(
            self.bridge.next_message(),
            {
                "event": "ready",
                "data": {
                    "protocolVersion": 1,
                    "bridgeVersion": "0.1.0",
                    "python": platform.python_version(),
                    "pyatv": None,
                    "backend": "fake",
                },
            },
        )

    def test_ping_answers_pong(self) -> None:
        self.bridge.next_message()
        self.assertEqual(self.bridge.request("ping"), {"id": 1, "ok": True, "result": {"pong": True}})

    def test_invalid_json_gets_a_bad_request_with_null_id_and_the_bridge_keeps_running(self) -> None:
        self.bridge.next_message()
        self.bridge.send_raw(b"{not json\n")
        response = self.bridge.response_for(None)
        self.assertEqual((response["ok"], response["error"]["code"]), (False, "BAD_REQUEST"))
        self.assertEqual(self.bridge.request("ping")["result"], {"pong": True})

    def test_request_without_method_echoes_its_id(self) -> None:
        self.bridge.next_message()
        self.bridge.send({"id": 7, "params": {}})
        response = self.bridge.response_for(7)
        self.assertEqual(response["error"]["code"], "BAD_REQUEST")

    def test_request_without_positive_integer_id_is_rejected(self) -> None:
        self.bridge.next_message()
        self.bridge.send({"id": "seven", "method": "ping", "params": {}})
        self.assertEqual(self.bridge.response_for(None)["error"]["code"], "BAD_REQUEST")

    def test_unknown_method(self) -> None:
        self.bridge.next_message()
        response = self.bridge.request("teleport")
        self.assertEqual(response["error"]["code"], "UNKNOWN_METHOD")
        self.assertEqual(response["error"]["details"], {"method": "teleport"})

    def test_shutdown_answers_then_exits_zero(self) -> None:
        self.bridge.next_message()
        self.assertEqual(self.bridge.request("shutdown"), {"id": 1, "ok": True, "result": {}})
        self.assertEqual(self.bridge.proc.wait(timeout=5), 0)

    def test_stdin_eof_exits_zero(self) -> None:
        self.bridge.next_message()
        self.bridge.close_stdin()
        self.assertEqual(self.bridge.proc.wait(timeout=5), 0)

    def test_sigterm_exits_zero(self) -> None:
        self.bridge.next_message()
        self.bridge.proc.terminate()
        self.assertEqual(self.bridge.proc.wait(timeout=5), 0)


IDLE = {
    "state": "idle", "mediaType": "unknown", "title": None, "artist": None, "album": None,
    "seriesName": None, "season": None, "episode": None, "position": None, "totalTime": None,
}
INITIAL_STATE = {
    "device": {
        "id": FAKE_ID, "name": "Fake Apple TV", "model": "Apple TV 4K (gen 3)", "os": "tvOS",
        "version": "27.2", "address": "127.0.0.1", "mac": "FA:KE:00:00:00:01",
    },
    "power": "on",
    "nowPlaying": {"bundleId": "com.apple.TVWatchList", "name": "TV"},
    "playing": IDLE,
    "keyboard": {"focus": "unfocused", "text": None},
    "volume": 50,
    "protocols": {"companion": True, "airplay": True},
}


class FakeLatencyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bridge = BridgeProcess("--fake", env={"AGENT_ATV_FAKE_LATENCY_MS": "300"})
        self.addCleanup(self.bridge.stop)
        self.bridge.next_message()
        self.bridge.request("connect", {"device": FAKE_ID, "credentials": {"companion": COMPANION}})

    def test_actions_on_one_device_run_one_after_another_while_reads_do_not_wait(self) -> None:
        started = time.monotonic()
        self.bridge.send({"id": 101, "method": "key", "params": {"device": FAKE_ID, "key": "up"}})
        self.bridge.send({"id": 102, "method": "key", "params": {"device": FAKE_ID, "key": "down"}})
        self.bridge.send({"id": 103, "method": "state", "params": {"device": FAKE_ID}})
        self.assertTrue(self.bridge.response_for(103)["ok"])
        self.assertLess(time.monotonic() - started, 0.25)
        self.bridge.response_for(101)
        self.bridge.response_for(102)
        self.assertGreaterEqual(time.monotonic() - started, 0.6)


class BridgeLoggingTest(unittest.TestCase):
    def test_stderr_lines_are_level_logger_message(self) -> None:
        bridge = BridgeProcess("--fake")
        self.addCleanup(bridge.stop)
        bridge.next_message()
        bridge.request("shutdown")
        bridge.proc.wait(timeout=5)
        bridge.stop()
        self.assertTrue(bridge.stderr_lines)
        for line in bridge.stderr_lines:
            self.assertRegex(line, r"^(DEBUG|INFO|WARNING|ERROR) [\w.]+: ")


class FakeAppleTvTest(unittest.TestCase):
    """The fake Apple TV semantics the plugin's P2 contract test relies on (§2.8)."""

    def setUp(self) -> None:
        self.bridge = BridgeProcess("--fake")
        self.addCleanup(self.bridge.stop)
        self.bridge.next_message()

    def call(self, method, params=None):
        response = self.bridge.request(method, params)
        if not response["ok"]:
            raise AssertionError(f"{method} failed: {response['error']}")
        return response["result"]

    def error(self, method, params=None):
        response = self.bridge.request(method, params)
        if response["ok"]:
            raise AssertionError(f"{method} unexpectedly succeeded: {response['result']}")
        return response["error"]

    def test_scan_finds_one_fake_apple_tv(self) -> None:
        [device] = self.call("scan", {"timeoutMs": 100})["devices"]
        self.assertEqual(
            {k: v for k, v in device.items() if k != "identifiers"},
            {
                "id": FAKE_ID,
                "name": "Fake Apple TV",
                "address": "127.0.0.1",
                "mac": "FA:KE:00:00:00:01",
                "model": "Apple TV 4K (gen 3)",
                "os": "tvOS",
                "version": "27.2",
                "services": [
                    {"protocol": "companion", "port": 49153, "pairing": "mandatory"},
                    {"protocol": "airplay", "port": 7000, "pairing": "mandatory"},
                ],
            },
        )
        self.assertIn(FAKE_ID, device["identifiers"])

    def connect(self, airplay=True):
        credentials = {"companion": COMPANION, "airplay": AIRPLAY} if airplay else {"companion": COMPANION}
        return self.call("connect", {"device": FAKE_ID, "credentials": credentials})

    def test_connect_returns_the_initial_state_and_emits_it(self) -> None:
        self.assertEqual(self.connect(), INITIAL_STATE)
        event = self.bridge.wait_event(lambda e: e["event"] == "state")
        self.assertEqual(event, {"event": "state", "device": FAKE_ID, "data": INITIAL_STATE})

    def test_connect_rejects_anything_but_the_fake_credentials(self) -> None:
        wrong_companion = self.error("connect", {"device": FAKE_ID, "credentials": {"companion": "nope"}})
        wrong_airplay = self.error("connect", {"device": FAKE_ID, "credentials": {"companion": COMPANION, "airplay": "nope"}})
        self.assertEqual((wrong_companion["code"], wrong_airplay["code"]), ("AUTH_FAILED", "AUTH_FAILED"))

    def test_connect_without_airplay_credentials_has_no_app(self) -> None:
        state = self.connect(airplay=False)
        self.assertEqual((state["nowPlaying"], state["protocols"]), (None, {"companion": True, "airplay": False}))

    def test_connect_to_an_unknown_device(self) -> None:
        error = self.error("connect", {"device": "A1B2C3D4E5F6", "credentials": {"companion": COMPANION}})
        self.assertEqual(error["code"], "DEVICE_NOT_FOUND")

    def test_connect_without_credentials_is_a_bad_request(self) -> None:
        error = self.error("connect", {"device": FAKE_ID})
        self.assertEqual((error["code"], error["details"]), ("BAD_REQUEST", {"field": "credentials"}))

    def test_state_requires_a_connection(self) -> None:
        error = self.error("state", {"device": FAKE_ID})
        self.assertEqual((error["code"], error["details"]), ("NOT_CONNECTED", {"device": FAKE_ID}))

    def test_state_after_connect(self) -> None:
        self.connect()
        self.assertEqual(self.call("state", {"device": FAKE_ID, "refresh": True}), INITIAL_STATE)

    def test_disconnect_then_state_is_not_connected(self) -> None:
        self.connect()
        self.assertEqual(self.call("disconnect", {"device": FAKE_ID}), {})
        self.assertEqual(self.call("disconnect", {"device": FAKE_ID}), {})
        self.assertEqual(self.error("state", {"device": FAKE_ID})["code"], "NOT_CONNECTED")

    def press(self, key, action=None):
        params = {"device": FAKE_ID, "key": key}
        if action:
            params["action"] = action
        return self.call("key", params)

    def playing(self):
        return self.call("state", {"device": FAKE_ID})["playing"]

    def test_play_pause_starts_the_fake_movie_then_toggles_and_stop_goes_idle(self) -> None:
        self.connect()
        self.assertEqual(self.press("play_pause"), {})
        started = self.playing()
        self.assertEqual(
            (started["state"], started["mediaType"], started["title"], started["totalTime"], started["position"]),
            ("playing", "video", "Fake Movie", 5400, 0),
        )
        self.press("play_pause")
        self.assertEqual(self.playing()["state"], "paused")
        self.press("play_pause")
        self.assertEqual(self.playing()["state"], "playing")
        self.press("stop")
        self.assertEqual(self.playing(), IDLE)

    def test_a_key_press_that_changes_state_emits_a_state_event(self) -> None:
        self.connect()
        self.bridge.wait_event(lambda e: e["event"] == "state")
        self.press("play_pause")
        event = self.bridge.wait_event(lambda e: e["event"] == "state")
        self.assertEqual(event["data"]["playing"]["state"], "playing")

    def test_volume_keys_step_by_five_and_clamp(self) -> None:
        self.connect()
        self.press("volume_up")
        self.assertEqual(self.call("state", {"device": FAKE_ID})["volume"], 55)
        for _ in range(12):
            self.press("volume_down")
        self.assertEqual(self.call("state", {"device": FAKE_ID})["volume"], 0)

    def test_position_advances_while_playing(self) -> None:
        self.connect()
        self.press("play_pause")
        time.sleep(1.2)
        self.assertGreaterEqual(self.playing()["position"], 1)

    def test_unknown_key_and_unsupported_action_are_bad_requests(self) -> None:
        self.connect()
        unknown = self.error("key", {"device": FAKE_ID, "key": "launch_missiles"})
        held = self.error("key", {"device": FAKE_ID, "key": "play_pause", "action": "hold"})
        self.assertEqual((unknown["code"], unknown["details"]), ("BAD_REQUEST", {"field": "key"}))
        self.assertEqual((held["code"], held["details"]), ("BAD_REQUEST", {"field": "action"}))

    def test_navigation_keys_accept_double_and_hold(self) -> None:
        self.connect()
        self.assertEqual(self.press("select", "hold"), {})
        self.assertEqual(self.press("up", "double"), {})

    def launch(self, target):
        return self.call("app.launch", {"device": FAKE_ID, "target": target})

    def snapshot(self):
        return self.call("state", {"device": FAKE_ID})

    def test_apps_are_sorted_by_name(self) -> None:
        self.connect()
        self.assertEqual(
            self.call("apps.list", {"device": FAKE_ID}),
            {
                "apps": [
                    {"bundleId": "com.netflix.Netflix", "name": "Netflix"},
                    {"bundleId": "com.apple.TVSearch", "name": "Search"},
                    {"bundleId": "com.apple.TVSettings", "name": "Settings"},
                    {"bundleId": "com.apple.TVWatchList", "name": "TV"},
                    {"bundleId": "com.google.ios.youtube", "name": "YouTube"},
                ]
            },
        )

    def test_launching_search_focuses_the_keyboard_and_another_app_unfocuses_it(self) -> None:
        self.connect()
        self.assertEqual(self.launch("com.apple.TVSearch"), {})
        search = self.snapshot()
        self.assertEqual(
            (search["nowPlaying"], search["keyboard"]),
            ({"bundleId": "com.apple.TVSearch", "name": "Search"}, {"focus": "focused", "text": ""}),
        )
        self.launch("com.netflix.Netflix")
        netflix = self.snapshot()
        self.assertEqual(
            (netflix["nowPlaying"], netflix["keyboard"]),
            ({"bundleId": "com.netflix.Netflix", "name": "Netflix"}, {"focus": "unfocused", "text": None}),
        )

    def test_home_returns_to_the_tv_app(self) -> None:
        self.connect()
        self.launch("com.apple.TVSearch")
        self.press("home")
        state = self.snapshot()
        self.assertEqual(
            (state["nowPlaying"]["bundleId"], state["keyboard"]["focus"]), ("com.apple.TVWatchList", "unfocused")
        )

    def test_launching_an_unknown_bundle_fails_and_a_url_changes_nothing(self) -> None:
        self.connect()
        error = self.error("app.launch", {"device": FAKE_ID, "target": "com.example.Nope"})
        self.assertEqual((error["code"], error["details"]), ("LAUNCH_FAILED", {"target": "com.example.Nope"}))
        self.assertEqual(self.launch("https://example.com/watch"), {})
        self.assertEqual(self.snapshot(), INITIAL_STATE)

    def test_keyboard_set_append_clear_in_a_focused_field(self) -> None:
        self.connect()
        self.launch("com.apple.TVSearch")
        self.assertEqual(self.call("keyboard.set", {"device": FAKE_ID, "text": "stranger"}), {"focus": "focused", "text": "stranger"})
        self.assertEqual(self.call("keyboard.append", {"device": FAKE_ID, "text": " things"}), {"focus": "focused", "text": "stranger things"})
        self.assertEqual(self.call("keyboard.get", {"device": FAKE_ID}), {"focus": "focused", "text": "stranger things"})
        self.assertEqual(self.snapshot()["keyboard"], {"focus": "focused", "text": "stranger things"})
        self.assertEqual(self.call("keyboard.clear", {"device": FAKE_ID}), {"focus": "focused", "text": ""})

    def test_keyboard_edits_need_a_focused_field(self) -> None:
        self.connect()
        self.assertEqual(self.call("keyboard.get", {"device": FAKE_ID}), {"focus": "unfocused", "text": None})
        error = self.error("keyboard.set", {"device": FAKE_ID, "text": "x"})
        self.assertEqual(error["code"], "KEYBOARD_NOT_FOCUSED")

    def test_while_off_every_action_but_power_set_fails_with_device_off(self) -> None:
        self.connect()
        self.assertEqual(self.call("power.set", {"device": FAKE_ID, "on": False}), {"power": "off"})
        self.assertEqual(self.snapshot()["power"], "off")
        for method, params in [
            ("key", {"key": "select"}),
            ("app.launch", {"target": "com.netflix.Netflix"}),
            ("volume.set", {"level": 10}),
            ("seek", {"position": 10}),
        ]:
            with self.subTest(method=method):
                self.assertEqual(self.error(method, {"device": FAKE_ID, **params})["code"], "DEVICE_OFF")
        self.assertEqual(self.call("power.set", {"device": FAKE_ID, "on": True}), {"power": "on"})
        self.assertEqual(self.press("select"), {})

    def test_volume_set(self) -> None:
        self.connect()
        self.assertEqual(self.call("volume.set", {"device": FAKE_ID, "level": 30}), {"volume": 30})
        self.assertEqual(self.snapshot()["volume"], 30)

    def test_volume_out_of_range_is_a_bad_request(self) -> None:
        self.connect()
        error = self.error("volume.set", {"device": FAKE_ID, "level": 101})
        self.assertEqual((error["code"], error["details"]), ("BAD_REQUEST", {"field": "level"}))

    def test_seek_moves_the_position(self) -> None:
        self.connect()
        self.press("play_pause")
        self.press("play_pause")
        self.assertEqual(self.call("seek", {"device": FAKE_ID, "position": 600}), {})
        self.assertEqual(self.playing()["position"], 600)

    def begin(self, protocol):
        return self.call("pair.begin", {"device": FAKE_ID, "protocol": protocol, "remoteName": "agent-atv (test)"})

    def test_pairing_each_protocol_with_the_right_pin_yields_its_fake_credentials(self) -> None:
        for protocol, credentials in [("companion", COMPANION), ("airplay", AIRPLAY)]:
            with self.subTest(protocol=protocol):
                begun = self.begin(protocol)
                self.assertRegex(begun["pairingId"], r"^p-[0-9a-f]{12}$")
                self.assertEqual((begun["protocol"], begun["deviceProvidesPin"]), (protocol, True))
                finished = self.call("pair.pin", {"pairingId": begun["pairingId"], "pin": "1234"})
                self.assertEqual(finished, {"protocol": protocol, "credentials": credentials})

    def test_a_wrong_pin_fails_and_ends_the_pairing(self) -> None:
        pairing_id = self.begin("companion")["pairingId"]
        self.assertEqual(self.error("pair.pin", {"pairingId": pairing_id, "pin": "9999"})["code"], "PAIRING_FAILED")
        self.assertEqual(self.error("pair.pin", {"pairingId": pairing_id, "pin": "1234"})["code"], "PAIRING_NOT_FOUND")

    def test_pin_0000_triggers_a_backoff(self) -> None:
        pairing_id = self.begin("companion")["pairingId"]
        error = self.error("pair.pin", {"pairingId": pairing_id, "pin": "0000"})
        self.assertEqual((error["code"], error["details"]), ("PAIRING_BACKOFF", {"retryAfterSec": 30}))

    def test_one_pairing_at_a_time_per_device(self) -> None:
        first = self.begin("companion")["pairingId"]
        error = self.error("pair.begin", {"device": FAKE_ID, "protocol": "airplay", "remoteName": "x"})
        self.assertEqual((error["code"], error["details"]), ("PAIRING_IN_PROGRESS", {"pairingId": first}))
        self.assertEqual(self.call("pair.cancel", {"pairingId": first}), {})
        self.assertEqual(self.begin("airplay")["protocol"], "airplay")

    def test_cancelling_an_unknown_pairing_is_fine(self) -> None:
        self.assertEqual(self.call("pair.cancel", {"pairingId": "p-000000000000"}), {})

    def test_a_pin_must_be_four_digits(self) -> None:
        pairing_id = self.begin("companion")["pairingId"]
        error = self.error("pair.pin", {"pairingId": pairing_id, "pin": "12a4"})
        self.assertEqual((error["code"], error["details"]), ("BAD_REQUEST", {"field": "pin"}))

    def test_verify_accepts_only_the_fake_airplay_credentials(self) -> None:
        verify = lambda creds: self.call(
            "pair.verify", {"device": FAKE_ID, "protocol": "airplay", "credentials": creds}
        )["valid"]
        self.assertEqual((verify(AIRPLAY), verify(COMPANION)), (True, False))


if __name__ == "__main__":
    unittest.main()
