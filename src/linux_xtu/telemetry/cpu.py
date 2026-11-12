"""Per-CPU MSR telemetry: APERF/MPERF effective frequency and busy, requested VID, MSR digital thermal sensors.

Decodes (registers.md / telemetry-sources.md):
  * effective MHz = tsc_mhz * dAPERF / dMPERF ; busy % = 100 * dMPERF / (tsc_mhz * 1e6 * dt)   [DOC Intel SDM vol 3 14.2]
    tsc_mhz = 100 MHz * PLATFORM_INFO[15:8].
  * 0x198 PERF_STATUS: ratio [15:8], requested VID [47:32] / 8192 V (a request, not delivered voltage) [MEASURED lnx 2026-09-29]
  * 0x19C / 0x1B1: valid [31], digital readout [22:16] (degrees below Tjmax), Tjmax = 0x1A2[23:16] [DOC SDM; 0x1A2 MEASURED]
  * 0x64F core / 0x6B0 graphics limit words: decoded by telemetry/limits.py into {raw,status,log,unknown_bits}; 0x6B0's raw word
    is also still published as ``limit_reasons_raw`` for one release (the key previously carried the graphics word under a wrong
    "package" label). Bit tables and evidence: registers.md "Limit reasons".
"""
from __future__ import annotations

import time
from collections.abc import Callable, Iterable
from pathlib import Path

from linux_xtu.msr.port import MsrError

from .msrio import (MSR_APERF, MSR_CORE_PERF_LIMIT_REASONS, MSR_GFX_PERF_LIMIT_REASONS, MSR_MPERF,
                    MSR_PACKAGE_THERM_STATUS, MSR_PERF_STATUS, MSR_PKG_POWER_LIMIT_PL4, MSR_RAPL_POWER_UNIT, MSR_PLATFORM_INFO, MSR_RING_PERF_LIMIT_REASONS, MSR_TEMPERATURE_TARGET,
                    MSR_THERM_STATUS, MSR_UNCORE_PERF_STATUS, TelemetryMsr, bits)
from .limits import decode_core_64f, decode_graphics_6b0, decode_pkg_therm_1b1, decode_ring_6b1
from .readings import Reading, unavailable

BUS_MHZ = 100  # [DOC] ARL BCLK 100 MHz; tsc ratio from PLATFORM_INFO
NO_MSR_TEXT = "no MSR access (needs root)"
_M64 = (1 << 64) - 1


def tsc_mhz(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    try:
        ratio = bits(msr.rdmsr(cpu, MSR_PLATFORM_INFO), 15, 8)
    except (MsrError, ValueError) as e:
        return unavailable("msr 0xCE", str(e), "MHz")
    if ratio == 0:
        return unavailable("msr 0xCE", "base ratio reads 0", "MHz")
    return Reading(ratio * BUS_MHZ, "MHz", "msr 0xCE[15:8]")


class FreqSampler:
    """Keeps the previous APERF/MPERF per CPU; each ``sample`` returns (mhz, busy_pct) readings per CPU."""

    def __init__(self, msr: TelemetryMsr, tsc_mhz_value: float, clock: Callable[[], float] = time.monotonic) -> None:
        if not tsc_mhz_value or tsc_mhz_value <= 0:
            raise ValueError("tsc_mhz must be positive")
        self._msr, self._tsc, self._clock = msr, float(tsc_mhz_value), clock
        self._prev: dict[int, tuple[float, int, int]] = {}

    def sample(self, cpus: Iterable[int]) -> dict[int, tuple[Reading, Reading]]:
        out: dict[int, tuple[Reading, Reading]] = {}
        for cpu in cpus:
            src = f"msr 0xE8/0xE7 cpu{cpu}"
            try:
                now = self._clock()
                a = self._msr.rdmsr(cpu, MSR_APERF)
                m = self._msr.rdmsr(cpu, MSR_MPERF)
            except (MsrError, ValueError) as e:
                self._prev.pop(cpu, None)
                out[cpu] = (unavailable(src, str(e), "MHz"), unavailable(src, str(e), "%"))
                continue
            prev = self._prev.get(cpu)
            self._prev[cpu] = (now, a, m)
            if prev is None:
                out[cpu] = (unavailable(src, "first sample (need two)", "MHz"),
                            unavailable(src, "first sample (need two)", "%"))
                continue
            t0, a0, m0 = prev
            da, dm, dt = (a - a0) & _M64, (m - m0) & _M64, now - t0
            if dt <= 0:
                out[cpu] = (unavailable(src, "no time elapsed", "MHz"), unavailable(src, "no time elapsed", "%"))
            elif dm == 0:
                # core idle the whole interval (MPERF only counts in C0): frequency is undefined, busy is 0
                out[cpu] = (unavailable(src, "idle (MPERF did not advance)", "MHz"), Reading(0.0, "%", src))
            else:
                busy = min(100.0, 100.0 * dm / (self._tsc * 1e6 * dt))
                out[cpu] = (Reading(self._tsc * da / dm, "MHz", src), Reading(busy, "%", src))
        return out


def read_vid(msr: TelemetryMsr, cpu: int) -> tuple[Reading, Reading]:
    """(requested VID in V, running ratio) from 0x198; unavailable when the MSR cannot be read."""
    src = f"msr 0x198 cpu{cpu}"
    try:
        w = msr.rdmsr(cpu, MSR_PERF_STATUS)
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e), "V"), unavailable(src, str(e), "x")
    return Reading(bits(w, 47, 32) / 8192.0, "V", src), Reading(bits(w, 15, 8), "x", src)


def read_tjmax(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    try:
        tj = bits(msr.rdmsr(cpu, MSR_TEMPERATURE_TARGET), 23, 16)
    except (MsrError, ValueError) as e:
        return unavailable("msr 0x1A2", str(e), "C")
    return Reading(tj, "C", "msr 0x1A2[23:16]") if tj else unavailable("msr 0x1A2", "Tjmax reads 0", "C")


def _therm(msr: TelemetryMsr, cpu: int, addr: int, tjmax: Reading) -> Reading:
    src = f"msr {addr:#x} cpu{cpu}"
    if not tjmax.available:
        return unavailable(src, f"Tjmax unavailable: {tjmax.reason}", "C")
    try:
        w = msr.rdmsr(cpu, addr)
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e), "C")
    if not bits(w, 31, 31):
        return unavailable(src, "reading-valid bit clear", "C")
    return Reading(tjmax.value - bits(w, 22, 16), "C", src)


def read_core_temp_msr(msr: TelemetryMsr, cpu: int, tjmax: Reading) -> Reading:
    return _therm(msr, cpu, MSR_THERM_STATUS, tjmax)


def read_package_temp_msr(msr: TelemetryMsr, cpu: int, tjmax: Reading) -> Reading:
    return _therm(msr, cpu, MSR_PACKAGE_THERM_STATUS, tjmax)


def read_limit_reasons(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    """0x64F (core limit word, package scope) decoded. The Reading value is the decoder's ``{raw,status,log,unknown_bits}`` dict;
    an unreadable MSR is unavailable with the reason -- never a guessed word."""
    src = "msr 0x64F (decoded)"
    try:
        word = msr.rdmsr(cpu, MSR_CORE_PERF_LIMIT_REASONS)
        decoded = decode_core_64f(word).to_json()
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e))
    return Reading(decoded, "", src)


def read_limit_reasons_gfx(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    """0x6B0 (GRAPHICS limit word -- the integrated GPU, not the package) decoded the same way as :func:`read_limit_reasons`."""
    src = "msr 0x6B0 (decoded)"
    try:
        word = msr.rdmsr(cpu, MSR_GFX_PERF_LIMIT_REASONS)
        decoded = decode_graphics_6b0(word).to_json()
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e))
    return Reading(decoded, "", src)


RING_CURRENT_FREQ = "current_freq_khz"
RING_SYSFS_DIE = "package_00_die_00"


def read_ring_clock(msr: TelemetryMsr | None, uncore_root: Path, cpu: int = 0) -> tuple[Reading, Reading]:
    """QA-20: the ring (uncore) clock the CPU runs now -> ``(mhz, ratio)``. First choice the read-only sysfs file
    ``intel_uncore_frequency/package_00_die_00/current_freq_khz`` (the kernel driver's own sample of the same field); else plain ``rdmsr`` 0x621 ``[6:0]``
    (current ring ratio x 100 MHz, [MEASURED lnx 2026-10-15], registers.md 0x620 / 0x621). Neither readable -> both unavailable with the reason."""
    root = Path(uncore_root)
    why = ""
    try:
        dirs = sorted((d for d in root.iterdir() if d.is_dir() and d.name.startswith(("package_", "uncore"))), key=lambda d: (d.name != RING_SYSFS_DIE, d.name))
    except OSError:
        dirs = []
        why = "no intel_uncore_frequency directory"
    for d in dirs:
        src = f"intel_uncore_frequency/{d.name}/{RING_CURRENT_FREQ}"
        try:
            khz = int((d / RING_CURRENT_FREQ).read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            why = f"{src} unreadable"
            continue
        if khz > 0:
            return Reading(khz / 1000.0, "MHz", src), Reading(round(khz / (BUS_MHZ * 1000.0)), "x", src)
        why = f"{src} reads 0"
    if msr is None:
        return unavailable("msr 0x621", f"{why or 'no sysfs'}; " + NO_MSR_TEXT, "MHz"), unavailable("msr 0x621", f"{why or 'no sysfs'}; " + NO_MSR_TEXT, "x")
    src = "msr 0x621[6:0]"
    try:
        ratio = bits(msr.rdmsr(cpu, MSR_UNCORE_PERF_STATUS), 6, 0)
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e), "MHz"), unavailable(src, str(e), "x")
    if ratio == 0:
        return unavailable(src, "ring ratio reads 0", "MHz"), unavailable(src, "ring ratio reads 0", "x")
    return Reading(float(ratio * BUS_MHZ), "MHz", src), Reading(ratio, "x", src)





def read_limit_reasons_ring(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    """0x6B1 (ring limit word, package scope) decoded the same way as :func:`read_limit_reasons`. Plain rdmsr."""
    src = "msr 0x6B1 (decoded)"
    try:
        decoded = decode_ring_6b1(msr.rdmsr(cpu, MSR_RING_PERF_LIMIT_REASONS)).to_json()
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e))
    return Reading(decoded, "", src)


def read_pkg_therm_status(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    """0x1B1 throttle bits (package thermal / PROCHOT / critical / power-limit notification and their kernel-cleared log bits) decoded. Plain rdmsr, once per tick."""
    src = "msr 0x1B1 (decoded)"
    try:
        decoded = decode_pkg_therm_1b1(msr.rdmsr(cpu, MSR_PACKAGE_THERM_STATUS)).to_json()
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e))
    return Reading(decoded, "", src)


def decode_pl4(raw: int, power_unit_raw: int) -> dict | None:
    """MSR 0x601 (PL4, the enforced peak limit) as ``{"watts", "locked", "raw"}``: watts = ``[14:0]`` x 2^-``0x606[3:0]`` W, ``locked`` = bit 31.
    ``None`` when the field is 0 (no PL4 reported). ``[MEASURED lnx 2026-11-11, throttling.md section G]`` 0xd48 with unit 3 = 425.0 W, unlocked."""
    watts = bits(raw, 14, 0) / (1 << bits(power_unit_raw, 3, 0))
    if watts == 0:
        return None
    return {"watts": watts, "locked": bool(bits(raw, 31, 31)), "raw": raw}


def read_pl4(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    """0x601 PL4 decoded (package scope, read-only). The value is ``{watts, locked, raw}``; unreadable or a zero field is unavailable with the reason."""
    src = "msr 0x601 (PL4)"
    try:
        decoded = decode_pl4(msr.rdmsr(cpu, MSR_PKG_POWER_LIMIT_PL4), msr.rdmsr(cpu, MSR_RAPL_POWER_UNIT))
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e), "W")
    if decoded is None:
        return unavailable(src, "PL4 field reads 0", "W")
    return Reading(decoded, "W", src)


def read_limit_reasons_raw(msr: TelemetryMsr, cpu: int = 0) -> Reading:
    """Raw 0x6B0 (graphics) word, undecoded -- kept unchanged for consumers of ``limit_reasons_raw`` for one release."""
    src = "msr 0x6B0 (raw)"
    try:
        return Reading(msr.rdmsr(cpu, MSR_GFX_PERF_LIMIT_REASONS), "raw", src)
    except (MsrError, ValueError) as e:
        return unavailable(src, str(e), "raw")
