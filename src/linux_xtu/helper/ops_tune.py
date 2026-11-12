"""G-112 helper ops (contract 9, SPEC-v3 sections 4-6, D-032/D-033): the registration of ``vf.dump``, ``tune.*`` and ``profiles.*`` (:func:`tune_ops`).

Design in one paragraph. ``tune.read`` is ``vf.dump`` plus decoded words (and a best-effort plain read of the turbo tables); it remembers the words in force
(``helper.last_words``: cpu -> [OC word, point 1, point 2, ...]). ``tune.plan`` is **pure** (no hardware, no mailbox, not write-gated): it turns the UI's intent into a
``Profile`` for the existing controls planner, resolving "the point at ratio 53" from the words of the last read, checks every number against the field encodings and the
CPU's own limits of this boot's read (D-049; the check is still named ``POLICY_RANGE``) and the controls pre-flight, and keeps the plan (id, nonce, expiry, the words, ring
words and turbo tables it assumed, the intent it was made from) in memory. ``tune.apply`` is the existing ``controls.apply_profile`` engine run through the guard, one
transaction at a time: it re-reads the baselines inside its own guarded session (the guard demands a baseline read per session anyway), refuses with ``PLAN_STALE`` before
any write when a word differs from what the plan assumed, then writes and reads every write back. No new mailbox logic lives here: the guard stays the only path to the
mailbox and ``controls`` builds every request.

G-148 (D-044): profiles are complete and independent; the accepted state is exactly one profile; Restore accepted, and the apply of any complete profile, writes only the
words that differ from what the CPU holds and keeps the G-147 residual rule. G-154 (D-045): the ring (cache, mailbox domain P1 = 2) is one more unit, ``ring``; its OC word
is BIOS-owned and never written.

Module map (R-D1): ``session`` (the guarded session), ``tune_state`` (shared state, plans, the stored last read, policy and limits), ``ops_tune_read`` (``vf.dump``,
``tune.read``, ``tune.last``), ``tune_intent`` (intent shape, accepted state and saved profiles, intent -> ``Profile``), ``tune_predict`` (preview and prediction),
``ops_tune_plan`` (``tune.plan``), ``ops_tune_apply`` (``tune.apply``), ``ops_profiles`` (``profiles.list`` / ``save`` / ``get``), ``ops_accept`` (``profiles.accept`` /
``diff`` / ``fingerprint``). ``canonical_intent`` is re-exported here for the desktop UI's intent tests.
"""
from __future__ import annotations

from .ops import OpSpec, _no_args, _validate_vf_dump
from .ops_accept import op_profiles_accept, op_profiles_diff, op_profiles_fingerprint, validate_profiles_accept, validate_profiles_diff
from .ops_profiles import _validate_profiles_get, _validate_profiles_save, op_profiles_get, op_profiles_list, op_profiles_save
from .ops_tune_apply import _validate_tune_apply, op_tune_apply
from .ops_tune_plan import _validate_tune_plan, op_tune_plan
from .ops_tune_read import op_tune_last, op_tune_read, vf_dump_tracked
from .state import State
from .tune_intent import canonical_intent  # re-exported: desktop/app/ui/tests/lib_intent.test.mjs validates the UI's intents with linux_xtu.helper.ops_tune.canonical_intent

__all__ = ["canonical_intent", "tune_ops"]


# --------------------------------------------------------------------------------------------------------------
# registration
# --------------------------------------------------------------------------------------------------------------
def tune_ops() -> list[OpSpec]:
    return [
        # a mailbox read is a WRMSR (docs/SAFETY.md): write-gated on hardware, long (state machine begin/end), one at a time
        OpSpec("vf.dump", vf_dump_tracked, _validate_vf_dump, long=True, write=True, state=State.PLANNING),
        OpSpec("tune.read", op_tune_read, _validate_vf_dump, long=True, write=True, state=State.PLANNING),
        # pure: policy + last read + files, no hardware; own thread because it touches the filesystem
        OpSpec("tune.plan", op_tune_plan, _validate_tune_plan, slow=True),
        # D-029: every write op is long, so it goes through machine.begin (state "applying") and the dispatcher's busy check
        OpSpec("tune.apply", op_tune_apply, _validate_tune_apply, long=True, write=True, state=State.APPLYING),
        OpSpec("profiles.list", op_profiles_list, _no_args, slow=True),
        OpSpec("profiles.save", op_profiles_save, _validate_profiles_save, slow=True),
        OpSpec("profiles.get", op_profiles_get, _validate_profiles_get, slow=True),
        # G-129 (D-036): the user's accepted state, written by the root helper (a file write, no mailbox / MSR traffic; a read this boot is required)
        OpSpec("profiles.accept", op_profiles_accept, validate_profiles_accept, slow=True),
        # G-228: what differs between two states (the accepted one, a saved profile, the last read): the confirm step of "Set as accepted"; a file read, no hardware
        OpSpec("profiles.diff", op_profiles_diff, validate_profiles_diff, slow=True),
        # G-141: records fingerprint.json for the accepted state that exists (a file write, no mailbox / MSR traffic; needs this boot's read of the fused words)
        OpSpec("profiles.fingerprint", op_profiles_fingerprint, _no_args, slow=True),
        # G-123: the stored last read of this boot (a file read, no hardware); also restores the plan state after a helper restart
        OpSpec("tune.last", op_tune_last, _no_args, slow=True),
    ]
