# Throttling indicators — registers, XTU-style mapping, read strategy, event log `host lnx`

Status: research draft 2026-10-18; sections A-F predate the live reads. **§G (2026-11-11) supersedes §B's "Current / EDP = IccMax" framing:** on this chip 0x64F bit 8 is the PL4 predicted-peak clamp [MEASURED lnx 2026-11-11], the chip label is "Current / PL4 (electrical)" (G-244), and 0x64F, 0x6B0 and 0x6B1 are now read live (tagged MEASURED where they were).

**Headline: the dashboard hex is the wrong register.** `desktop/app/ui/store.js:87-96` (`limitBadges`) reads `limit_reasons_raw`, which is the raw
**0x6B0 graphics** word (`src/linux_xtu/telemetry/sampler.py:101`, `telemetry/cpu.py:141-146`). It is rendered as hex by
`desktop/app/ui/views/dashboard.js:48-61` (tile) and `desktop/app/ui/components/monitor-strip.js:11-14,63-70` (strip badge). Live 0x6B0 is `0x01000000`
(sticky "Other" log, iGPU) `[MEASURED lnx 2026-10-18, telemetry-sources.md]`, so the tile shows a permanent amber `0x1000000` that says nothing about the cores.
The decoded **core** word (`limit_reasons` = 0x64F, `sampler.py:99`, `{raw,status,log,unknown_bits}`) is already in every snapshot and the UI ignores it.

## A. Registers

| MSR | Scope | Bits for throttle reporting (status RO / log sticky) | Who clears the log | On ARL-S | Linux exposure |
|---|---|---|---|---|---|
| 0x19C IA32_THERM_STATUS | per logical CPU `[DOC edk2 ArchitecturalMsr.h]`; P vs E-cluster sharing `[UNVERIFIED]` | 0/1 thermal status/log · 2/3 PROCHOT#/FORCEPR event/log · 4/5 critical temp · 6–9 thresholds 1/2 · **10/11 power-limit** (CPUID.06H:EAX[4] PLN) · **12/13 current-limit**, 14/15 cross-domain (CPUID.06H:EAX[7] HWP) · 22:16 readout · 31 valid `[DOC edk2 ArchitecturalMsr.h]` | log bits R/WC0 (write 0 = WRMSR). **Kernel owns them**: interrupt clear mask core = 1,3,5 (+7,9 TM2, +11 PLN, +13,15 HWP); `throttle_active_work` clears BIT(1) every 1 s while an event lasts `[DOC therm_throt.c]` | flags `pln pts hwp hwp_notify hfi dtherm tm2` present `[MEASURED lnx 2026-10-18 /proc/cpuinfo]` → bits 10–15 implemented | `thermal_throttle/core_throttle_{count,max_time_ms,total_time_ms}` |
| 0x1B1 IA32_PACKAGE_THERM_STATUS | package | 0/1 thermal · 2/3 PROCHOT · 4/5 critical · 6–9 thresholds · **10/11 power-limit** · 22:16 readout `[DOC edk2]` · **13 "PMAX log"** — IPF primitives `GET/SET_THERM_STATUS_PMAX_LOG` `[DECOMPILED ipf-primitives.tsv:303-304]`, not architectural, ARL `[UNVERIFIED]` · 26 HFI update (kernel-handled) `[DOC therm_throt.c / msr-index.h]` | kernel pkg mask 1,3,5,7,9,11 (+26 HFI, +25 DPTI) `[DOC therm_throt.c]`; XTU writes 1/3/13 `[DECOMPILED ipf-primitives.tsv:299-304]` | PTS present `[MEASURED cpuinfo]` | `package_throttle_{count,max_time_ms,total_time_ms}` |
| 0x64F CORE (IA) PERF_LIMIT_REASONS | package (same word on P and E CPUs `[MEASURED lnx 2026-10-13]`; bit table identical to the SDM Meteor Lake table 2-53 `[DOC SDM 335592-093]`) | status 15:0, log = status+16: 0 PROCHOT · 1 Thermal · 4 Residency-state regulation · 5 RATL · 6 VR therm alert · 7 VR TDC · 8 Other (electrical) · 10 PL1 · 11 PL2/PL3 · 12 Max turbo (multi-core) · 13 Turbo transition attenuation `[DOC edk2 SkylakeMsr.h]` | log "remains set until cleared by software writing 0" `[DOC edk2 SkylakeMsr.h]`. **Linux never touches it** (turbostat read-only; not in therm_throt.c). **XTU can clear it** (`SET_IA_CLIP_REASONS` 0x445 → 0x64F [29:0]) `[DECOMPILED ipf-primitives.tsv:355; win-xtu-decompile-mailbox.md:211]` | live; ARL semantics `[UNVERIFIED]` (only Skylake+ table exists) | none (turbostat: ARL maps to `adl_features` (`{ INTEL_ARROWLAKE, &adl_features }`), which has no `plr_msrs` → prints nothing for 0x64F `[DOC turbostat.c]`; where turbostat does print limit reasons it reads 0x690 with Haswell labels; it does print "PKG Limit #4" from `0x601 & 0x1FFF` on ARL-S) |
| 0x6B0 GRAPHICS PERF_LIMIT_REASONS | package (iGPU) | 0,1,5,6,7,8,10,11 as 0x64F; 12 inefficient operation `[DOC edk2]` | XTU clears (`SET_GT_CLIP_REASONS` 0x446) `[DECOMPILED ipf-primitives.tsv:356]` | live `0x01000000` | none |
| 0x6B1 RING PERF_LIMIT_REASONS | package (ring) | 0,1,5,6,7,8,10,11 (no 4/12/13) `[DOC edk2 SkylakeMsr.h]` | software write 0 | in XTU's MSR allowlist as RO `[DECOMPILED win-xtu-native-provider.md:101]`; read-only in `TELEMETRY_MSRS` since G-229, ARL value `[UNVERIFIED]` | none |
| 0x690 | — | Haswell-era core word | — | **EIO** `[MEASURED lnx 2026-09-29]` — never read | turbostat's core bit names (Amps@8, Auto-HWP@5, CorePwr@9) are this layout `[DOC turbostat.c]` — do not apply to 0x64F |

Kernel facts `[DOC https://raw.githubusercontent.com/torvalds/linux/master/drivers/thermal/intel/therm_throt.c]`:
- `core_throttle_count` counts **0x19C bit 0** (kernel `THERM_STATUS_PROCHOT` = BIT(0) is the SDM *Thermal status*, not the PROCHOT# pin; its `THERM_STATUS_PROCHOT_LOG` = BIT(1) is the *thermal log*). Package likewise from 0x1B1 bit 0. Durations come from interrupt→poll end.
- Power-limit counters (`core/package_power_limit_count`) exist only with boot option `int_pln_enable` (default off): absent here — `cpu0/thermal_throttle/` has the 6 throttle files only, all `0` `[MEASURED lnx 2026-10-18 sysfs]`.
- So sysfs covers **thermal only**, root-free, with count/max/total time.

## B. Mapping to XTU's indicators

The decompiled XTU UI code that maps its labels to bits was **not found** in the decompile notes (only the IPF paths: `Diagnostics.ClipReasons` = 0x64F [29:0], `Graphics…ClipReasons` = 0x6B0,
`Thermal.Status.Diagnostics.ProchotLog/PmaxLog/ThermalMonitorLog` = 0x1B1 bits 3/13/1, all read **and cleared** `[DECOMPILED win-xtu-decompile-mailbox.md:211, ipf-primitives.tsv]`).
XTU reads the log bits and has a clear path for them; whether it clears on every poll ("since my last poll") is `[UNVERIFIED]`. The mapping below is therefore **inference** from: Intel's definition of Current/EDP =
IccMax / VR current limit, Power = PL1/PL2 `[DOC https://www.intel.com/content/www/us/en/support/articles/000039154.html]`; ThrottleStop's "EDP OTHER" label
`[COMMUNITY https://techpowerup.com/forums/goto/post?id=5192378]`, whose bit (8, by SDM "Other (electrical)" + Haswell "EDP" history, registers.md) was `[UNVERIFIED]` — superseded by §G (bit 8 = PL4 clamp on this chip); siomon's working three labels from 0x19C (`thermal` = bits 0|2|4, `power` = 10, `current` = 12)
`[CODE siomon src/sensors/intel_msr.rs:125-150; src/output/tui/cpu_view.rs:174-176]`.

| GUI indicator (group) | Primary (package, 1 read) | Corroborating | Meaning / note |
|---|---|---|---|
| **Power limit** | 0x64F bit 10 PL1, bit 11 PL2 | 0x19C bit 10 (per core), 0x1B1 bit 10 | sub-labels "PL1 (long)", "PL2 (short)". PL4/Pmax: 0x1B1 bit 13 log only `[UNVERIFIED]` — show as "Pmax (unverified)" |
| **Current / PL4** (was "Current / EDP") | 0x64F bit 8 Other (electrical), bit 7 VR TDC | 0x19C bit 12 current-limit (per core) | Bit 8 is "electrical **or other**" in the SDM. On this 285K bit 8 = PL4 (0x601) binding on AVX2 all-core loads with IccMax unlimited [MEASURED lnx 2026-11-11, §G]; the chip label is "Current / PL4 (electrical)" (G-244 relabel); no public source defines the bit, so this is a measured correlation (open: PL4-only or also IccMax?) |
| **Thermal** | 0x64F bit 1 Thermal, bit 0 PROCHOT, bit 5 RATL | 0x19C bits 0/2/4, 0x1B1 bits 0/2/4; kernel counters | sub-labels "TjMax/TCC", "PROCHOT# (external)", "running-average thermal" |
| VR thermal (motherboard) | 0x64F bit 6 VR therm alert | — | separate chip; board VRM hot |
| Max turbo (informational) | 0x64F bit 12 | — | multi-core turbo-ratio table is the cap — **normal under load**, grey not amber |
| Turbo attenuation / residency (info) | 0x64F bits 13 / 4 | — | grey, in the detail popover only |
| Ring / iGPU | 0x6B1 / 0x6B0 | — | detail popover only; never the headline tile |
| Unknown | `unknown_bits` (e.g. 14/15; CoreFreq claims 14 = TVB `[COMMUNITY]`) | — | shown by number, never named |

Recommended GUI (superseded in the chip label by G-244: "Current / PL4"): one tile "Throttling" with three XTU chips **Power · Current/EDP · Thermal** (Yes = red/amber, No = green), a fourth chip "VR thermal",
a grey "Max-turbo cap" chip, and a popover listing every active status bit with its SDM name and the word it came from. Replace `limit_reasons_raw` with
`limit_reasons` (0x64F) in `store.js`; keep 0x6B0 in the popover only.

## C. Read strategy without writes

| Source | Semantics | Usable for | Problem |
|---|---|---|---|
| 0x64F status bits 15:0 | instantaneous | point-in-time Yes/No | a 1 s poll misses a PL2/EDP burst between samples |
| 0x64F log bits 31:16 | sticky since boot (Linux) / since XTU's last clear (dual boot) | "ever since boot" only | one 0→1 transition per boot; without clearing they carry no timing |
| 0x19C / 0x1B1 log bits | kernel-cleared | nothing | the kernel clears them (A); reading them races the kernel, writing them fights it |
| `thermal_throttle/*` sysfs | count + max/total ms, kernel-maintained | thermal events with durations, no root | thermal only; power counters off (`int_pln_enable`) |

**Recommendation: never write any of these registers.** Status bits are the point-in-time truth. To get XTU's "it happened" feel without a log-bit clear:
1. **Oversample 0x64F only** (one rdmsr on CPU 0) at ~10 Hz in the sampler thread and publish, per 1 s tick, the **fraction of samples** each status bit was set
   (`power: 0.3` = throttled ~30 % of the last second) plus `any` = OR over the window. Short bursts become visible; no WRMSR.
2. A **software "reset indicators"** button clears the app's own OR-accumulator (and the event-log view) — not the hardware.
3. Hardware log bits are shown as "since boot" in the popover, with "may have been cleared by Windows XTU" when the boot followed a Windows session.
4. Diff the kernel thermal counters each tick as an independent thermal witness.
The task's alternative (an explicit operator "clear hardware log" action) is not needed; if ever wanted it is a WRMSR of 0x64F/0x6B0/0x6B1 → its own
decision (D-NNN), audit entry, write-sitting rules (AGENTS.md), never 0x19C/0x1B1 (kernel-owned).

## D. Read path in this project

| Set | File | Has 0x19C | 0x1B1 | 0x64F | 0x6B0 | 0x6B1 |
|---|---|---|---|---|---|---|
| `TELEMETRY_MSRS` (what the helper's sampler uses: `helper/main.py:209` → `Sampler(TelemetryMsr(port))`) | `telemetry/msrio.py` | yes | yes | yes | yes | **yes since G-229** (and **0x601 PL4 since G-244**, read-only, sampler key `pl4`) |
| `PLAIN_MSR_READABLE` (guard path for ops, not telemetry) | `guard/policy.py:176` | no | no | no | no | no |

- Nothing must go into `PLAIN_MSR_READABLE` for this feature. (When written, only **0x6B1** was missing from `TELEMETRY_MSRS`; it was added by orchestrator decision G-229 / D-026, and 0x601 by G-244; both are in `telemetry-sources.md`.) Doc conflict to fix: `msrio.py:8-10` says the set is mirrored into `PLAIN_MSR_READABLE` at merge;
  `registers.md:129-130` says separate/unchanged — the code agrees with registers.md.
- Today per 1 s tick: 3 rdmsr × 24 CPUs (APERF, MPERF, 0x198) = 72, plus 0x1A2, 0x64F, 0x6B0 ×2 (decoded + raw). Switch the UI to `limit_reasons` now (the bug); retire the `limit_reasons_raw` key and its read at the
  release boundary already declared (telemetry-sources.md, `cpu.py:142`).
  Each `/dev/cpu/N/msr` read is an IPI that wakes CPU N `[CODE siomon src/sensors/intel_msr.rs:16-22]`.
- Proposed: 0x64F at 10 Hz on CPU 0 (+9 reads/s, CPU 0 is awake anyway), 0x1B1 once per tick (power bit 10, package thermal), 0x19C per CPU once per tick only
  when the detail view is open (+24 IPIs/s; gives *which* core was power/current/thermal limited). 0x6B1 once per tick if adopted.

## E. Throttle event log

| Field | Source |
|---|---|
| `t_on`, `t_off` (wall + monotonic), `dur_ms` | sampler tick where the group's window-OR flipped |
| `group` (power / current / thermal / vr_thermal / max_turbo) and `bits` (SDM keys from `limits.CORE_64F`) | 0x64F status |
| `duty` (mean fraction while on) | the 10 Hz oversampling |
| `peak_temp_c`, `peak_pkg_w`, `peak_mhz`, `cpus` (if 0x19C detail on) | same snapshots during the event |
| `kernel_thermal_delta` | diff of `thermal_throttle/*_count` |
| `tuning_id` | accepted/applied state at onset (ties a throttle to an undervolt) |

- Debounce: open on first window with the bit, close after 2 consecutive clean windows; max-turbo events are logged at "info" or not at all (they fire on every load).
- Storage: a sibling JSONL next to the audit log — `$XDG_STATE_HOME/linux-xtu/throttle.jsonl` (dev, D-041) / `/var/lib/linux-xtu/throttle.jsonl` (installed, D-030) —
  not the audit log itself (audit = writes). Size-capped rotation. The GUI shows the last N events and a per-group "time throttled this session" counter.

## F. Open questions — exact live reads (orchestrator; all plain rdmsr, no mailbox)

| # | Read | Expect | Settles |
|---|---|---|---|
| 1 | 0x19C on CPUs 16–19 (one E cluster) and 0, 2 (P) at idle, then under E-only load | bits 31 = 1; readout 22:16 differs per CPU if per-core | per-core vs per-cluster scope on Skymont |
| 2 | 0x64F on CPU 0 under all-core load with PL1 capped below draw (powercap) | status bit 10 = 1 (`0x…0400`) and bit 12 | PL1 bit live on ARL |
| 3 | 0x19C bits 10/12 on a loaded P CPU in the same run | bit 10 = 1 with #2 | per-core power bit matches 0x64F |
| 4 | 0x1B1 on CPU 0, idle and loaded | bits 12–15 = 0 at idle; bit 13 behaviour unknown | XTU's "PMAX" bit exists on ARL |
| 5 | 0x6B1 on CPU 0 (after allowlisting) | `0x0000xxxx` with 0x64F-like log bits | ring word live |
| 6 | Same boot: read 0x64F and `cpu*/thermal_throttle/core_throttle_count` after a thermal event (the bit-17 log and the 0-counter seen so far are from **different boots**) | if bit 17 sets while the counter stays 0 → | what fires 0x64F "Thermal" without a TM1 event (TCC offset? RATL?) |
| 7 | 0x64F at 10 Hz for 60 s under a bursty load | bits 8/11 toggle within a second | oversampling is worth it |

## G. AVX2 all-core clamp = PL4 (MSR 0x601) — 0x64F bit 8 explained [MEASURED lnx 2026-11-11]

Data: `captures/lnx/avx2-clamp-20261111/` (`medium-probes/sample.py` = the read-only 10 Hz 0x64F / 2 Hz 0x19C+0x198 sampler; the raw scripts that wrote
0x601 or read the mailbox directly bypassed the guard and were removed, D-053). State: accepted good-p57-e47 restored at boot, BIOS ring 42x / 7200, PL1 270 / PL2 295 W, IA/SA/GT CEP disabled, BIOS IccMax 511 A +
"unlimited", BIOS "Unlock VR Limit" default (disabled).

**Symptom.** `stress-ng --vecwide 24` (25 % of retired instructions are 256-bit integer AVX2: `int_vec_retired.256bit`) under tuned `balanced`
runs P 48x / E 46x flat (218 W, 69 C) while scalar loads hold 55x / 47x (`--cpu int64` 160 W; x87 `--cpu matrixprod` 266 W, no limit bit).
0x64F bit 8 ("Other (electrical)") and 0x19C bit 12 (current limit) on all 24 CPUs are set 100 % of samples; PL1/PL2 (bits 10/11), VR TDC (bit 7),
thermal bits never set. P-only (8 threads) or E-only (16) vecwide: no limit, full ratios. Only both clusters together trip it.

**Root cause = PL4 in MSR 0x601 (425 W), enforced against a predicted peak, not measured draw.** With the HWP floor at 100 %:

| 0x601 PL4 | P | E | pkg W |
|---|---|---|---|
| 425 (BIOS) | 54x | 47x | 266 |
| 300 | 47x | 44x | 170 |
| 250 | 45x | 41x | 148 |

Real draw sits ~40 % below the limit and scales with it, so the PCU compares its worst-case estimate for the instruction class (AVX2-256 >> scalar)
with PL4. 0x601 is unlocked (bit 31 = 0) and writable at runtime; original `0xd48` restored after the test. The powercap MMIO copy
(`intel-rapl-mmio:0` constraint_2 `peak_power`, MCHBAR 0x59B0) is **not enforced**: lowering it to 325 W changed nothing and 0x601 stayed 425
(the MMIO zone is disabled, platform.md). This resolves C-2 (mailbox-recon-summary.md): PL4 lives in MSR 0x601.

**0x601 unit is watts, not amps** (earlier docs said "425 A design current" — wrong, from the earlier research note `lnx-turbostat-plus-facts.md:21`):
XTU/IPF accesses `0x601 [14:0]` as `GET_RAPL_POWER_LIMIT` / `SET_RAPL_POWER_LIMIT_SUR` [DECOMPILED `ipf-primitives.tsv:37,407`]; ThrottleStop
writes it as PL4 [DECOMPILED `win-throttlestop-fivr.md:119`]; SkatterBencher's 285K defaults list PL4 425 W next to IccMax 347 A [COMMUNITY
`skatterbencher-285k.md:36`]; the kernel's MMIO copy reports `peak_power` 425 W. Unit = 0x606 power unit (0.125 W): `0xd48` = 3400 x 0.125 = 425 W.

**Not the cause (measured the same day):** IccMax mailbox `0x16` P1=0 = `0x80000000` (bit 31 unlimited; P1=8 rc 0x6) — the BIOS 511 A / unlimited
setting does reach the CPU; `0x04` = `0x84002000` ([11:8] = 0 is the working VR address, ThrottleStop's 5-bit field 2 = 8 is not — evidence for C-1);
AVX2 ratio offset `0x1A` = 0; `0x18` = `0x1E` (TVB disabled, so TVB does not explain heavy-load P dips either).

**HWP floor decides how far below the PL4 ceiling the PCU drops** (EPP and EPB alone change nothing):

| tuned / knob | HWP min P/E | P | E | pkg W | vecwide bogo-ops/s |
|---|---|---|---|---|---|
| balanced (min_perf_pct 14, EPP 64, EPB 6) | 13 / 12 | 48x | 46x | 219 | 1.913 M |
| balanced + EPP 0, or + EPB 0 | 13 / 12 | 48x | 46x | 220 | 1.914 M |
| min_perf_pct 80 | 74 / 53 | 48x | 46x | 220 | 1.913 M |
| min_perf_pct 90 | 83 / 60 | 50-51x | 46x | 237 | 1.950 M |
| min_perf_pct 95 | 88 / 63 | 52x (some 54-55x) | 46x | 262 | 1.991 M |
| min_perf_pct 100 = throughput-performance = hpc-compute-zram | 92 / 66 | 54x | 47x | 266 | 2.033-2.035 M |

When PL4 binds, the PCU prefers the low-voltage points P 48x (V/F point 4, VID 1.047 V vs 1.271 V at 55x) / E 46x (fused top below the 47x OC point)
unless the HWP floor holds it higher; the PL4 ceiling itself costs one P bin (55 -> 54x) at 425 W. Efficiency: 8.7 k ops/s/W at 48/46x vs 7.6 k at
54/47x. GUI mapping consequence: 0x64F bit 8 on this platform means "PL4 / predicted-peak (electrical)", not IccMax; label it "Current / PL4 (electrical)".

**Confirmed by raising PL4** (0x601 -> 500 W, tuned `balanced`, HWP floor 14 %, 30 s vecwide 24; `raise_500.*`, `pl4raise.sh`): **bit 8 and
0x19C bit 12 never set**, only bit 12 max-turbo. P 5393 MHz avg (55x 60 %, 54x 6 %, 52x 34 % of samples), E 47x flat, 282-286 W, 80-82 C,
2.037 M bogo-ops/s (= the hpc-compute-zram result at 425 W, +6.5 % over balanced at 425 W), 0 stress-ng failures, MCE 0; `0xd48` restored.
Per P-core averages 5274-5500 MHz with no limit bit at all — the same pattern as the matrixprod heavy run; its cause is open (TVB is disabled).

**Fix options (not applied permanently):** raise PL4 (0x601 at runtime — unlocked, resets at boot — or a BIOS PL4 field; whether ASRock's
"Unlock VR Limit" moves 0x601 is [UNVERIFIED] — read 0x601 after toggling it), or keep a high HWP floor (hpc-compute-zram already does) for AVX2
all-core work at 425 W.

**Profile with PL4 out of the way** (0x601 500 W, 30 s vecwide 24): throughput-performance = balanced (P 5385 vs 5393 MHz avg, both 282-286 W, 2.035 vs
2.037 M ops/s) — once PL4 does not bind, the HWP floor no longer matters. Idle cost of throughput-performance vs balanced: 14.9 vs 12.3 W package
(C6/C7 residency unchanged). **Adopted: throughput-performance is the daily profile (D-052).**
