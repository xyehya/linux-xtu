// Hint copy for the whole app (desktop/DESIGN.md §6). DATA ONLY: no DOM, no imports, no behaviour.
//
// Shape of an entry in HINTS:
//   label  plain-language label, shown first (the field label, the context-line key)
//   term   the expert term, shown second in mono/grey (optional)
//   unit   unit of the value (optional)
//   line   the context line: <= LIMITS.line characters, one sentence or two short ones, no trailing period needed
//   more   paragraphs for the "?" expander: <= LIMITS.more characters together (optional)
//   tip    id of the Tips section that explains it (lib/tips.js), shown as "More in Tips ›" (optional)
//   src    where the fact comes from (docs/knowledge, decisions); for reviewers, never shown
// WHY holds the reason templates for refused / locked / warning lines ({name} placeholders, filled by the caller); <= LIMITS.why after filling.
// SCREEN holds the idle line each screen shows in the context line when nothing has focus.
//
// Tone (DESIGN.md §6.6): short, concrete, present tense; the consequence and the safe direction; numbers with units; no hype, no
// exclamation marks, no "simply/just/easy". Never state an unmeasured behaviour as fact. "−" (U+2212) for minus in display text.
// Check: node desktop/design/tools/check_copy.mjs

export const LIMITS = Object.freeze({ line: 120, more: 360, why: 160 });

export const HINTS = Object.freeze({
  // ------------------------------------------------------------------ global state (top bar)
  "state.read": {
    label: "Read",
    line: "Reads every V/F point, ratio, table and limit from the CPU. Changes no setting.",
    more: [
      "Mailbox reads still pass through a CPU register: one write to the mailbox register per request. The cost tag shows how many requests a Read takes.",
      "If you have edits, Read asks before it replaces them.",
    ],
    src: "registers.md (OC mailbox request model); D-053 rule 5",
  },
  "state.accepted": {
    label: "Accepted",
    term: "accepted state",
    line: "Your known-good state. “differs” means the CPU now holds something else, for example after a reboot.",
    tip: "stop",
    src: "SPEC §6; D-053 rule 7",
  },
  "state.accept": {
    label: "Accept",
    line: "Marks what the CPU holds now as your known-good state. Do it only after a long, clean stress run.",
    more: ["Accepting does not write the CPU. It records the state so Restore accepted can bring it back after a boot."],
    tip: "testing",
    src: "SAFETY.md (accept after a clean run); tuning-results.md §2",
  },
  "state.restore": {
    label: "Restore accepted",
    line: "Plans the writes that bring the CPU back to your accepted state. You review and apply them.",
    tip: "stop",
    src: "D-053 rule 7",
  },
  "state.review": {
    label: "Review",
    line: "Asks the helper to plan your edits: the exact writes, in order, with a prediction. Writes nothing.",
    src: "SPEC §4.3",
  },
  "state.apply": {
    label: "Apply",
    line: "Sends the plan’s writes one at a time and reads each one back. A system dialog asks you to confirm first.",
    more: ["If anything is refused or reads back different, the sheet says which write and what the CPU holds now."],
    src: "SPEC §4.3; D-053 rule 4 (confirmation owned by the shell)",
  },
  // ---- R-S3: the commit sheet ("Review", DESIGN.md §5.10). One block: its buttons, its states, its boxes.
  "sheet.close": {
    label: "Close, keep plan",
    line: "Hides the sheet. The plan stays until it expires; a running apply goes on.",
  },
  "sheet.replan": {
    label: "Review again",
    line: "Plans again from what is on screen now. Writes nothing.",
  },
  "sheet.cancel": {
    label: "Stop after this write",
    line: "Stops between writes. The write in flight still finishes and is read back.",
  },
  "sheet.accept": {
    label: "Set as accepted",
    line: "Opens Profiles to record this state as your accepted state. Do it after a long, clean stress run.",
    tip: "testing",
  },
  "sheet.stress": {
    label: "Screen with stress",
    line: "Opens Stress to screen the state the CPU now runs. A screen is quick; acceptance needs a longer test.",
    tip: "testing",
  },
  "sheet.read": {
    label: "Read",
    line: "Reads what the CPU holds now, so the units show it. Changes no setting.",
  },
  "sheet.confirming": {
    label: "Confirming",
    line: "A system dialog asks you to confirm. Nothing is written before you click its Apply button.",
    src: "D-053 rule 4 (native dialog, write button armed after 0.7 s)",
  },
  "sheet.ready_again": {
    label: "Ready",
    line: "Nothing was written. Apply asks again in a system dialog.",
  },
  "sheet.expired": {
    label: "Expired",
    line: "This plan is older than 10 minutes. Review again.",
    src: "SPEC §4.3 (plans expire after 600 s)",
  },
  "sheet.stale": {
    label: "Stale",
    line: "A value changed since the plan was made, or the plan is gone. Review again.",
  },
  "sheet.mix": {
    label: "May be out of date",
    line: "The units may not show what the CPU holds now. Read it before you change anything else.",
  },
  // ---- R-I1: why the helper refused a plan at apply time (PLAN_STALE detail.check), shown with Review again.
  "sheet.intent_changed": {
    label: "Edits changed",
    line: "Your edits are not the ones this plan was made from. Review again.",
    src: "tune_intent.py intent_changed (R-26): the apply carries the editor's intent",
  },
  "sheet.state_changed": {
    label: "CPU changed",
    line: "A value this plan was made from changed on the CPU. Review again.",
    src: "ops_tune_apply.py _stale_check (R-27): words, ring words and turbo tables are compared before the first write",
  },
  "state.discard": {
    label: "Discard",
    line: "Drops your edits. The CPU is not touched.",
  },
  "state.mbx": {
    label: "Mailbox requests",
    term: "MBX",
    line: "Mailbox requests this boot, reads included. The helper refuses more than its per-boot cap.",
    src: "D-049 (cap 100000)",
  },

  // ------------------------------------------------------------------ frame: context line, Tips, readout bar
  "ui.hints": {
    label: "Hints",
    line: "On: this line explains the control you are on. Quiet: it and the teaching text step back; reasons stay.",
    src: "DESIGN.md §6.7",
  },
  "ui.tips": {
    label: "Tips",
    term: "F1",
    line: "Opens the plain-language guide at the part about the control you are on.",
    src: "DESIGN.md §10",
  },
  "readout.pkg": {
    label: "Package power",
    term: "PKG",
    unit: "W",
    line: "What the whole processor package draws now. Select any value to show the last 60 s of all six.",
    tip: "power",
    src: "store.js SERIES pkg_power (powercap energy counter)",
  },
  "readout.clk": {
    label: "Highest clock",
    term: "CLK",
    unit: "GHz",
    line: "The fastest core clock right now.",
    tip: "ratios",
    src: "store.js SERIES clock (highest core clock of the sample)",
  },
  "readout.hot": {
    label: "Hottest sensor",
    term: "HOT",
    unit: "°C",
    line: "The highest temperature any CPU sensor reports now.",
    src: "store.js SERIES temp (hottest hwmon sensor)",
  },
  "readout.vcore": {
    label: "Core voltage",
    term: "VCORE",
    unit: "V",
    line: "The core voltage the motherboard sensor reports. n/a when the board exposes no such sensor.",
    src: "store.js SERIES vcore (hwmon)",
  },
  "readout.core": {
    label: "Core power",
    term: "CORE",
    unit: "W",
    line: "Power of the cores alone. n/a when the CPU reports no separate core figure.",
    src: "store.js SERIES core_power (powercap core subdomain)",
  },
  "readout.dram": {
    label: "Memory traffic",
    term: "DRAM",
    unit: "GB/s",
    line: "Memory read plus write bandwidth. n/a without memory-controller sampling.",
    src: "store.js SERIES dram (IMC counters)",
  },

  // ------------------------------------------------------------------ annunciators
  "ann.helper": {
    label: "Helper",
    line: "The root helper that talks to the CPU. Green: connected. Amber: busy with another client. Red: not reachable.",
  },
  "ann.writes": {
    label: "Writes",
    line: "Green: this machine allows writes. Lit READ-ONLY: a preflight check blocked writes; reading still works.",
    more: ["System › Preflight lists every check and which one failed."],
  },
  "ann.uvp": {
    label: "Undervolt Protection",
    term: "UVP",
    line: "A BIOS setting. Lit: the CPU refuses negative offsets. “?” until a first negative write shows which way it is set.",
    more: ["Turn it off in the BIOS to undervolt. The app remembers a refusal for the rest of the boot and locks the offset fields."],
    src: "registers.md (rc 0x13, MEASURED 2026-10-19); G-240",
  },
  "ann.pl1": {
    label: "PL1",
    term: "MSR 0x64F bit 10",
    line: "Lit: the long-term limit PL1 holds the clocks down. Normal during long heavy loads.",
    tip: "power",
    src: "registers.md (0x64F table)",
  },
  "ann.pl2": {
    label: "PL2",
    term: "MSR 0x64F bit 11",
    line: "Lit: the short-term limit PL2 holds the clocks down.",
    tip: "power",
    src: "registers.md (0x64F table)",
  },
  "ann.pl4": {
    label: "Current / PL4",
    term: "MSR 0x64F bit 8",
    line: "Lit: the peak limit PL4 binds. Seen on one tested chip when all cores run AVX2 code and the predicted peak meets PL4.",
    more: [
      "The CPU compares a worst-case estimate for the running instructions with PL4, not the measured draw, so this can light while real power sits well below the limit.",
    ],
    tip: "indicators",
    src: "throttling.md §G [MEASURED lnx 2026-11-11, one chip]",
  },
  "ann.therm": {
    label: "Thermal",
    term: "MSR 0x64F bits 0, 1, 5",
    line: "Lit: a thermal limit binds (temperature limit, PROCHOT or the running-average limit). Check cooling first.",
    tip: "indicators",
    src: "throttling.md §B",
  },
  "ann.vr": {
    label: "VR thermal",
    term: "MSR 0x64F bit 6",
    line: "Lit: the motherboard’s voltage regulator signals a thermal alert.",
    src: "throttling.md §B",
  },
  "ann.turbo": {
    label: "Max turbo",
    term: "MSR 0x64F bit 12",
    line: "Lit: the turbo table caps the ratio for this many busy cores. Normal under load, so it lights grey.",
    tip: "ratios",
    src: "throttling.md §B; registers.md (bit 12 interpretation)",
  },

  // ------------------------------------------------------------------ Tune › Cores: units
  "unit.pcore": {
    label: "P-core",
    line: "One performance core: its own ratio limit and its own voltage curve.",
  },
  "unit.ecluster": {
    label: "E-cluster",
    line: "Four E-cores that run one ratio. Whether one core’s write moves all four is not settled, so the app writes all four.",
    more: ["A ratio cap on one E-core alone does not hold it: its neighbours set the cluster’s clock. Caps go to the whole cluster."],
    src: "platform-arl-s.md §2, §3 (E cap MEASURED 2026-10-14)",
  },
  "unit.ring": {
    label: "Ring",
    line: "The ring bus between the cores and the shared cache. Its V/F points take offsets like a core’s.",
    more: ["Its clock range is set separately, in Tune › Ring & uncore."],
    src: "platform-arl-s.md §3 (ring points, MEASURED)",
  },
  "unit.favored": {
    label: "Favored core",
    term: "★",
    line: "Fused to reach a higher top ratio than the other P-cores. It gets there only while few cores are busy.",
    tip: "ratios",
    src: "favored-cores.md §1",
  },
  "unit.top": {
    label: "Curve top",
    term: "factory top ratio",
    line: "The highest ratio of the unit’s factory V/F curve; not what the core may run (see Top ratio in Tune › Frequency).",
  },
  "unit.topratio": {
    label: "Top ratio",
    unit: "×",
    line: "The most this unit runs: its OC ratio if it has one, else its fused maximum. Cap and turbo table can hold it lower.",
    more: ["Favored cores are fused to 57×, the other P-cores to 55×, E-clusters to 46×. An OC ratio (marked OC) replaces that ceiling."],
    tip: "ratios",
    src: "platform-arl-s.md §3, §8 (0x1C favored ratio, fused top); lib/units.js topRatio; D-050",
  },

  // ------------------------------------------------------------------ Tune › Cores: V/F table
  "vf.factory": {
    label: "Factory",
    term: "fused voltage",
    unit: "V",
    line: "The point’s voltage with no offsets. The top point is read from the CPU; the others come from a stock curve.",
    more: ["Without a stock baseline curve (Curves) the lower points’ factory voltages are unknown and show n/a."],
    src: "platform-arl-s.md §4 (only the top point is exposed); tuning-results.md §4",
  },
  "vf.now": {
    label: "Now",
    unit: "V",
    line: "Factory voltage plus the offsets the CPU holds, from the last read. A prediction, not a measurement.",
    src: "assessment 03 U-10",
  },
  "vf.after": {
    label: "After",
    unit: "V",
    line: "What this point will ask for once your edits are applied, including the CPU’s own clamp.",
  },
  "vf.delta": {
    label: "Δ",
    unit: "mV",
    line: "After minus Now: the change your edits make at this point.",
  },
  "vf.point.offset": {
    label: "Offset",
    term: "V/F point offset",
    unit: "mV",
    line: "Millivolts added to this point’s factory voltage. Lower runs cooler; too low gives wrong results under load.",
    more: [
      "Ratios between two points get a voltage in between. Ratios above the top point use the top point’s voltage while the unit has no OC point.",
      "Only 0 and negative values are offered. The field’s floor is −1000 mV.",
    ],
    tip: "first-undervolt",
    src: "platform-arl-s.md §3 (interpolation, above-top MEASURED); registers.md (11-bit field); D-053 rule 5",
  },
  "vf.curve.offset": {
    label: "Whole curve",
    term: "whole-curve offset",
    unit: "mV",
    line: "Shifts every point of this unit and adds to the point offsets: −10 here and −20 on a point make −30 there.",
    more: [
      "The CPU keeps it apart from the point offsets (in the unit’s OC word) and adds the two.",
      "Measured on units without an OC point. With an OC point on the unit, its effect has not been measured yet.",
    ],
    tip: "first-undervolt",
    src: "platform-arl-s.md §3, tuning-results.md §5–6 [MEASURED 2026-10-11/12]; assessment 03 R-05/E-2 (with OC point: open)",
  },
  "vf.clamp": {
    label: "Clamped",
    term: "↑",
    line: "The CPU lifts this point to the one below: every point stays at or above its lower neighbour.",
    more: ["So a deep offset on a high point can be partly absorbed. The After column shows what the point will really ask for."],
    src: "platform-arl-s.md §3 (monotonic clamp, MEASURED)",
  },
  "vf.e40": {
    label: "E 40× point",
    line: "On one tested chip an offset on this point caused errors under load. Change it last, and alone.",
    src: "platform-arl-s.md §3 (one chip); E40_OFFSET",
  },

  // ------------------------------------------------------------------ Tune › Cores: OC point
  "oc.ratio": {
    label: "OC ratio",
    term: "OC point",
    unit: "×",
    line: "Adds one point above the factory top ratio, with its own voltage. It does not raise the turbo table.",
    more: [
      "The new point asks for its own OC voltage. On the ring tested, lowering the top point did not lower it.",
      "The CPU cannot remove an OC point while running: a cold boot clears it. The turbo table still decides when cores may reach it (Frequency).",
    ],
    tip: "ratios",
    src: "platform-arl-s.md §3 (OC point, cannot be written back to 0, ring OC point holds its own voltage); D-050",
  },
  "oc.voltage": {
    label: "OC voltage",
    term: "adaptive target",
    unit: "V",
    line: "The voltage the OC ratio asks for. Higher is more stable at that ratio and hotter. Keep it at or above the top point.",
    more: [
      "The CPU lifts a lower value to the top point. Ratios between the top point and the OC ratio get a voltage on a straight line between the two.",
      "The ceiling is the CPU’s reported maximum, not a safe value: the app cannot know what is safe for your chip.",
    ],
    src: "platform-arl-s.md §3 (target clamped up, MEASURED); tuning-results.md §7 (linear, MEASURED); D-038/D-039; D-053 rule 6",
  },
  // Tune › Cores: unit table columns (R-S1)
  "unit.offset": {
    label: "Offset",
    unit: "mV",
    line: "The deepest offset on the unit, whole curve included.",
    src: "lib/draft.js effPointMv (layers add, platform-arl-s.md §3 [MEASURED 2026-10-11/12])",
  },
  "unit.clock": {
    label: "Clock",
    unit: "GHz",
    line: "The unit’s clock now: the fastest of its CPUs. The ring’s clock is on Ring & uncore.",
    src: "store.js telemetry cores[cpu].mhz; ring now = MSR 0x621 (Ring & uncore)",
  },

  // ------------------------------------------------------------------ Tune › Frequency
  "freq.effective": {
    label: "What a core runs at",
    unit: "×",
    line: "The lowest of the core’s top ratio, its ratio cap and the turbo-table entry for the number of busy cores.",
    more: ["Power and temperature limits can hold it lower still; the indicators in the bottom bar show when they do."],
    tip: "ratios",
    src: "assessment 03 U-20; G-251",
  },
  "turbo.bucket": {
    label: "Busy cores",
    term: "turbo ratio limit",
    unit: "×",
    line: "The highest ratio allowed while this many cores are busy. Takes effect at once; a cold boot restores the BIOS table.",
    more: [
      "A bucket may not be higher than the one to its left: more busy cores never get a higher ratio, and such a table is refused.",
      "An OC ratio above the table does nothing until the table allows it.",
    ],
    tip: "ratios",
    src: "platform-arl-s.md §7, §9 [MEASURED 2026-10-12]; D-050; D-053 rule 5",
  },
  "freq.cap": {
    label: "Ratio cap",
    term: "cpufreq max",
    unit: "×",
    line: "An operating-system limit on this unit’s clock; empty means none. A reboot removes it. E-clusters are capped as a whole.",
    src: "platform-arl-s.md §3 (E cap per cluster, MEASURED)",
  },

  // ------------------------------------------------------------------ Tune › Power
  "power.pl1": {
    label: "Long-term limit",
    term: "PL1",
    unit: "W",
    line: "Watts the package may average over the time window. Lower runs cooler and slower under long loads.",
    more: [
      "The CPU keeps a running average of package power; when it reaches PL1, clocks come down to hold it.",
      "A lower limit moves heavy loads onto lower V/F points, so test again after changing it. After a reset the BIOS value was back on the tested chip.",
    ],
    tip: "power",
    src: "registers.md (0x610, powercap); tuning-results.md §3.1, 2026-11-11 (limits back to BIOS after reset)",
  },
  "power.pl2": {
    label: "Short-term limit",
    term: "PL2",
    unit: "W",
    line: "Watts allowed in bursts, until the running average reaches PL1. Keep it at or above PL1.",
    tip: "power",
    src: "registers.md (0x610)",
  },
  "power.tau": {
    label: "Time window",
    term: "tau",
    unit: "s",
    line: "How far back the PL1 average looks. A longer window lets bursts run near PL2 for longer.",
    more: ["The CPU stores the window in coarse steps; the plan shows the value that will actually be written."],
    tip: "power",
    src: "registers.md (tau encoding, snapped down)",
  },
  "power.pl4": {
    label: "Peak limit",
    term: "PL4 · MSR 0x601",
    unit: "W",
    line: "Read only. The CPU checks it against a predicted peak, not measured draw, so it can cap all-core AVX2 work early.",
    more: [
      "When it binds, the Current / PL4 indicator lights. After a reset the BIOS value was back on the tested chip. This app shows PL4 and never changes it.",
    ],
    tip: "power",
    src: "throttling.md §G, registers.md (0x601 = W) [MEASURED 2026-11-11]; D-053 rule 7",
  },
  "power.lock": {
    label: "Locked by the BIOS",
    line: "The power limits are read-only until the next reboot.",
    src: "registers.md (MSR 0x610 bit 63, lock)",
  },

  // ------------------------------------------------------------------ R-S2: Tune › Frequency, Power, Ring & uncore (one block)
  "turbo.set_all": {
    label: "Set all",
    line: "Gives every bucket of this table the same ratio. Refused if the ratio is outside the CPU’s limits.",
    src: "assessment 03 U-22",
  },
  "turbo.fill_right": {
    label: "Fill right",
    line: "Copies the chosen bucket’s ratio to every bucket on its right.",
    src: "assessment 03 U-22",
  },
  "rt.restore_runtime": {
    label: "Restore boot values",
    term: "caps and ring range",
    line: "Plans the writes that put back the ratio caps and the ring range from before this boot’s first runtime write.",
    more: ["Caps and the ring range are restored together: the helper keeps one journal for both."],
    src: "assessment 03 U-24, R-23; G-234",
  },
  "rt.restore_power": {
    label: "Restore boot values",
    term: "power limits",
    line: "Plans the writes that put back PL1, PL2 and tau from before this boot’s first power write.",
    src: "G-234",
  },
  "power.pl4_copy": {
    label: "PL4 copy",
    term: "powercap peak_power",
    line: "The powercap peak_power copy of PL4 is not enforced on this chip. Only the CPU’s own PL4 counts.",
    src: "throttling.md §G [MEASURED lnx 2026-11-11, one chip]",
  },
  "power.binds": {
    label: "Binds now",
    term: "MSR 0x64F",
    line: "Which power limit holds the clocks down now, with its share of the last sampling window.",
    tip: "indicators",
    src: "throttling.md §B; store.js deriveThrottle",
  },
  "uncore.driver": {
    label: "At boot",
    term: "driver’s initial range",
    unit: "×",
    line: "The range the ring clock had at boot. A reboot brings it back.",
    src: "registers.md (0x620); intel_uncore_frequency initial_min/max_freq_khz",
  },
  "uncore.separate": {
    label: "NGU and D2D",
    line: "Changes the ring clock only; NGU and D2D clocks are set in the BIOS.",
    more: ["Whether the driver’s range also moves the NGU clock has not been measured."],
    src: "assessment PLAN.md operator facts (three independent settings, UNVERIFIED which is BIOS-only); registers.md 0x620 (ring vs NGU unknown)",
  },
  "ring.vf": {
    label: "Ring V/F offsets",
    line: "Edited with the cores: Tune › Cores, the Ring row.",
    src: "DESIGN.md §8.1 (ring V/F only in Cores)",
  },

  // ------------------------------------------------------------------ Tune › Ring & uncore
  "uncore.max": {
    label: "Ring clock, maximum",
    term: "uncore max ratio",
    unit: "×",
    line: "The highest ratio the ring may run. Lower saves power and costs cache and memory bandwidth.",
    more: [
      "A reboot brings back the driver’s values.",
      "Whether this range also moves the NGU clock is not known. D2D and NGU are BIOS settings and are not shown.",
    ],
    src: "registers.md (0x620 = ring min/max, MEASURED); PLAN.md operator facts (NGU/D2D)",
  },
  "uncore.min": {
    label: "Ring clock, minimum",
    term: "uncore min ratio",
    unit: "×",
    line: "The lowest ratio the ring may drop to when idle. At or below the maximum.",
    src: "registers.md (0x620)",
  },
  "ring.now": {
    label: "Ring now",
    term: "MSR 0x621",
    unit: "×",
    line: "The ratio the ring runs right now.",
    src: "registers.md (0x621)",
  },

  // ------------------------------------------------------------------ Stress
  "stress.screen": {
    label: "Quick screen",
    line: "A short load that finds bad settings fast. Passing it does not prove a setting is stable.",
    more: [
      "Unstable undervolts can fail silently: a wrong result, no crash, often nothing in the logs.",
      "Before you accept a setting, run a long self-checking test, an hour or more, with every core loaded.",
    ],
    tip: "testing",
    src: "tuning-results.md §1, §2",
  },
  "stress.length": {
    label: "Length",
    line: "Longer runs find more. Time to the first error varies widely, so only a full pass counts.",
    src: "tuning-results.md §2",
  },
  "stress.cap": {
    label: "Hold at ratio",
    line: "Keeps the loaded units at one ratio, to test the V/F point there. E-clusters are held as a whole.",
    src: "power-profile-capping.md; platform-arl-s.md §3",
  },
  "stress.units": {
    label: "Units to load",
    line: "Which units carry the load. Test one unit at a time to know which one failed.",
    src: "tuning-results.md §1 (errors do not name the core)",
  },
  "stress.errors": {
    label: "Errors",
    line: "Wrong results the self-check found. One error means the setting is not stable.",
  },

  // ------------------------------------------------------------------ Curves
  "curves.measure": {
    label: "Measure",
    line: "Holds each unit at one ratio at a time under load and records the voltage it asks for. Takes minutes, adds heat.",
    more: ["The reading is the requested voltage (VID). No sensor reports the voltage that actually reaches a core."],
    src: "tuning-results.md §4; platform-arl-s.md §5",
  },
  "curves.baseline": {
    label: "Baseline",
    line: "A complete measurement. Tune builds its Factory column and predictions on it: a stock curve (all offsets 0) as measured, a tuned one with the offsets it was measured with taken off (derived).",
    src: "assessment 03 R-36",
  },

  // ------------------------------------------------------------------ R-S4: Overview, Stress, Curves (one block)
  "overview.units": {
    label: "Units, live",
    line: "Clock, load and requested voltage of every unit, once a second. Reads only: no mailbox request.",
  },
  "overview.clock": {
    label: "Clock",
    unit: "GHz",
    line: "The unit’s clock in the last sample: its fastest CPU.",
  },
  "overview.top": {
    label: "Top",
    unit: "×",
    line: "The highest ratio this core runs at: its OC ratio when one is set, else its fused maximum.",
  },
  "overview.busy": {
    label: "Busy",
    unit: "%",
    line: "Share of the last second the unit’s CPUs were not idle. The bar is the same number.",
  },
  "overview.vid": {
    label: "Requested voltage",
    term: "VID",
    unit: "V",
    line: "The highest voltage the unit’s cores ask for now. No sensor reports what reaches a core.",
    src: "platform-arl-s.md §5",
  },
  "overview.temp": {
    label: "Temperature",
    unit: "°C",
    line: "Hottest core of the unit, where a sensor names its core. Otherwise n/a; the readout bar shows the hottest sensor.",
  },
  "overview.history": {
    label: "History",
    line: "Package power, highest clock, hottest sensor and Vcore on one time axis. Arrow keys move the cursor.",
  },
  "overview.window": {
    label: "Window",
    line: "How far back the history reaches. Kept while this screen is open, up to 15 min.",
  },
  "overview.limits": {
    label: "Limits now",
    line: "Which limit holds the clock down right now and how often, with where to change it.",
    tip: "indicators",
    src: "throttling.md §B, §G",
  },
  "overview.events": {
    label: "Throttle events",
    line: "Each time a limit held the clock down: when, for how long and the peaks. Read from the helper’s log.",
    src: "throttling.md §C",
  },
  "overview.state": {
    label: "State",
    line: "The last quick screen, and where to run another.",
    tip: "stop",
  },
  "overview.memory": {
    label: "Read memory",
    line: "Asks the helper once for memory speed, gear and timings. Static between boots, so it never repeats by itself.",
  },
  "stress.load": {
    label: "Load",
    line: "CPU: the units you pick run a self-checking load. Memory: a memory test on all CPUs.",
  },
  "stress.kind.integer": {
    label: "Integer",
    line: "Integer arithmetic on every loaded core. Moderate heat; a good first screen after an edit.",
  },
  "stress.kind.vector": {
    label: "Vector math",
    line: "Matrix products on the vector units. The most power and heat; finds weak points at high load.",
  },
  "stress.kind.cache": {
    label: "Cache",
    line: "Thrashes the caches. Less heat; touches the ring and cache paths more than the cores.",
  },
  "stress.memory": {
    label: "Memory to test",
    line: "How much memory the test claims. Automatic takes three quarters of what is free.",
  },
  "stress.tested": {
    label: "What is tested",
    line: "The state the CPU holds now. Edits in Tune that are not applied are not part of the run.",
    src: "assessment 03 U-36",
  },
  "stress.start": {
    label: "Start stress",
    line: "Starts the screen on the selected units. It heats the CPU for the length shown; Stop ends it early.",
  },
  "stress.stop": {
    label: "Stop",
    line: "Ends the screen now. The result so far is kept.",
  },
  "stress.timer": {
    label: "Elapsed",
    line: "Time run of the length asked for. Errors, the hottest sensor and the peak package power follow below.",
  },
  "stress.result.clean": {
    label: "No errors",
    line: "No error in this run. It is a quick screen: run a long self-checking test before you accept the state.",
    tip: "testing",
  },
  "stress.result.errors": {
    label: "Errors found",
    line: "The state is not stable. Move the last offset you changed back toward 0 mV, apply, and screen again.",
    tip: "stop",
  },
  "stress.result.stopped": {
    label: "Stopped",
    line: "Stopped before the end, so it shows nothing about the remaining time. Run the full length to judge.",
  },
  "stress.result.tool": {
    label: "Tool error",
    line: "The load tool failed; this says nothing about stability. The notes below name the cause.",
  },
  "stress.result.health": {
    label: "Health changed",
    line: "The machine check or kernel logs changed during the run. Treat the state as unstable until you know why.",
  },
  "stress.history": {
    label: "Earlier screens",
    line: "Every screen run on this computer, newest first, with the state it tested where the helper recorded it.",
  },
  "curves.select": {
    label: "Units",
    line: "Checked units are measured by Measure and drawn in the chart.",
  },
  "curves.quick": {
    label: "Quick",
    line: "Only the V/F point ratios of each unit. About 2 min for all units.",
  },
  "curves.dense": {
    label: "Dense",
    line: "Every ratio from 8× to the unit’s top. About 10 min for all units; more heat.",
  },
  "curves.name": {
    label: "Name",
    line: "Optional name for the stored curve, for example stock. Up to 64 characters.",
  },
  "curves.cancel": {
    label: "Cancel",
    line: "Stops the measurement. The points measured so far are kept as a partial curve.",
  },
  "curves.curve": {
    label: "Curve",
    line: "The stored curve drawn solid. A stock curve marked baseline is what Tune predicts from.",
  },
  "curves.compare": {
    label: "Compare",
    line: "A second curve drawn dashed under the first, or subtracted from it in Δ mV.",
  },
  "curves.spread": {
    label: "Spread",
    line: "Shades the range between the lowest and highest unit at each frequency.",
  },
  "curves.vid": {
    label: "Requested voltage (VID)",
    line: "The voltage the core asks for at each ratio. No sensor reports the voltage that actually reaches a core.",
    src: "platform-arl-s.md §5",
  },
  "curves.delta": {
    label: "Δ mV",
    line: "Plots the curve minus the compared curve in mV. Negative means the curve asks for less voltage.",
  },
  "curves.table": {
    label: "Table",
    line: "Requested volts per unit and ratio. ~ marks an interpolated value.",
  },
  "curves.library": {
    label: "Library",
    line: "Stored curves: view, compare, rename, export, delete, and pick the stock baseline.",
  },

  // ------------------------------------------------------------------ Profiles
  "profile.save": {
    label: "Save profile",
    line: "Saves the complete state of the last read with your edits on top, as a file. Writes nothing to the CPU.",
  },
  "profile.load": {
    label: "Load into Tune",
    line: "Turns the profile into edits in Tune, so you can review them before anything is written.",
  },

  // ------------------------------------------------------------------ S5: Profiles, System, Audit, Setup (one block; R-S5)
  // Entries ending in .empty / .why / .note are rendered as empty-state titles (label) + teaching text (line), or as reason lines (label = lead word).
  "profile.state": {
    label: "Save CPU state as…",
    line: "Saves what the CPU holds now (the last read) as a complete profile. It is not made the accepted state.",
    src: "G-228 profiles.save {from: read}",
  },
  "profile.review": {
    label: "Review",
    line: "Plans this profile against what the CPU holds now and opens the commit sheet. Only the values that differ are written.",
    src: "SPEC §4.3; tune.plan {profile}",
  },
  "profile.accept": {
    label: "Set as accepted…",
    line: "Records this profile as your known-good state. It must be what the CPU holds now. Writes nothing to the CPU.",
    more: [
      "Accept only after a long, clean stress run of exactly this state. The state it replaces is kept as a profile (accepted-before-<date>), so it can be accepted again.",
    ],
    tip: "testing",
    src: "SPEC §6 item 4; G-228; assessment 03 U-35",
  },
  "profile.evidence": {
    label: "Evidence",
    line: "The newest clean quick screen on record. A quick screen is not the long acceptance test.",
    src: "D-019; assessment 03 U-36",
  },
  "profile.compare": {
    label: "Compare",
    line: "The helper compares two states value by value: units, points, OC words, turbo tables and what else both hold.",
    src: "profiles.diff (G-228)",
  },
  "profile.section": {
    label: "Contents",
    line: "What the profile holds, section by section. A section it does not hold is left as the CPU has it when applied.",
    src: "R-B1 profile schema 2 (absent = not captured)",
  },
  "profile.absent": {
    label: "Not in this profile",
    line: "Applying this profile leaves this value as the CPU has it.",
    src: "R-B1 profile schema 2",
  },
  "profile.windows": {
    label: "Apply on Windows",
    term: "Apply-Profile.ps1",
    line: "Windows re-applies the accepted state with one PowerShell command. Record the fingerprint first, then copy the folder.",
    more: [
      "The folder holds the accepted profile, the expected words and the CPU fingerprint. Copy it to Windows, then run the command in an elevated PowerShell from the repository.",
      "The script checks the fingerprint before any write and reads every word back.",
    ],
    src: "docs/RUNBOOK-win.md; tools/win/Apply-Profile.ps1 (-From DIR)",
  },
  "profile.fingerprint": {
    label: "Record fingerprint",
    line: "Writes fingerprint.json beside the accepted state from this boot’s read. No mailbox request.",
    src: "G-141 profiles.fingerprint",
  },
  "profile.copy": {
    label: "Copy command",
    line: "Copies the command to the clipboard. The app never runs it.",
  },
  "profile.bootrestore": {
    label: "Enable boot restore",
    line: "Copies the command that turns boot restore on (it needs sudo). The app never runs it. Once on, the accepted state is applied again at start-up.",
    src: "D-053 §3; R-B6",
  },
  "profile.empty": {
    label: "No profiles yet",
    line: "A profile is a complete saved state: every unit and point, and the tables and limits the helper captured.",
  },
  "profile.noaccepted": {
    label: "No accepted state yet",
    line: "Accept a profile after a long, clean stress run. Restore accepted then brings it back after a boot.",
    tip: "stop",
  },
  "profile.confirm.why": {
    label: "Not accepted",
    line: "The helper asks for a confirmation this app version cannot give yet. Nothing was recorded.",
    src: "R-B1 profiles.accept nonce (D-053 item 4)",
  },
  "system.preflight": {
    label: "Preflight",
    line: "The helper’s checks of this machine. A failed or unknown check turns writes off.",
    src: "SAFETY.md preflight",
  },
  "system.rerun": {
    label: "Re-run preflight",
    line: "Runs the checks again. Reads files and the CPU’s identity only; no mailbox request.",
  },
  "system.limits": {
    label: "Limits from this CPU",
    line: "The CPU’s own limits, from the last read. They are the only bounds on a value besides the field encodings.",
    src: "D-049",
  },
  "system.helper": {
    label: "App",
    line: "The version of this desktop app and the bridge it reaches the helper through. The helper link and the mailbox count are in the top bar.",
  },
  "system.version": {
    label: "App version",
    line: "The version of this desktop app.",
    src: "src-tauri lib.rs app_version",
  },
  "system.refresh": {
    label: "Refresh",
    term: "telemetry interval",
    unit: "s",
    line: "How often the helper samples the live values for this window.",
    src: "settings.rs refresh_s 0.25…60",
  },
  "system.notify": {
    label: "Notifications",
    line: "A desktop notice when a long operation ends while the window is not in front.",
    src: "notify.rs",
  },
  "system.unsaved.why": {
    label: "Not saved",
    line: "This backend cannot store settings: they last until the app closes.",
  },
  "system.topology": {
    label: "Topology",
    line: "Units and their CPUs as the helper reads them from this machine. Nothing is hard-coded.",
    src: "D-036",
  },
  "system.maxratio": {
    label: "Max ratio",
    term: "cpufreq",
    line: "The highest ratio the kernel lets this unit run. Not the factory top point of the V/F curve.",
    src: "assessment 03 U-39; G-233",
  },
  "system.bootrestore": {
    label: "Boot restore",
    line: "Boot restore re-applies the accepted state at start-up once it is enabled. Its state and the command that enables it are on Profiles.",
    src: "D-053 §3; R-B6",
  },
  "audit.search": {
    label: "Search",
    line: "Filters operations by any text in their records: a CPU, a command, a result, a purpose.",
  },
  "audit.filter": {
    label: "Show",
    line: "All operations, or only those that changed or tried to change the CPU, with refusals and errors.",
  },
  "audit.op": {
    label: "Operation",
    line: "Requests grouped by what they were for. Open one to see every request and its raw record.",
    src: "assessment 03 U-38",
  },
  "audit.raw": {
    label: "Raw record",
    line: "The record exactly as the helper wrote it to its audit log.",
  },
  "audit.empty": {
    label: "No requests recorded",
    line: "The helper writes every request and every refusal to its audit log before it acts. Nothing has been sent yet.",
  },
  "setup.copy": {
    label: "Copy command",
    line: "Copies the command. Paste it into a terminal; the app never runs sudo itself.",
  },
  "setup.retry": {
    label: "Retry",
    line: "Connects to the helper again. Sends no mailbox request.",
  },
  "setup.after": {
    label: "Once connected",
    line: "Once connected you can read every V/F point, tune, stress-test and save profiles.",
  },
  // ------------------------------------------------------------------ R-F1b: Setup's version-mismatch state
  "setup.version": {
    label: "Versions differ",
    line: "The helper and this app come from different releases. Writes stay off until both match; reading works.",
    src: "R-I1 version.rs (protocol check)",
  },
  "setup.recheck": {
    label: "Retry",
    line: "Asks the helper for its version again (preflight). Sends no mailbox request.",
    src: "R-I1 mod.rs take_preflight",
  },
  "setup.continue": {
    label: "Continue read-only",
    line: "Opens the screens for this session without writes. Reading the CPU still works.",
  },
});

// Reason lines. {placeholders} are filled by the caller; the bold lead word is the key's first part (Refused / Locked / …).
export const WHY = Object.freeze({
  "refused.not_a_number": { lead: "Refused", text: "“{value}” is not a number. Nothing changed." },
  "refused.below_floor": { lead: "Refused", text: "{value} is below the field’s floor of {min} {unit}. Nothing changed." },
  "refused.above_limit": { lead: "Refused", text: "{value} is above the CPU’s limit of {max} {unit} ({source}). Nothing changed." },
  "refused.positive_offset": { lead: "Refused", text: "Only 0 or negative offsets are offered: a raise needs a base voltage the app cannot prove yet." },
  "refused.turbo_rise": { lead: "Refused", text: "A table may not rise with more busy cores: {prev} busy is {prevRatio}×, so {n} busy can be at most {prevRatio}×." },
  "refused.uncore_order": { lead: "Refused", text: "The minimum may not be above the maximum ({max}×)." },
  "refused.uncore_order_max": { lead: "Refused", text: "The maximum may not be below the minimum ({min}×)." },
  "refused.power_order": { lead: "Refused", text: "PL1 may not be above PL2: this makes PL1 {long} W and PL2 {short} W. Raise PL2 first, or lower PL1." },
  "info.turbo_followed": { lead: "Also lowered", text: "{list} busy now {value}×, so the table does not rise to the right." },
  "info.oc_capped": { lead: "Capped", text: "OC {oc}× is above the turbo table ({table}×), which still caps this unit. Raise the table to use it." },
  "locked.nothing_to_restore": { lead: "Nothing to restore", text: "No {what} was written in this boot." },
  "locked.unavailable": { lead: "Unavailable", text: "{reason}." },
  "locked.uvp": { lead: "Locked", text: "Undervolt Protection is on in the BIOS: the CPU refuses negative offsets." },
  "locked.read_only": { lead: "Locked", text: "Read-only mode: {reason}. See System › Preflight." },
  "locked.reading": { lead: "Reading", text: "Edits wait until the read finishes." },
  "locked.no_read": { lead: "Locked", text: "Read first: the limits for this field come from the CPU." },
  "locked.busy": { lead: "Unavailable", text: "{op} is running. One long operation at a time." },
  "locked.no_link": { lead: "Unavailable", text: "The helper is not connected. Setup says why and how to connect it." },
  "locked.stale_plan": { lead: "Locked", text: "You changed {what} after this review. Review again." },
  "locked.power_lock": { lead: "Locked", text: "The power limits are locked until the next reset (MSR 0x610 bit 63)." },
  "locked.cpu_offline": { lead: "Locked", text: "CPU {cpu} is offline. Bring it online before writing." },
  "locked.no_units": { lead: "Unavailable", text: "Select at least one unit in the table." },
  "locked.preflight_refused": { lead: "Unavailable", text: "Preflight refused this system. System › Preflight says why." },
  "locked.baseline_stock": { lead: "Unavailable", text: "Only a complete curve whose tuning state is known (stock, or tuned with its V/F words read) can be the baseline: Tune has to take its offsets off." },
  "warn.unapplied": { lead: "Not tested", text: "Not applied in Tune: {n}. This run tests what the CPU holds now, not your edits." },
  "warn.large_step": { lead: "Large step", text: "{value} mV in one edit. Undervolts are usually found in −10 to −20 mV steps." },
  "warn.clamped": { lead: "Clamped", text: "The CPU keeps each point at or above the one below, so {ratio}× runs at {volts} V." },
  // Tune › Cores: refusals and flags of the voltage model (lib/draft.js, lib/predict.js; R-S1)
  "refused.curve_and_points": { lead: "Refused", text: "A whole-curve change and point changes on one unit cannot go in one apply. Apply one first, then the other." },
  "refused.oc_mode_not_offered": { lead: "Refused", text: "Only the adaptive OC voltage is offered. “{mode}”: {what}." },
  "refused.target_needs_oc_point": { lead: "Refused", text: "An OC voltage needs an OC ratio above the factory top first. Nothing changed." },
  "refused.no_such_point": { lead: "Refused", text: "None of the selected units has this point. Nothing changed." },
  "locked.ring_unsupported": { lead: "Locked", text: "This helper does not take ring edits (no “ring” feature in its read). Update the helper to edit the ring." },
  "locked.needs_oc_ratio": { lead: "Locked", text: "Set an OC ratio above the factory top ({top}×) first: the OC voltage belongs to that point." },
  "warn.interp_not_measured": { lead: "Not measured", text: "Ratios between the top point and the OC ratio: measured only with the top point at offset 0. The line drawn is a guess." },
  "warn.oc_incomplete": { lead: "Incomplete", text: "The OC word says {ratio}× but this core’s maximum ratio is {max}×: the apply that set it stopped early." },
  "warn.target_lifted": { lead: "Lifted", text: "{volts} V is below the top point, so the CPU runs the OC point at {lifted} V." },
  "warn.oc_above_table": { lead: "Capped", text: "OC {oc}× is above the turbo table ({table}×): the table still caps this unit. Raise it in Frequency." },
  "warn.curve_with_oc": { lead: "Not measured", text: "This unit has an OC point; how a whole-curve offset combines with it has not been measured." },
  "warn.pl2_below_pl1": { lead: "Unusual", text: "PL2 below PL1: the short-term limit then caps sooner than the long-term one." },
  "warn.unusual_oc": { lead: "Unusual", text: "{value}× is more than 3 bins over the factory top ({top}×). Check for a typo." },
  "warn.e40": { lead: "Careful", text: "On one tested chip an offset on the E 40× point caused errors under load. Change it last, and alone." },
});

// Idle line per screen / tab: what the screen is for, in one line.
export const SCREEN = Object.freeze({
  overview: "Live state of every unit, the limits that bind now, and how the CPU compares with your accepted state.",
  "tune.cores": "Pick a unit, edit its V/F points, then Review. Nothing reaches the CPU before Apply.",
  "tune.frequency": "Everything that limits the ratio: OC and max ratio, turbo tables and ratio caps. The lowest one wins.",
  "tune.power": "Package power limits. Runtime values: after a reset the BIOS limits were back on the tested chip.",
  "tune.uncore": "The ring clock range. Runtime values: a reboot restores the driver’s range.",
  stress: "Quick screens that find bad settings fast. A long self-checking test is still needed before you accept.",
  curves: "Measured V/F curves: what each unit asks for at each ratio. A stock curve is the baseline for predictions.",
  profiles: "Saved states, your accepted state, and comparisons between them.",
  audit: "Every request the helper sent, grouped by operation.",
  system: "Preflight checks, the limits read from this CPU, topology and settings.",
  tips: "Plain-language guide: what this app changes, a first careful undervolt, testing, and a glossary.",
  setup: "Set up the helper, or match its version to the app. The app never runs sudo itself.",
});

// Inline confirms (DESIGN.md §5.1): the question and its two answers; {n} = "2 edits". Esc = the second (keep) answer.
export const CONFIRM = Object.freeze({
  "read.drop": { text: "Read drops {n}.", yes: "Read and drop", no: "Keep edits" },
  "discard.all": { text: "Discard all {n}?", yes: "Discard", no: "Keep" },
});

// Teaching empty states (DESIGN.md §5.12, §6.1 layer 6): title · one or two sentences (hidden with Hints: quiet) · the cost of the one action.
export const EMPTY = Object.freeze({
  "tune.noread": {
    title: "No read yet",
    teach: "Tune edits a copy of what the CPU holds now. Read it first: the app asks the CPU for every V/F point, ratio and table.",
    cost: "About 1 s. Changes nothing.",
  },
  "overview.notopology": {
    title: "No unit list yet",
    teach: "The units come from the helper’s preflight. They appear as soon as it answers.",
  },
  "curves.none": {
    title: "No curve yet",
    teach: "Measure records what each unit asks for at each ratio. A complete stock measurement becomes the baseline Tune predicts from.",
    cost: "Quick: about 2 min for all units. Adds heat.",
  },
  "stress.idle": {
    title: "No screen running",
    teach: "Pick the units and a length, then Start stress. The timer, errors, temperature and power appear here.",
  },
  "stress.history": {
    title: "No earlier screens",
    teach: "Each screen you run is kept on this computer with its result.",
  },
});
