"""The guarded session (R-D1, assessment 06 F15): the one place the helper -- and the CLI -- build a ``WriteGuard``.

:func:`guarded_session` serves every helper op that sends mailbox requests or plain MSR accesses (``vf.dump``, ``tune.read``'s extras and ring read,
``tune.apply``, ``power.*``). Before the port exists it decides everything that can be decided, in this order, and refuses with a named check and
nothing sent: a trusted audit-log path (``TRUST_PATH``), the session cap (``SESSION_LIMIT``), a trusted lock file (``LOCK_UNTRUSTED``), the audit log
created private (0600) and readable for the per-boot count (``AUDIT_UNAVAILABLE``), this boot's remaining budget (``BOOT_LIMIT``), the health gate
(``HELPER_CONFIG_INVALID``; ``NO_HEALTH_GATE`` on hardware, where the bracket is mandatory). Clocks: the simulator runs on the helper's one virtual clock
(the dwell is honoured instantly, :func:`~linux_xtu.helper.ops.sim_clocks`); on hardware the dwell between transactions waits on the cancel flag while the
transport polls with the real sleep. The guard's session cap is exactly the operations asked for (a policy can only lower it). The port is closed when
the session ends, whatever ended it.

:func:`build_guard` is the ``WriteGuard`` constructor itself (transport, policy, audit log, session token, env, health gate, lock, clocks, the same port for
plain MSR access, and the settle wait of G-237); the CLI's ``_build_guard`` calls it with its own clocks and refusals.
"""
from __future__ import annotations

import contextlib
import dataclasses
import os
import secrets
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from linux_xtu.guard import ENV_FLAG, AuditLog, AuditUnreadable, Confirmation, Policy, WriteGuard, read_state
from linux_xtu.msr import MailboxTransport

from .ops import OpContext, _refuse, _trust, _trust_refusal, sim_clocks
from .trust import TrustError, check_lock_file, open_checked

if TYPE_CHECKING:
    from .core import Helper

__all__ = ["Session", "build_guard", "guarded_session"]


@dataclass
class Session:
    guard: WriteGuard
    confirm: Confirmation
    policy: Policy  # with max_operations_per_session = exactly the budget of this session
    clock: Any
    sleep: Any  # the dwell between transactions (cancel-aware on hardware)
    used: int | None  # per-boot operations used before this session; None = the boot id is unknown (G-141: not claimed as 0)


def build_guard(
    port: Any,
    policy: Policy,
    audit: AuditLog,
    *,
    token: str,
    env: Mapping[str, str],
    health_gate: Callable[[str], tuple[bool, str]] | None,
    lock_path: Path | str,
    clock: Callable[[], float],
    wall_clock: Callable[[], float],
    boot_id_fn: Callable[[], str | None],
    sleep: Callable[[float], object],
    session_favored_words: Mapping[int, int] | None = None,
) -> WriteGuard:
    """A ``WriteGuard`` over ``port``: the mailbox transport polls with ``sleep`` (never a cancel-aware wait: a set cancel flag must not turn the poll loop into a
    spin), plain ``rdmsr`` / ``wrmsr`` go through the same port (T-023), and a late V target is re-read after ``sleep`` (G-237: the virtual sleep in the simulator,
    the real one on a device)."""
    return WriteGuard(
        MailboxTransport(port, sleep=sleep, clock=clock),
        policy,
        audit,
        session_token=token,
        env=env,
        health_gate=health_gate,
        lock_path=lock_path,
        clock=clock,
        wall_clock=wall_clock,
        boot_id_fn=boot_id_fn,
        msr_port=port,
        session_favored_words=session_favored_words,
        settle_wait=sleep,
    )


@contextlib.contextmanager
def guarded_session(
    helper: Helper,
    ctx: OpContext,
    policy: Policy,
    needed: int,
    what: str,
    *,
    unit: str = "mailbox operations",
    why: str = "every request is a WRMSR",
    trust_audit: bool = True,
    favored_words: Callable[[], Mapping[int, int] | None] | None = None,
) -> Iterator[Session]:
    """Everything decidable before the first request (module docstring), then a ``WriteGuard`` over the helper's port. ``needed`` = the worst-case number of
    operations (the caller's own count); the guard gets exactly that as its session cap. ``what`` / ``unit`` / ``why`` word the ``SESSION_LIMIT`` and ``BOOT_LIMIT``
    refusals ("``{what}`` needs up to N ``{unit}`` (``{why}``) ..."). ``trust_audit=False``: the caller has trust-checked the audit path already. ``favored_words``
    is called when the guard is built and seeds its session ``0x1C`` words."""
    cfg = helper.cfg
    if trust_audit:
        _trust(helper, cfg.audit_path, want="file", must_exist=False)
    if needed > policy.max_operations_per_session:
        raise _refuse(
            f"{what} needs up to {needed} {unit} ({why}) but the policy allows {policy.max_operations_per_session} per session.",
            "SESSION_LIMIT", needed=needed, allowed=policy.max_operations_per_session,
        )
    euid = cfg.euid_fn()
    try:
        check_lock_file(cfg.lock_path, euid=euid)  # a foreign / symlinked lock file in a world-writable directory is refused, not followed or taken over
    except TrustError as exc:
        raise _trust_refusal(exc, "LOCK_UNTRUSTED") from None
    try:
        # create-or-validate the audit log with O_NOFOLLOW + fstat before AuditLog (which itself opens O_NOFOLLOW|O_APPEND) ever touches it
        os.close(open_checked(cfg.audit_path, write=True, create=True, mode=0o600, euid=euid, what="audit log"))  # G-141: private, like install.sh creates it
    except TrustError as exc:
        raise _trust_refusal(exc, "TRUST_PATH") from None
    except OSError as exc:
        raise _refuse(f"cannot open the audit log {cfg.audit_path}: {exc}.", "AUDIT_UNAVAILABLE") from None
    try:
        state = read_state(cfg.audit_path)
    except (AuditUnreadable, OSError) as exc:
        raise _refuse(f"the audit log {cfg.audit_path} is unavailable, so the per-boot budget cannot be checked: {exc}.", "AUDIT_UNAVAILABLE") from None
    try:
        boot = cfg.boot_id_fn()
    except Exception:
        boot = None
    boot_id = boot.strip() or None if isinstance(boot, str) else None
    counted = state.attempts_by_boot.get(boot_id, 0)  # the guard caps an unknown boot as its own bucket, so the cap check uses it either way ...
    used = counted if boot_id is not None else None  # ... but it is not "operations of this boot": the display says unknown (G-141)
    left = max(policy.max_operations_per_boot - counted, 0)
    if needed > left:
        raise _refuse(
            f"{what} needs up to {needed} {unit} but only {left} of the policy's {policy.max_operations_per_boot} operations per boot are left.",
            "BOOT_LIMIT", needed=needed, left=left,
        )
    if cfg.simulator:
        # One virtual clock for the life of the process, so the audit timestamps of consecutive sessions stay consistent; G-141: it starts at the newest audit
        # record when a previous process left it ahead of the real clock. Simulator only: the gap between two sessions is taken to be at least the dwell
        # (on hardware the guard refuses DWELL instead of waiting).
        virtual, wall = sim_clocks(helper, state.last_attempt_wall)
        virtual.sleep(policy.min_dwell_s)
        clock, sleep = virtual.clock, virtual.sleep
        transport_sleep = sleep
    else:
        clock, wall = cfg.monotonic, cfg.wall_clock
        transport_sleep = cfg.sleep  # a real sleep: a set cancel flag must not turn the mailbox poll loop into a spin (cancel acts between transactions)

        def sleep(seconds: float) -> None:  # the dwell between transactions: the cancel flag wakes it
            ctx.cancel.wait(seconds)
    try:
        gate = cfg.health_gate_factory()
    except TrustError as exc:
        raise _trust_refusal(exc, "TRUST_PATH") from None
    except (ValueError, OSError) as exc:
        raise _refuse(f"the helper's own configuration is invalid: {exc}.", "HELPER_CONFIG_INVALID") from None
    if gate is None and not cfg.simulator:
        raise _refuse("no health gate is available (the health bracket is mandatory on hardware).", "NO_HEALTH_GATE")
    policy = dataclasses.replace(policy, max_operations_per_session=needed)  # exactly the budget; a policy can only lower it
    try:
        audit = AuditLog(cfg.audit_path)
    except OSError as exc:
        raise _refuse(f"cannot open the audit log {cfg.audit_path}: {exc}.", "AUDIT_UNAVAILABLE") from None
    port = cfg.port_factory()  # every refusal is above
    try:
        token = secrets.token_hex(16)
        guard = build_guard(
            port, policy, audit, token=token,
            env={ENV_FLAG: "1"},  # D-043: the allowlisted socket peer replaced the exported flag; never os.environ
            health_gate=gate, lock_path=cfg.lock_path, clock=clock, wall_clock=wall, boot_id_fn=cfg.boot_id_fn, sleep=transport_sleep,
            session_favored_words=None if favored_words is None else favored_words(),
        )
        yield Session(guard, Confirmation(token, cfg.operator), policy, clock, sleep, used)
    finally:
        close = getattr(port, "close", None)
        if callable(close):
            close()
