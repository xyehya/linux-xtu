# Glossary — one term per object and action

The words the app uses, what each means in hardware terms, and where the facts are. Sources of the app wording: the Glossary section of
`desktop/app/ui/lib/tips.js` (copy shown in the Tips screen) and §7 "Terminology" of `desktop/DESIGN.md` (one word per object and action). Hardware facts
and encodings are in the files named in the last column; nothing here is a measurement. "Expert" is the alias shown to readers who want the register-level word.

## Objects
| App term | Expert / alias | Meaning | Facts |
|---|---|---|---|
| **unit** | | One tunable thing: one P-core, one E-cluster, or the ring. Never "tile"; never "core" for an E-cluster. | `platform-arl-s.md` §2 |
| **P-core** | | A performance core. Each has its own fused V/F table and its own voltage regulator. | `platform-arl-s.md` §3, §13 |
| **E-cluster** | | Four efficient cores that run one ratio and are fed by one voltage regulator. The app writes all four members; whether one member's write already moves the cluster is open (C-4). Never "E-core group" or "E-core" for the cluster. | `platform-arl-s.md` §2, `mailbox-recon-summary.md` §4 |
| **ring** | uncore (cache/LLC clock domain) | The bus between the cores and the shared cache: its own V/F curve and its own clock range. NGU and D2D are separate fabric settings, not the ring. | `platform-arl-s.md` §11, `uncore-fabric.md` |
| **favored core** | star | A P-core fused to reach a higher top ratio than the others; detected from the fused byte `0x1C[15:8]`, not from sysfs. | `favored-cores.md` |
| **ratio** | multiplier | A speed step; the clock is the ratio times 100 MHz. | `registers.md` |
| **V/F point** | voltage/frequency point | One ratio of a unit's curve and the voltage requested there; each unit has a handful. | `platform-arl-s.md` §3 |
| **point offset** | offset | Millivolts added to the factory voltage of one V/F point; negative undervolts. | `registers.md` V/F data word |
| **whole-curve offset** | the `P2 = 0` offset | One offset for every point of a unit, additive to the point offsets. Never "sets every point", never "OC offset". | `platform-arl-s.md` §3 |
| **OC point** | OC ratio + adaptive target | The extra point above the factory top ratio, with its own voltage; terms **OC ratio** and **OC voltage** (its adaptive target). Cleared only by a cold boot; cannot be written back to 0. Never "OC slot", never "OC offset" for the target. | `platform-arl-s.md` §3 |
| **factory** | fused | Values set for this particular chip when it was made. Never "stock" (except "stock curve" in Curves) or "base". | `platform-arl-s.md` §4 |
| **requested voltage** | VID | The voltage a core asks for (`0x198[47:32]`); no sensor reports what reaches it. Never unqualified "voltage" or "actual voltage". | `registers.md`, `telemetry-sources.md` |
| **core voltage** | Vcore, VccIA | The board supply for the cores; it sits above the highest requested voltage. | `platform-arl-s.md` §5 |
| **turbo table** | turbo ratio limits | The highest ratio for each number of busy cores; one **bucket** per busy-core count. Never "turbo ratios"; never "active cores" in labels. | `platform-arl-s.md` §9, `registers.md` |
| **ratio cap** | cpufreq max | The cpufreq maximum set per unit. Never "frequency cap" or "scaling max". | `power-profile-capping.md` |
| **max ratio** | `0x1C` favored ratio | The favored-core ratio word. Never "own max ratio". | `registers.md` |
| **Runs up to** | effective max ratio | The minimum of the ratio limits that apply to a unit. | `platform-arl-s.md` §8 |
| **ring clock range** | uncore min/max ratio | The `intel_uncore_frequency` / `0x620` range. Never "Uncore (ring) ratio". | `registers.md` |
| **Long-term limit PL1** | PL1 | Package power limit, long-term. | `registers.md` Power limits |
| **Short-term limit PL2** | PL2 | Package power limit, short-term. | `registers.md` Power limits |
| **Time window tau** | tau | The averaging window of the long-term limit. | `registers.md` Power limits |
| **Peak limit PL4** | PL4 | A peak power limit enforced against a predicted worst case, read from MSR `0x601`; shown, never changed by the app. | `throttling.md` §G, `registers.md` |
| **mailbox request** | req; OC mailbox | One OC-mailbox transaction; every request, reads included, is a write to one processor register. Never "op" in labels. | `registers.md` |
| **Undervolt Protection** | UVP | A BIOS setting; while on, the processor refuses negative offsets (completion code `0x13`). | `registers.md` |
| **accepted state** | | The known-good state recorded after a long clean test. Never "golden" or "baseline" for this. | `tuning-results.md` |
| **profile** | | A saved complete state: Save, Load into Tune, Review, Delete. Never "preset". | `docs/guide/09-profiles-and-restore.md` |
| **plan** | | The ordered writes the helper will send. | |
| **edit** / **edits** | | A value you changed that differs from the CPU. Never "pending change" or "draft change". | |
| **quick screen** | | A short stress run that catches bad settings. Never bare "test". | `tuning-results.md` §1 |
| **gate** | | The long acceptance test a setting must pass before it is accepted. Never "validation". | `tuning-results.md` §2 |
| **cold boot** | | Power off, then on: the processor starts again from its BIOS settings. | `platform-arl-s.md` §7 |
| **warm restart** | | Reboot without power loss: some mailbox state (offsets, E ratio words) survives. | `platform-arl-s.md` §7 |
| **Now** / **After** / **Δ** | | V/F table columns: the CPU now (predicted from the read), with edits, and the difference. Never "Read-back V" or "Predicted V". | |

## Actions
| App term | Meaning | Never |
|---|---|---|
| **Read** | Fetch the CPU's tuning state (V/F words, ratios, tables, limits); one global action in the top bar. | Re-read, Refresh, Tune > Read |
| **Discard** | Drop edits; local, no CPU access. | Revert, Undo |
| **Review** | Ask the helper for a plan; opens the commit sheet. | Review & Apply, Preview |
| **Apply** | Send the plan's writes. | Commit, Write, Save |
| **Restore accepted** | Plan the writes back to the accepted state. | Revert to accepted |
| **Restore boot values** | Plan the runtime values back to the boot journal. | Revert to boot values |
| **Accept** | Mark the current applied state as the accepted state. | |
| **Measure** (Curves) | Record a V/F curve under load. | Read ratios & voltages |

## Screens
| App term | Meaning | Never |
|---|---|---|
| **Overview** | The first screen. | Dashboard |

## Wording differences between the two app sources (listed, not edited)
Found by comparing `desktop/app/ui/lib/tips.js` (Glossary section) with `desktop/DESIGN.md` §7 on 2026-11-12; the owners of those files decide.
1. **Power limits:** `tips.js` has a bare "PL1, PL2, tau" row and a separate "PL4" row ("Shown, never changed"); DESIGN §7 names them "Long-term limit PL1",
   "Short-term limit PL2", "Time window tau", "Peak limit PL4". If a PL4 control is ever added, the tips sentence becomes stale.
2. **Ring alias:** `tips.js` gives "uncore" as the expert word for "Ring"; DESIGN §7 uses "uncore" only inside "ring clock range" and forbids "Uncore (ring) ratio".
   NGU and D2D are also uncore fabric clocks (`platform-arl-s.md` §11), so "uncore" for the ring alone is ambiguous.
3. **Quick screen / gate:** `tips.js` defines both in one row ("Quick screen, gate"); DESIGN §7 lists them as two terms.
4. **Accepted state:** `tips.js` says it is "recorded after a long clean test"; DESIGN §7 defines Accept as marking the current applied state, with no test condition.
5. **E-cluster:** `tips.js` states "one ratio and one voltage curve" as fact; the hardware facts are one ratio measured, one voltage per cluster community-sourced, and
   whether one core's write moves its cluster open (`platform-arl-s.md` §2).
6. **Terms only in `tips.js`:** Ratio, Core voltage (Vcore, VccIA), Undervolt Protection, Favored core, Mailbox (as "OC mailbox"). **Terms only in DESIGN §7:**
   Read, edit, Discard, Review, plan, Apply, Restore accepted / boot values, unit, ratio cap, max ratio, Runs up to, Now / After / Δ, ring clock range, Measure,
   warm restart, bucket, busy cores, Overview. Neither list is a conflict; the Tips glossary does not cover the action words.
