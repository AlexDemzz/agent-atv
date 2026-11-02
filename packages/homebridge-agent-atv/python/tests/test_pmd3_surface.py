"""Seam W2: everything fake_pmd3 imitates exists in the installed pymobiledevice3 11.49.1.

Runs only when pymobiledevice3 is importable (the plugin's screen venv, or a dev venv with
requirements-screen.txt).
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib
import inspect
import unittest

from tests import fake_pmd3 as fake

try:
    import pymobiledevice3  # noqa: F401
    from importlib.metadata import version
except ImportError:  # pragma: no cover - depends on the environment
    pymobiledevice3 = None

KEPT_DUNDERS = {"__init__", "__aenter__", "__aexit__"}


def _parameters(function):
    return [
        p.name
        for p in inspect.signature(function).parameters.values()
        if p.name != "self" and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
    ]


def _members(fake_class):
    return {
        name: value
        for name, value in vars(fake_class).items()
        if (not name.startswith("__") or name in KEPT_DUNDERS) and not name.startswith("fake_")
    }


@unittest.skipIf(pymobiledevice3 is None, "pymobiledevice3 is not installed")
class Pmd3SurfaceTest(unittest.TestCase):
    def assert_compatible(self, fake_function, real_function, where: str) -> None:
        self.assertTrue(callable(real_function), where)
        self.assertEqual(inspect.iscoroutinefunction(real_function), inspect.iscoroutinefunction(fake_function), where)
        self.assertLessEqual(set(_parameters(fake_function)), set(inspect.signature(real_function).parameters), where)

    def assert_class_compatible(self, fake_class, real_class) -> None:
        for name, member in _members(fake_class).items():
            where = f"{real_class.__name__}.{name}"
            with self.subTest(member=where):
                self.assertTrue(hasattr(real_class, name), where)
                real = inspect.getattr_static(real_class, name)
                if isinstance(member, property):
                    self.assertIsInstance(real, property, where)
                elif inspect.isfunction(member):
                    self.assert_compatible(member, getattr(real_class, name), where)

    def test_pinned_version(self) -> None:
        with open(f"{fake.__file__.rsplit('/tests/', 1)[0]}/requirements-screen.txt") as f:
            pinned = [line.strip() for line in f if line.startswith("pymobiledevice3==")]
        self.assertEqual(pinned, [f"pymobiledevice3=={version('pymobiledevice3')}"])

    def test_imitated_names_exist_with_compatible_signatures(self) -> None:
        for module_name, names in fake.IMITATES.items():
            module = importlib.import_module(module_name)
            for name in names:
                with self.subTest(name=f"{module_name}.{name}"):
                    self.assertTrue(hasattr(module, name))
                    fake_value, real_value = getattr(fake, name), getattr(module, name)
                    if inspect.isclass(fake_value):
                        self.assert_class_compatible(fake_value, real_value)
                    elif inspect.isfunction(fake_value):
                        self.assert_compatible(fake_value, real_value, name)

    def test_objects_returned_to_the_worker_have_what_it_reads(self) -> None:
        from pymobiledevice3.bonjour import Address, ServiceInstance
        from pymobiledevice3.remote.tunnel_service import RemotePairingTunnelService
        from pymobiledevice3.services.accessibilityaudit import AXAuditElement_v1, AXAuditInspectorFocus_v1, Event

        self.assert_class_compatible(fake._TunnelService, RemotePairingTunnelService)
        self.assert_class_compatible(fake.AXAuditElement_v1, AXAuditElement_v1)
        self.assert_class_compatible(fake.AXAuditInspectorFocus_v1, AXAuditInspectorFocus_v1)
        self.assertEqual({f.name for f in dataclasses.fields(fake.Event)}, {f.name for f in dataclasses.fields(Event)})
        self.assertLessEqual({"instance", "host", "port", "addresses", "properties"}, {f.name for f in dataclasses.fields(ServiceInstance)})
        self.assertLessEqual({"ip", "iface"}, {f.name for f in dataclasses.fields(Address)})

    def test_the_hooks_the_worker_replaces_are_looked_up_at_call_time(self) -> None:
        from pymobiledevice3.remote.tunnel_service import RemotePairingProtocol
        from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

        # The Wi-Fi tunnel provider replaces this module global.
        self.assertIn("_create_no_root_tunnel_provider", UserspaceRsdTunnel._aopen_locked.__code__.co_names)
        # The PIN comes from a module-level input() the worker shadows.
        self.assertIn("input", RemotePairingProtocol._request_pair_consent.__code__.co_names)

    def test_iter_events_is_an_async_generator_like_the_fake(self) -> None:
        from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit

        self.assertTrue(inspect.isasyncgenfunction(AccessibilityAudit.iter_events))
        self.assertTrue(inspect.isasyncgenfunction(fake.AccessibilityAudit.iter_events))

    def test_the_tunnel_write_the_worker_replaces_is_the_one_it_reimplements(self) -> None:
        from pymobiledevice3.remote.userspace_tunnel import UserspaceTun

        # agent_atv_screen.inbound_queue rewrites this function with a queue in place of the drop.
        # Another pymobiledevice3 version may handle inbound packets differently: compare it with
        # write() and the queue, then update both and this digest.
        source = inspect.getsource(UserspaceTun.write)
        self.assertEqual(
            hashlib.sha256(source.encode()).hexdigest(),
            "631d0efa351d33851ef53831307d98d84c3bee6014e11a310bdb5ffab5bd867a",
            "UserspaceTun.write changed: review agent_atv_screen/inbound_queue.py against it",
        )
        tun = UserspaceTun()
        try:
            self.assertFalse(tun._peer.getblocking())
            self.assertFalse(tun._send_error_logged)
        finally:
            tun._peer.close()
            tun._pend.close()

    def test_the_dtx_buffer_limit_is_a_module_setting(self) -> None:
        from pymobiledevice3.dtx import _reader

        self.assertIsInstance(_reader.MAX_BUFFERED_SIZE, int)


if __name__ == "__main__":
    unittest.main()
