"""Seam B2: serve(PyatvBackend(fake_pyatv), reader, writer) with pyatv faked at its boundary."""

from __future__ import annotations

import asyncio
import unittest

from agent_atv_bridge.backend_pyatv import PyatvBackend
from agent_atv_bridge.publisher import Timings
from tests import fake_pyatv as fp
from tests.in_process_bridge import InProcessBridge

DEVICE = "A1B2C3D4E5F6"
FAST = Timings(debounce_s=0.02, poll_s=0.05, position_only_s=0.4, pairing_ttl_s=0.2, call_timeout_s=0.3)


class PyatvBridgeTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.pyatv = fp.FakePyatv()
        self.bridge = InProcessBridge(PyatvBackend(self.pyatv, timings=FAST))

    async def asyncTearDown(self) -> None:
        await self.bridge.close()


class ScanTest(PyatvBridgeTestCase):
    async def test_ready_reports_the_pyatv_backend_and_version(self) -> None:
        ready = await self.bridge.next_event("ready")
        self.assertEqual((ready["data"]["backend"], ready["data"]["pyatv"]), ("pyatv", "0.18.0"))

    async def test_scan_lists_tvos_devices_only(self) -> None:
        homepod = fp.FakeConfig(
            name="Kitchen", address="192.168.1.60",
            device_info=fp.FakeDeviceInfo(operating_system=fp.OperatingSystem.Unknown, mac="AA:00:00:00:00:01"),
            identifiers=["AA:00:00:00:00:01"],
        )
        self.pyatv.fake_devices.append(homepod)
        result = await self.bridge.call("scan", {"timeoutMs": 3000, "hosts": ["192.168.1.50", "192.168.1.60"]})
        self.assertEqual(
            result,
            {
                "devices": [
                    {
                        "id": "A1B2C3D4E5F6", "name": "Living Room", "address": "192.168.1.50",
                        "mac": "A1:B2:C3:D4:E5:F6", "model": "Apple TV 4K (gen 3)", "os": "tvOS", "version": "27.2",
                        "identifiers": ["0E5C1C1E-3A4B-4C7D-9E2F-6A1B2C3D4E5F", "A1:B2:C3:D4:E5:F6", "A1B2C3D4E5F6"],
                        "services": [
                            {"protocol": "companion", "port": 49153, "pairing": "mandatory"},
                            {"protocol": "airplay", "port": 7000, "pairing": "mandatory"},
                        ],
                    }
                ]
            },
        )
        self.assertEqual(self.pyatv.fake_scans[-1]["timeout"], 3)
        self.assertEqual(self.pyatv.fake_scans[-1]["hosts"], ["192.168.1.50", "192.168.1.60"])

    async def test_scan_resolves_host_names_in_hosts(self) -> None:
        await self.bridge.call("scan", {"hosts": ["localhost", "192.168.1.50"]})
        self.assertEqual(self.pyatv.fake_scans[-1]["hosts"], ["127.0.0.1", "192.168.1.50"])

    async def test_scan_leaves_out_homepods_that_pyatv_labels_tvos(self) -> None:
        # pyatv 0.18 reports HomePod minis as tvOS, with Companion pairing unsupported.
        self.pyatv.fake_devices += [
            fp.FakeConfig(
                name="Office", address="192.168.1.71",
                device_info=fp.FakeDeviceInfo(model_str="HomePod mini", mac="AA:00:00:00:00:02"),
                identifiers=["AA:00:00:00:00:02"],
            ),
            fp.FakeConfig(
                name="Hallway", address="192.168.1.72",
                device_info=fp.FakeDeviceInfo(model_str="Unknown", mac="AA:00:00:00:00:03"),
                services=[fp.FakeService(fp.Protocol.Companion, 49153, "AA:00:00:00:00:03",
                                         pairing=fp.PairingRequirement.Unsupported)],
                identifiers=["AA:00:00:00:00:03"],
            ),
        ]
        result = await self.bridge.call("scan")
        self.assertEqual([device["name"] for device in result["devices"]], ["Living Room"])

    async def test_device_without_mac_is_identified_by_its_pyatv_identifier(self) -> None:
        self.pyatv.fake_devices = [
            fp.FakeConfig(device_info=fp.FakeDeviceInfo(mac=None), identifiers=["0E5C1C1E-3A4B-4C7D-9E2F-6A1B2C3D4E5F"])
        ]
        [device] = (await self.bridge.call("scan"))["devices"]
        self.assertEqual((device["id"], device["mac"]), ("0E5C1C1E-3A4B-4C7D-9E2F-6A1B2C3D4E5F", None))


CREDENTIALS = {"companion": "companion-secret", "airplay": "airplay-secret"}
IDLE = {
    "state": "idle", "mediaType": "unknown", "title": None, "artist": None, "album": None,
    "seriesName": None, "season": None, "episode": None, "position": None, "totalTime": None,
}
LIVING_ROOM = {
    "id": DEVICE, "name": "Living Room", "model": "Apple TV 4K (gen 3)", "os": "tvOS", "version": "27.2",
    "address": "192.168.1.50", "mac": "A1:B2:C3:D4:E5:F6",
}


class ConnectedTestCase(PyatvBridgeTestCase):
    async def connect(self, credentials=None, **params):
        return await self.bridge.call(
            "connect", {"device": DEVICE, "credentials": credentials or CREDENTIALS, **params}
        )


class ConnectTest(ConnectedTestCase):
    async def test_connect_returns_the_state_read_from_pyatv(self) -> None:
        state = await self.connect(address="192.168.1.50")
        self.assertEqual(
            state,
            {
                "device": LIVING_ROOM,
                "power": "on",
                "nowPlaying": {"bundleId": "com.apple.TVWatchList", "name": "TV"},
                "playing": IDLE,
                "keyboard": {"focus": "unfocused", "text": None},
                "volume": 35,
                "protocols": {"companion": True, "airplay": True},
            },
        )
        self.assertEqual(self.pyatv.fake_scans[-1]["identifier"], DEVICE)
        self.assertEqual(self.pyatv.fake_scans[-1]["hosts"], ["192.168.1.50"])

    async def test_connect_hands_each_credential_to_its_protocol_and_starts_push_updates(self) -> None:
        await self.connect()
        config = self.pyatv.fake_connected_configs[-1]
        self.assertEqual(
            (config.get_service(fp.Protocol.Companion).credentials, config.get_service(fp.Protocol.AirPlay).credentials),
            ("companion-secret", "airplay-secret"),
        )
        self.assertTrue(self.pyatv.fake_atv.push_updater.active)

    async def test_connect_emits_the_state(self) -> None:
        state = await self.connect()
        event = await self.bridge.next_event("state")
        self.assertEqual((event["device"], event["data"]), (DEVICE, state))

    async def test_connect_is_idempotent(self) -> None:
        first = await self.connect()
        self.assertEqual(await self.connect(), first)
        self.assertEqual(len(self.pyatv.fake_connected), 1)

    async def test_connect_to_a_device_the_scan_does_not_find(self) -> None:
        self.pyatv.fake_devices = []
        error = await self.bridge.error("connect", {"device": DEVICE, "credentials": CREDENTIALS})
        self.assertEqual((error["code"], error["details"]), ("DEVICE_NOT_FOUND", {"device": DEVICE}))

    async def test_connect_falls_back_to_a_multicast_scan_when_the_address_is_stale(self) -> None:
        await self.connect(address="192.168.1.99")
        self.assertEqual(
            [(scan["identifier"], scan["hosts"]) for scan in self.pyatv.fake_scans[-2:]],
            [(DEVICE, ["192.168.1.99"]), (DEVICE, None)],
        )
        self.assertEqual(len(self.pyatv.fake_connected), 1)

    async def test_connect_resolves_a_host_name_before_the_unicast_scan(self) -> None:
        await self.connect(address="localhost")
        self.assertEqual(self.pyatv.fake_scans[0]["hosts"], ["127.0.0.1"])

    async def test_companion_only_reports_airplay_as_not_connected(self) -> None:
        state = await self.connect({"companion": "companion-secret"})
        self.assertEqual(state["protocols"], {"companion": True, "airplay": False})

    async def test_connect_failures_map_to_bridge_error_codes(self) -> None:
        cases = [
            (fp.AuthenticationError("bad"), "AUTH_FAILED"),
            (fp.InvalidCredentialsError("bad"), "AUTH_FAILED"),
            (fp.NoCredentialsError("none"), "AUTH_FAILED"),
            (fp.InvalidResponseError("Failed to set up remote control channel (403)"), "ACCESS_DENIED"),
            (fp.InvalidResponseError("something else"), "DEVICE_ERROR"),
            (fp.ConnectionFailedError("refused"), "DEVICE_ERROR"),
            (fp.OperationTimeoutError("slow"), "DEVICE_TIMEOUT"),
            (asyncio.TimeoutError(), "DEVICE_TIMEOUT"),
            (fp.NotSupportedError("nope"), "NOT_SUPPORTED"),
        ]
        for exception, code in cases:
            with self.subTest(exception=type(exception).__name__, code=code):
                self.pyatv.fake_connect_error = exception
                error = await self.bridge.error("connect", {"device": DEVICE, "credentials": CREDENTIALS})
                self.assertEqual(error["code"], code)

    async def test_unexpected_pyatv_errors_name_the_exception(self) -> None:
        self.pyatv.fake_connect_error = fp.ConnectionFailedError("refused")
        error = await self.bridge.error("connect", {"device": DEVICE, "credentials": CREDENTIALS})
        self.assertEqual(error["details"], {"exception": "ConnectionFailedError"})

    async def test_messages_never_contain_credentials(self) -> None:
        self.pyatv.fake_connect_error = fp.AuthenticationError("rejected companion-secret")
        error = await self.bridge.error("connect", {"device": DEVICE, "credentials": CREDENTIALS})
        self.assertNotIn("companion-secret", error["message"])


class KeyTest(ConnectedTestCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        await self.connect()
        self.rc = self.pyatv.fake_atv.remote_control

    async def press(self, key, action=None):
        params = {"device": DEVICE, "key": key}
        if action is not None:
            params["action"] = action
        return await self.bridge.request("key", params)

    async def test_navigation_keys_carry_the_input_action(self) -> None:
        await self.press("select")
        await self.press("up", "double")
        await self.press("home", "hold")
        self.assertEqual(
            self.rc.fake_calls,
            [
                ("select", (), {"action": fp.InputAction.SingleTap}),
                ("up", (), {"action": fp.InputAction.DoubleTap}),
                ("home", (), {"action": fp.InputAction.Hold}),
            ],
        )

    async def test_every_other_key_is_a_plain_call(self) -> None:
        keys = [
            "home_hold", "top_menu", "play", "pause", "play_pause", "stop", "next", "previous", "volume_up",
            "volume_down", "channel_up", "channel_down", "screensaver", "guide", "control_center",
            "skip_forward", "skip_backward",
        ]
        for key in keys:
            self.assertTrue((await self.press(key))["ok"], key)
        self.assertEqual(self.rc.fake_calls, [(key, (), {}) for key in keys])

    async def test_keys_need_a_connection(self) -> None:
        error = (await self.bridge.request("key", {"device": "FFFFFFFFFFFF", "key": "up"}))["error"]
        self.assertEqual((error["code"], error["details"]), ("NOT_CONNECTED", {"device": "FFFFFFFFFFFF"}))

    async def test_key_failures_map_to_bridge_error_codes(self) -> None:
        cases = [
            (fp.NotSupportedError("no"), "NOT_SUPPORTED", {"feature": "guide"}),
            (fp.CommandError("boom"), "DEVICE_ERROR", {"exception": "CommandError"}),
            (fp.AuthenticationError("later"), "DEVICE_ERROR", {"exception": "AuthenticationError"}),
            (RuntimeError("bug"), "INTERNAL", {"exception": "RuntimeError"}),
        ]
        for exception, code, details in cases:
            with self.subTest(code=code, exception=type(exception).__name__):
                self.rc.fake_errors["guide"] = exception
                error = (await self.press("guide"))["error"]
                self.assertEqual((error["code"], error["details"]), (code, details))

    async def test_actions_on_a_device_wait_for_the_previous_one_while_reads_do_not(self) -> None:
        gate = asyncio.Event()
        self.rc.fake_gates["up"] = gate
        up = self.bridge.send("key", {"device": DEVICE, "key": "up"})
        down = self.bridge.send("key", {"device": DEVICE, "key": "down"})
        self.assertTrue((await self.bridge.request("state", {"device": DEVICE}))["ok"])
        self.assertEqual([call[0] for call in self.rc.fake_calls], ["up"])
        gate.set()
        await self.bridge.response(up)
        await self.bridge.response(down)
        self.assertEqual([call[0] for call in self.rc.fake_calls], ["up", "down"])

    async def test_a_pyatv_call_that_never_returns_times_out_and_frees_the_device(self) -> None:
        self.rc.fake_gates["up"] = asyncio.Event()
        error = (await self.press("up"))["error"]
        self.assertEqual(error["code"], "DEVICE_TIMEOUT")
        self.assertTrue((await self.press("down"))["ok"])


class EventTest(ConnectedTestCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        await self.connect()
        await self.bridge.next_event("state")
        self.atv = self.pyatv.fake_atv

    def movie(self, state=fp.DeviceState.Playing, position=723):
        return fp.FakePlaying(
            device_state=state, media_type=fp.MediaType.Video, title="Chapter One",
            series_name="Stranger Things", season_number=4, episode_number=1, position=position, total_time=3490,
        )

    async def test_playstatus_updates_are_debounced_into_one_state_event(self) -> None:
        updater = self.atv.push_updater
        updater.listener.playstatus_update(updater, self.movie(fp.DeviceState.Loading))
        updater.listener.playstatus_update(updater, self.movie(fp.DeviceState.Paused))
        updater.listener.playstatus_update(updater, self.movie())
        event = await self.bridge.next_event("state")
        self.assertEqual(
            event["data"]["playing"],
            {
                "state": "playing", "mediaType": "video", "title": "Chapter One", "artist": None, "album": None,
                "seriesName": "Stranger Things", "season": 4, "episode": 1, "position": 723, "totalTime": 3490,
            },
        )
        await asyncio.sleep(0.15)
        self.assertEqual(len(self.bridge.events("state")), 2)

    async def test_power_and_volume_listeners_emit_state(self) -> None:
        self.atv.power.fake_state = fp.PowerState.Off
        self.atv.power.listener.powerstate_update(fp.PowerState.On, fp.PowerState.Off)
        self.assertEqual((await self.bridge.next_event("state"))["data"]["power"], "off")
        self.atv.audio.fake_volume = 60.4
        self.atv.audio.listener.volume_update(35.0, 60.4)
        self.assertEqual((await self.bridge.next_event("state"))["data"]["volume"], 60)

    async def test_volume_is_null_while_pyatv_reports_it_unavailable(self) -> None:
        self.atv.features.fake_states[fp.FeatureName.Volume] = fp.FeatureState.Unavailable
        self.atv.audio.fake_volume = 0.0
        self.assertIsNone((await self.bridge.next_event("state"))["data"]["volume"])

    async def test_app_changes_are_picked_up_by_polling(self) -> None:
        self.atv.metadata.fake_app = fp.FakeApp("Netflix", "com.netflix.Netflix")
        event = await self.bridge.next_event("state")
        self.assertEqual(event["data"]["nowPlaying"], {"bundleId": "com.netflix.Netflix", "name": "Netflix"})

    async def test_an_app_without_a_name_is_named_by_its_bundle_id(self) -> None:
        self.atv.metadata.fake_app = fp.FakeApp(None, "com.netflix.Netflix")
        event = await self.bridge.next_event("state")
        self.assertEqual(event["data"]["nowPlaying"], {"bundleId": "com.netflix.Netflix", "name": "com.netflix.Netflix"})

    async def test_a_position_only_change_is_held_back(self) -> None:
        updater = self.atv.push_updater
        updater.listener.playstatus_update(updater, self.movie(position=100))
        await self.bridge.next_event("state")
        updater.listener.playstatus_update(updater, self.movie(position=101))
        await asyncio.sleep(0.2)
        self.assertEqual(len(self.bridge.events("state")), 2)
        later = await self.bridge.next_event("state", timeout=1.0)
        self.assertEqual(later["data"]["playing"]["position"], 101)

    async def test_focusing_a_text_field_reads_its_text(self) -> None:
        self.atv.keyboard.fake_focus = fp.KeyboardFocusState.Focused
        self.atv.keyboard.fake_text = "stran"
        self.atv.keyboard.listener.focusstate_update(fp.KeyboardFocusState.Unfocused, fp.KeyboardFocusState.Focused)
        event = await self.bridge.next_event("state")
        self.assertEqual(event["data"]["keyboard"], {"focus": "focused", "text": "stran"})

    async def test_a_lost_connection_is_reported_and_the_device_forgotten(self) -> None:
        self.atv.listener.connection_lost(fp.ConnectionLostError("reset by peer"))
        event = await self.bridge.next_event("connection")
        self.assertEqual(
            event,
            {
                "event": "connection", "device": DEVICE,
                "data": {"status": "disconnected", "reason": "connection_lost", "message": "reset by peer"},
            },
        )
        self.assertEqual((await self.bridge.error("state", {"device": DEVICE}))["code"], "NOT_CONNECTED")
        self.assertTrue(self.atv.fake_closed)

    async def test_a_closed_connection_is_reported(self) -> None:
        self.atv.listener.connection_closed()
        event = await self.bridge.next_event("connection")
        self.assertEqual(event["data"]["reason"], "connection_closed")


class MethodTest(ConnectedTestCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        await self.connect()
        self.atv = self.pyatv.fake_atv

    async def test_state_refresh_rereads_what_is_playing(self) -> None:
        self.atv.metadata.fake_playing = fp.FakePlaying(device_state=fp.DeviceState.Paused, title="Later")
        cached = await self.bridge.call("state", {"device": DEVICE})
        refreshed = await self.bridge.call("state", {"device": DEVICE, "refresh": True})
        self.assertEqual((cached["playing"]["state"], refreshed["playing"]["title"]), ("idle", "Later"))

    async def test_state_refresh_rereads_the_keyboard_text(self) -> None:
        self.atv.keyboard.fake_focus = fp.KeyboardFocusState.Focused
        self.atv.keyboard.fake_text = "typed on the remote"
        refreshed = await self.bridge.call("state", {"device": DEVICE, "refresh": True})
        self.assertEqual(refreshed["keyboard"], {"focus": "focused", "text": "typed on the remote"})

    async def test_keyboard_edits_without_focus_do_not_reach_pyatv(self) -> None:
        for method in ("keyboard.set", "keyboard.append", "keyboard.clear"):
            error = await self.bridge.error(method, {"device": DEVICE, "text": "x"})
            self.assertEqual(error["code"], "KEYBOARD_NOT_FOCUSED", method)
        self.assertEqual(self.atv.keyboard.fake_calls, [])

    async def test_keyboard_edits_return_the_text_read_back(self) -> None:
        keyboard = self.atv.keyboard
        keyboard.fake_focus = fp.KeyboardFocusState.Focused
        keyboard.fake_text = ""
        self.assertEqual(
            await self.bridge.call("keyboard.set", {"device": DEVICE, "text": "stranger"}),
            {"focus": "focused", "text": "stranger"},
        )
        self.assertEqual(
            await self.bridge.call("keyboard.append", {"device": DEVICE, "text": " things"}),
            {"focus": "focused", "text": "stranger things"},
        )
        self.assertEqual(await self.bridge.call("keyboard.clear", {"device": DEVICE}), {"focus": "focused", "text": ""})
        self.assertEqual(await self.bridge.call("keyboard.get", {"device": DEVICE}), {"focus": "focused", "text": ""})

    async def test_apps_are_sorted_by_name_ignoring_case(self) -> None:
        self.atv.apps.fake_list = [
            fp.FakeApp("YouTube", "com.google.ios.youtube"),
            fp.FakeApp("arte", "tv.arte.plus7"),
            fp.FakeApp("Netflix", "com.netflix.Netflix"),
        ]
        self.assertEqual(
            await self.bridge.call("apps.list", {"device": DEVICE}),
            {
                "apps": [
                    {"bundleId": "tv.arte.plus7", "name": "arte"},
                    {"bundleId": "com.netflix.Netflix", "name": "Netflix"},
                    {"bundleId": "com.google.ios.youtube", "name": "YouTube"},
                ]
            },
        )

    async def test_launch_passes_the_target_and_failures_become_launch_failed(self) -> None:
        self.assertEqual(await self.bridge.call("app.launch", {"device": DEVICE, "target": "com.netflix.Netflix"}), {})
        self.assertEqual(self.atv.apps.fake_calls[-1], ("launch_app", ("com.netflix.Netflix",), {}))
        self.atv.apps.fake_errors["launch_app"] = fp.CommandError("not installed")
        error = await self.bridge.error("app.launch", {"device": DEVICE, "target": "com.example.Nope"})
        self.assertEqual((error["code"], error["details"]), ("LAUNCH_FAILED", {"target": "com.example.Nope"}))

    async def test_power_set_does_not_wait_for_the_new_state(self) -> None:
        self.atv.power.fake_state = fp.PowerState.Off
        self.assertEqual(await self.bridge.call("power.set", {"device": DEVICE, "on": True}), {"power": "off"})
        await self.bridge.call("power.set", {"device": DEVICE, "on": False})
        self.assertEqual(
            self.atv.power.fake_calls,
            [("turn_on", (), {"await_new_state": False}), ("turn_off", (), {"await_new_state": False})],
        )

    async def test_volume_set_returns_the_new_volume(self) -> None:
        self.assertEqual(await self.bridge.call("volume.set", {"device": DEVICE, "level": 42}), {"volume": 42})
        self.assertEqual(self.atv.audio.fake_calls, [("set_volume", (42,), {})])

    async def test_seek_sets_the_position(self) -> None:
        self.assertEqual(await self.bridge.call("seek", {"device": DEVICE, "position": 600}), {})
        self.assertEqual(self.atv.remote_control.fake_calls, [("set_position", (600,), {})])

    async def test_disconnect_closes_the_connection_quietly(self) -> None:
        self.bridge.mark_events_seen()
        self.assertEqual(await self.bridge.call("disconnect", {"device": DEVICE}), {})
        self.assertTrue(self.atv.fake_closed)
        self.assertEqual(await self.bridge.call("disconnect", {"device": DEVICE}), {})
        self.assertEqual(self.bridge.events("connection"), [])


class PairingTest(PyatvBridgeTestCase):
    async def begin(self, protocol="companion", **params):
        return await self.bridge.call(
            "pair.begin", {"device": DEVICE, "protocol": protocol, "remoteName": "agent-atv (testhost)", **params}
        )

    async def test_begin_starts_a_pyatv_pairing_under_the_remote_name(self) -> None:
        begun = await self.begin("airplay", address="192.168.1.50")
        self.assertRegex(begun["pairingId"], r"^p-[0-9a-f]{12}$")
        self.assertEqual((begun["protocol"], begun["deviceProvidesPin"]), ("airplay", True))
        handler = self.pyatv.fake_pairings[-1]
        self.assertEqual((handler.fake_protocol, handler.fake_name, handler.fake_begun), (fp.Protocol.AirPlay, "agent-atv (testhost)", True))
        self.assertEqual(self.pyatv.fake_scans[-1]["hosts"], ["192.168.1.50"])

    async def test_the_right_pin_returns_the_credentials_and_closes_the_handler(self) -> None:
        pairing_id = (await self.begin())["pairingId"]
        result = await self.bridge.call("pair.pin", {"pairingId": pairing_id, "pin": "1234"})
        handler = self.pyatv.fake_pairings[-1]
        self.assertEqual(result, {"protocol": "companion", "credentials": "companion-creds"})
        self.assertEqual((handler.fake_pin, handler.fake_closed), (1234, True))

    async def test_a_wrong_pin_fails_and_closes_the_handler(self) -> None:
        pairing_id = (await self.begin())["pairingId"]
        error = await self.bridge.error("pair.pin", {"pairingId": pairing_id, "pin": "0042"})
        self.assertEqual((error["code"], self.pyatv.fake_pairings[-1].fake_pin), ("PAIRING_FAILED", 42))
        self.assertTrue(self.pyatv.fake_pairings[-1].fake_closed)
        self.assertEqual((await self.bridge.error("pair.pin", {"pairingId": pairing_id, "pin": "1234"}))["code"], "PAIRING_NOT_FOUND")

    async def test_pairing_errors_from_pyatv(self) -> None:
        cases = [
            (fp.PairingError("Error=BackOff, BackOff=45s"), "PAIRING_BACKOFF", {"retryAfterSec": 45}),
            (fp.PairingError("device says BackOff"), "PAIRING_BACKOFF", {"retryAfterSec": 30}),
            (fp.PairingError("Error=Authentication"), "PAIRING_FAILED", {}),
        ]
        for exception, code, details in cases:
            with self.subTest(code=code, message=str(exception)):
                pairing_id = (await self.begin())["pairingId"]
                self.pyatv.fake_pairings[-1].fake_finish_error = exception
                error = await self.bridge.error("pair.pin", {"pairingId": pairing_id, "pin": "1234"})
                self.assertEqual((error["code"], error["details"]), (code, details))
                self.assertTrue(self.pyatv.fake_pairings[-1].fake_closed)

    async def test_a_failing_begin_leaves_nothing_behind(self) -> None:
        self.pyatv.fake_pair_begin_error = fp.PairingError("Error=BackOff, BackOff=10s")
        error = await self.bridge.error("pair.begin", {"device": DEVICE, "protocol": "companion", "remoteName": "x"})
        self.assertEqual((error["code"], error["details"]), ("PAIRING_BACKOFF", {"retryAfterSec": 10}))
        self.assertTrue(self.pyatv.fake_pairings[-1].fake_closed)
        self.pyatv.fake_pair_begin_error = None
        self.assertIn("pairingId", await self.begin())

    async def test_one_pairing_at_a_time_per_device(self) -> None:
        first = (await self.begin())["pairingId"]
        error = await self.bridge.error("pair.begin", {"device": DEVICE, "protocol": "airplay", "remoteName": "x"})
        self.assertEqual((error["code"], error["details"]), ("PAIRING_IN_PROGRESS", {"pairingId": first}))

    async def test_an_unanswered_pairing_expires_and_its_handler_is_closed(self) -> None:
        pairing_id = (await self.begin())["pairingId"]
        await asyncio.sleep(FAST.pairing_ttl_s + 0.1)
        self.assertTrue(self.pyatv.fake_pairings[-1].fake_closed)
        error = await self.bridge.error("pair.pin", {"pairingId": pairing_id, "pin": "1234"})
        self.assertEqual(error["code"], "PAIRING_EXPIRED")
        self.assertIn("pairingId", await self.begin())

    async def test_cancel_closes_the_handler(self) -> None:
        pairing_id = (await self.begin())["pairingId"]
        self.assertEqual(await self.bridge.call("pair.cancel", {"pairingId": pairing_id}), {})
        self.assertTrue(self.pyatv.fake_pairings[-1].fake_closed)

    async def test_begin_on_a_missing_device(self) -> None:
        self.pyatv.fake_devices = []
        error = await self.bridge.error("pair.begin", {"device": DEVICE, "protocol": "companion", "remoteName": "x"})
        self.assertEqual(error["code"], "DEVICE_NOT_FOUND")

    async def test_shutdown_closes_pairings_and_connections(self) -> None:
        await self.begin()
        await self.bridge.call("connect", {"device": DEVICE, "credentials": CREDENTIALS})
        await self.bridge.call("shutdown")
        await asyncio.wait_for(self.bridge.task, 5)
        self.assertTrue(self.pyatv.fake_pairings[-1].fake_closed)
        self.assertTrue(self.pyatv.fake_atv.fake_closed)


class VerifyTest(PyatvBridgeTestCase):
    def verify(self):
        return self.bridge.request(
            "pair.verify", {"device": DEVICE, "protocol": "airplay", "credentials": "companion-secret"}
        )

    async def test_verify_connects_with_only_that_protocol_and_reads_playing(self) -> None:
        self.assertEqual((await self.verify())["result"], {"valid": True})
        config = self.pyatv.fake_connected_configs[-1]
        airplay = config.get_service(fp.Protocol.AirPlay)
        companion = config.get_service(fp.Protocol.Companion)
        self.assertEqual((airplay.credentials, airplay.enabled, companion.enabled), ("companion-secret", True, False))
        atv = self.pyatv.fake_atv
        self.assertEqual((atv.metadata.fake_calls[-1][0], atv.fake_closed), ("playing", True))

    async def test_rejected_credentials_are_not_valid(self) -> None:
        for exception in (fp.AuthenticationError("no"), fp.InvalidCredentialsError("no"), fp.ConnectionFailedError("no")):
            with self.subTest(exception=type(exception).__name__):
                self.pyatv.fake_connect_error = exception
                self.assertEqual((await self.verify())["result"], {"valid": False})

    async def test_rejection_while_reading_playing_is_not_valid(self) -> None:
        self.pyatv.fake_playing_error_on_connect = fp.AuthenticationError("no")
        self.assertEqual((await self.verify())["result"], {"valid": False})
        self.assertTrue(self.pyatv.fake_atv.fake_closed)

    async def test_other_failures_are_errors(self) -> None:
        self.pyatv.fake_connect_error = fp.OperationTimeoutError("slow")
        self.assertEqual((await self.verify())["error"]["code"], "DEVICE_TIMEOUT")


if __name__ == "__main__":
    unittest.main()
