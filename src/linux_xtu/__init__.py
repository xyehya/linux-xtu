"""Linux XTU (``linux-xtu``) — per-core tuning for Intel Arrow Lake-S (Core Ultra 200S) on Linux.

Standard library only. Architecture and contracts: docs/ARCHITECTURE.md. Facts: docs/knowledge/registers.md. Names: docs/NAMING.md (D-054).
"""

#: The one source of the version (R-B3, assessment 06 F5): the helper reports it in ``preflight`` (``helper.version``, next to the protocol integer
#: ``linux_xtu.helper.ops.PROTOCOL``) and the CLI in ``--version``. Semver with a pre-release tag ("0.2.0-dev"; PEP 440 normalises it to "0.2.0.dev0").
__version__ = "0.2.0-dev"

#: The display name and the line that follows it wherever the name is introduced (README, System > About, Tips, ``--version``; D-054).
DISPLAY_NAME = "Linux XTU"
NOT_AFFILIATED = "Not affiliated with or endorsed by Intel. XTU is a trademark of Intel Corporation."
