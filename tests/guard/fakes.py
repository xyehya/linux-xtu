"""Test doubles for the T-013 guard tests. No hardware, no ``linux_xtu.msr`` import (another task owns that package)."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from linux_xtu.mailbox import Response

#: write cmd -> the read cmd that returns the word it writes (registers.md: 0x10/0x11, 0x14/0x15, 0x1C/0x1D, 0x26/0x27 pairs)
READ_OF_WRITE = {0x11: 0x10, 0x15: 0x14, 0x1D: 0x1C, 0x27: 0x26}


class FakeMailboxTimeout(Exception):
    """Stands in for ``linux_xtu.msr.MailboxTimeout`` (Contract 4); the guard must treat *any* transport exception alike."""


class FakeMsrError(OSError):
    """Stands in for ``linux_xtu.msr.MsrError``."""


class FakeClock:
    """Callable clock whose time only moves when a test says so."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class RecordingTransport:
    """Structural ``Transport``: records every call, models the per-(cpu, p1, p2) words behind cmd 0x10/0x14 reads.

    ``calls`` is the ground truth for "was anything sent": a refusal must leave it unchanged.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[int, int, int, int, int]] = []  # (cpu, cmd, p1, p2, data)
        self.state: dict[tuple[int, int, int, int], int] = {}  # (cpu, read cmd, p1, p2) -> u32 word
        self.write_rc = 0
        self.read_rc = 0
        self.apply_write: Callable[[int], int] = lambda data: data  # what the "hardware" stores for a written word
        self.raise_on_call: dict[int, BaseException] = {}  # 1-based call number -> exception to raise instead
        self.rc_on_call: dict[int, int] = {}  # 1-based call number -> forced rc
        self.read_rc_at: dict[tuple[int, int, int, int], int] = {}  # (cpu, read cmd, p1, p2) -> rc of every read there (e.g. 0x11 past the V/F point table)
        self.data_on_call: dict[int, Any] = {}  # 1-based call number -> forced response data (any object)
        self.before_return: Callable[[tuple[int, int, int, int, int]], None] | None = None  # hook, runs inside transact

    def transact(self, cpu: int, cmd: int, p1: int, p2: int, data: int = 0) -> Response:
        call = (cpu, cmd, p1, p2, data)
        self.calls.append(call)
        number = len(self.calls)
        if self.before_return is not None:
            self.before_return(call)
        if number in self.raise_on_call:
            raise self.raise_on_call[number]
        if cmd in READ_OF_WRITE:
            rc = self.rc_on_call.get(number, self.write_rc)
            if rc == 0:
                self.state[(cpu, READ_OF_WRITE[cmd], p1, p2)] = self.apply_write(data)
            response = Response(rc, 0)
        else:
            rc = self.rc_on_call.get(number, self.read_rc_at.get((cpu, cmd, p1, p2), self.read_rc))
            response = Response(rc, self.state.get((cpu, cmd, p1, p2), 0) if rc == 0 else 0)
        if number in self.data_on_call:
            return Response(response.rc, self.data_on_call[number])  # type: ignore[arg-type]
        return response


#: V/F point ratios of the reference part, by P2 (platform-arl-s.md §3 [MEASURED lnx 2026-10-02]); ``0x10 P2`` past them answers rc 0x11
POINT_RATIOS = {"P": (8, 20, 30, 48, 53, 55, 56, 57), "E": (8, 15, 23, 30, 40, 46)}
RC_PAST_TABLE = 0x11


def seed_point_table(transport: RecordingTransport, cpu: int, kind: str, offsets: dict[int, int] | None = None, p1: int = 0) -> int:
    """Put a unit's fused point words (``ratio | offset << 21``, V target 0) into the fake for ``cpu``, and rc 0x11 one past them. Returns that P2 (the end of the walk)."""
    from linux_xtu.mailbox import VfWord

    ratios = POINT_RATIOS[kind]
    for p2, ratio in enumerate(ratios, start=1):
        transport.state.setdefault((cpu, 0x10, p1, p2), VfWord(ratio, 0, False, (offsets or {}).get(p2, 0)).to_u32())
    end = len(ratios) + 1
    transport.read_rc_at[(cpu, 0x10, p1, end)] = RC_PAST_TABLE
    return end
