"""Builds the pymobiledevice3 namespace Pmd3Backend works through (faked by tests/fake_pmd3.py)."""

from __future__ import annotations

import types
from importlib.metadata import version


def load() -> types.SimpleNamespace:
    from pymobiledevice3 import bonjour, exceptions, pair_records
    from pymobiledevice3.dtx import _reader as dtx_reader
    from pymobiledevice3.remote import tunnel_service, userspace_tunnel
    from pymobiledevice3.services import accessibilityaudit
    from pymobiledevice3.services.dvt.instruments import device_info, dvt_provider, screenshot

    return types.SimpleNamespace(
        version=version("pymobiledevice3"),
        userspace_tunnel=userspace_tunnel,
        tunnel_service=tunnel_service,
        bonjour=bonjour,
        accessibilityaudit=accessibilityaudit,
        dvt_provider=dvt_provider,
        screenshot=screenshot,
        device_info=device_info,
        dtx_reader=dtx_reader,
        exceptions=exceptions,
        pair_records=pair_records,
    )
