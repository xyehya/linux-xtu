"""``EXPECTED-words.txt`` -- one parser for every reader (G-154, D-045).

Lines: ``<linux cpu> <OC word P2=0> <point 1> ... <point n>`` (hex, no ``0x``) per core / E-cluster, and (G-154) at most one ``ring  <OC word> <point 1> ... <point n>``
line for the ring (cache, mailbox domain P1 = 2): its key is literally ``ring``. A file without a ``ring`` line has no ring in the accepted state: nothing about the ring is
compared or restored. ``#`` lines and blanks are ignored. Pure, no I/O.
"""
from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence

__all__ = ["RING_KEY", "format_ring_line", "parse_expected", "state_digest"]

#: The key of the ring line of ``EXPECTED-words.txt``.
RING_KEY = "ring"
MAX_WORDS = 64


def parse_expected(text: str) -> tuple[dict[int, list[int]], list[int] | None]:
    """``(cpu -> words, ring words | None)``. ``ValueError`` (naming the line) when a line is malformed, a cpu or the ring appears twice, or the file holds no cpu line."""
    table: dict[int, list[int]] = {}
    ring: list[int] | None = None
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        is_ring = parts[0] == RING_KEY
        try:
            cpu = -1 if is_ring else int(parts[0])
            words = [int(w, 16) for w in parts[1:]]
        except ValueError:
            raise ValueError(f"line {number}: not '<cpu> <hex words>' or 'ring <hex words>'") from None
        if len(words) > MAX_WORDS:
            raise ValueError(f"line {number}: {len(words)} words (at most {MAX_WORDS} are plausible)")
        if (not is_ring and cpu < 0) or len(words) < 2 or any(not 0 <= w <= 0xFFFFFFFF for w in words):
            raise ValueError(f"line {number}: needs a cpu (or 'ring'), the OC word and at least one point, each a 32-bit hex word")
        if is_ring:
            if ring is not None:
                raise ValueError(f"line {number}: the ring appears twice")
            ring = words
        else:
            if cpu in table:
                raise ValueError(f"line {number}: cpu {cpu} appears twice")
            table[cpu] = words
    if not table:
        raise ValueError("no expected words")
    return table, ring


def format_ring_line(words: list[int] | tuple[int, ...]) -> str:
    """``ring  <OC word> <point 1> ... <point n>`` (hex, no 0x), the shape of a core line."""
    return f"{RING_KEY}  " + " ".join(f"{int(w):X}" for w in words)


def state_digest(words: Mapping[int, Sequence[int]] | None, ring: Sequence[int] | None = None, tables: Mapping[str, Sequence[int]] | None = None) -> str | None:
    """G-244 (QA-23): a short, stable id of the tuning state -- the words ``profiles.accept`` records in ``EXPECTED-words.txt`` (one line per cpu, hex, sorted by cpu; the ring
    line when the read has the ring), plus the turbo tables when the read has them. ``None`` when there are no words (no read this boot). A stress record stores it, so
    Accept can tell whether a run was made on the state being accepted. 16 hex digits of SHA-256; not a secret, only an identity."""
    if not words:
        return None
    lines = [f"{int(cpu)} " + " ".join(f"{int(w):X}" for w in words[cpu]) for cpu in sorted(words)]
    if ring:
        lines.append(format_ring_line(ring))
    for key in sorted(tables or ()):
        lines.append(f"turbo-{key} " + " ".join(str(int(v)) for v in tables[key]))  # type: ignore[index]
    return hashlib.sha256("\n".join(lines).encode("ascii")).hexdigest()[:16]
