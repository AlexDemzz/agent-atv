"""Seam B3: everything fake_pyatv imitates exists in the installed pyatv 0.18 (runs only when pyatv is importable)."""

from __future__ import annotations

import inspect
import unittest

from tests import fake_pyatv as fp

try:
    import pyatv
    from pyatv import interface
except ImportError:  # pragma: no cover - depends on the environment
    pyatv = None

LISTENER_INTERFACES = ("PushListener", "DeviceListener", "PowerListener", "AudioListener", "KeyboardListener")


def _imitating_classes():
    return [value for value in vars(fp).values() if isinstance(value, type) and "IMITATES" in vars(value)]


def _members(fake_class):
    """Public members a fake class (and its imitating bases) defines, minus test controls."""
    members = {}
    for klass in reversed(fake_class.__mro__):
        if klass in (object, fp._Recorder):
            continue
        for name, value in vars(klass).items():
            if not name.startswith("_") and name != "IMITATES":
                members[name] = value
    return members


def _parameters(function):
    return [name for name in inspect.signature(function).parameters if name != "self"]


@unittest.skipIf(pyatv is None, "pyatv is not installed")
class PyatvSurfaceTest(unittest.TestCase):
    def test_pinned_version(self) -> None:
        self.assertEqual(pyatv.const.__version__, fp.const.__version__)

    def test_enum_members_exist(self) -> None:
        for name, fake_enum in vars(fp.const).items():
            if name.startswith("__"):
                continue
            real_enum = getattr(pyatv.const, name)
            for member in fake_enum:
                with self.subTest(enum=name, member=member.name):
                    self.assertEqual(real_enum[member.name].value, member.value)

    def test_exceptions_exist_with_the_same_base(self) -> None:
        for name, fake_exception in vars(fp.exceptions).items():
            with self.subTest(exception=name):
                real = getattr(pyatv.exceptions, name)
                self.assertTrue(issubclass(real, fake_exception.__mro__[1]))

    def test_module_functions_accept_the_arguments_the_bridge_passes(self) -> None:
        for name in ("scan", "connect", "pair"):
            with self.subTest(function=name):
                real = getattr(pyatv, name)
                self.assertTrue(inspect.iscoroutinefunction(real))
                real_params = inspect.signature(real).parameters
                fake_params = [p for p in _parameters(getattr(fp.FakePyatv, name)) if p != "kwargs"]
                self.assertLessEqual(set(fake_params), set(real_params))
        pair_kinds = {p.kind for p in inspect.signature(pyatv.pair).parameters.values()}
        self.assertIn(inspect.Parameter.VAR_KEYWORD, pair_kinds)

    def test_imitated_classes_have_every_member_with_compatible_signatures(self) -> None:
        service = pyatv.conf.ManualService(None, pyatv.const.Protocol.AirPlay, 7000, {})
        for fake_class in _imitating_classes():
            real_class = getattr(interface, fake_class.IMITATES.split(".")[1])
            for name, fake in _members(fake_class).items():
                with self.subTest(fake=fake_class.__name__, member=name):
                    if not hasattr(real_class, name):
                        self.assertTrue(real_class is interface.BaseService and hasattr(service, name))
                        continue
                    real = getattr(real_class, name)
                    if inspect.isfunction(fake):
                        self.assertTrue(callable(real))
                        self.assertEqual(inspect.iscoroutinefunction(real), inspect.iscoroutinefunction(fake))
                        self.assertLessEqual(set(_parameters(fake)), set(_parameters(real)))
                    elif isinstance(fake, property):
                        self.assertFalse(inspect.isfunction(inspect.getattr_static(real_class, name)))

    def test_the_private_companion_hook_the_session_check_reaches(self) -> None:
        # The bridge reads atv.power._interfaces[Protocol.Companion].api.fetch_attention_state().
        from pyatv.core.facade import FacadePower
        from pyatv.core.relayer import Relayer
        from pyatv.protocols.companion import CompanionPower
        from pyatv.protocols.companion.api import CompanionAPI, SystemStatus

        self.assertTrue(issubclass(FacadePower, Relayer))
        relayer = Relayer(interface.Power, [pyatv.const.Protocol.Companion])
        relayer.register("companion power", pyatv.const.Protocol.Companion)
        self.assertEqual(relayer._interfaces, {pyatv.const.Protocol.Companion: "companion power"})
        self.assertIn("self.api", inspect.getsource(CompanionPower.__init__))
        self.assertTrue(inspect.iscoroutinefunction(CompanionAPI.fetch_attention_state))
        self.assertEqual(_parameters(CompanionAPI.fetch_attention_state), [])
        self.assertEqual({m.name: m.value for m in SystemStatus}, {m.name: m.value for m in fp.SystemStatus})

    def test_bridge_listener_matches_every_pyatv_listener_interface(self) -> None:
        from agent_atv_bridge.backend_pyatv import _Listener

        for interface_name in LISTENER_INTERFACES:
            listener_interface = getattr(interface, interface_name)
            for name, member in vars(listener_interface).items():
                if name.startswith("_") or not inspect.isfunction(member):
                    continue
                with self.subTest(interface=interface_name, method=name):
                    self.assertEqual(_parameters(getattr(_Listener, name)), _parameters(member))


if __name__ == "__main__":
    unittest.main()
