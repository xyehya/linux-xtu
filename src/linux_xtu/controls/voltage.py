"""B-08 groundwork (assessment 2026-11-11, 05-backend-correctness.md §3.2): ONE answer to "what voltage does an OC point word request", for the planner's ordering.

Only measured behaviour is modelled. The OC point is the ``P2 = 0`` word; it exists only when its ratio is above the unit's top fused ratio (``0x09 [7:0]``) and it then carries
an adaptive V target ``[19:8]`` (raw S2.10) ``[MEASURED lnx 2026-10-02/11, docs/knowledge/platform-arl-s.md §3]``. Two ways to give it a voltage are measured, both requesting the
target the word carries:

* (a) **no voltage given**: the planner fills the XTU shape, V target = the UN-OFFSET fused top voltage ``0x09 [19:8]`` (``planner.xtu_word``) -- the top point's own offset is not
  inherited ``[MEASURED win 2026-10-01: XTU's fill; lnx 2026-10-15: a ring OC point with an auto target kept the un-offset voltage while point 8 moved -25 mV]``;
* (b) **an adaptive target**: as given ``[MEASURED lnx 2026-10-11/13: E 48x at 1.147 V ran 1.1475 V]``.

What the core then RUNS is ``max(request, the effective top fused point)``: a target below the offset top point is clamped up to it ``[MEASURED lnx 2026-10-11/13]`` -- that clamp
is the caller's model of the curve (``controls.order.level``), not part of the request.

Not modelled, on purpose (no measurement; assessment 05 §3.6 experiments E5/E6): (c) an offset on the OC point alone and (d) a target together with a non-zero whole-curve offset
``[31:21]`` -- whether that offset also moves the OC target is ``[UNVERIFIED]``. :func:`oc_point_request` raises :class:`UnmeasuredVoltageMode` for such a word, and a caller decides
explicitly what to assume (``controls.order`` keeps the target unshifted, its G-151 assumption, and says so). A static (override) word is out of scope (D-016) and raises as well.
"""
from __future__ import annotations

from dataclasses import dataclass

from linux_xtu.guard.policy import fused_top_ratio
from linux_xtu.mailbox import VfWord

__all__ = ["MODE_ADAPTIVE", "MODE_FUSED_FILL", "OcRequest", "UnmeasuredVoltageMode", "oc_point_request"]

#: (a) the word carries the un-offset fused top voltage: the planner's fill when the profile gives no OC voltage
MODE_FUSED_FILL = "fused_fill"
#: (b) the word carries an adaptive target of its own
MODE_ADAPTIVE = "adaptive"


class UnmeasuredVoltageMode(ValueError):
    """The word gives its OC point a voltage in a way nobody measured (a whole-curve offset next to the OC target, or static mode)."""


@dataclass(frozen=True)
class OcRequest:
    """The voltage an OC point word requests: ``raw`` (S2.10, 1/1024 V) and how it was given (:data:`MODE_FUSED_FILL` / :data:`MODE_ADAPTIVE`)."""

    raw: int
    mode: str

    @property
    def volts(self) -> float:
        return self.raw / 1024


def oc_point_request(word: VfWord, fused_word: int | None) -> OcRequest | None:
    """The voltage ``word`` (a ``P2 = 0`` word) requests for its OC point on a unit whose fused ``0x09`` word is ``fused_word``; ``None`` when the word creates no OC point -- its
    ratio is at or below the top fused ratio (the hardware keeps no target there, G-124 ``[MEASURED lnx 2026-10-11/12]``) or it carries no target. ``fused_word`` unknown (``None``):
    the word is taken to create an OC point (nothing is dropped) and its target counts as adaptive. Raises :class:`UnmeasuredVoltageMode` for an OC point whose word also carries
    a whole-curve offset, or for a static word (module docstring)."""
    if word.static:
        raise UnmeasuredVoltageMode(f"word {word.to_u32():#010x} is static (override) mode: out of scope (D-016), its voltage is not modelled")
    top = fused_top_ratio(fused_word)
    if word.v_target_raw == 0 or (top is not None and word.ratio <= top):
        return None
    if word.offset_raw != 0:
        raise UnmeasuredVoltageMode(
            f"word {word.to_u32():#010x} carries an OC target and a whole-curve offset ({word.offset_raw} raw): whether the offset moves the OC target is UNVERIFIED "
            "(assessment 05 B-08, modes c/d)"
        )
    fused_raw = None if fused_word is None else (fused_word >> 8) & 0xFFF
    return OcRequest(word.v_target_raw, MODE_FUSED_FILL if fused_raw and word.v_target_raw == fused_raw else MODE_ADAPTIVE)
