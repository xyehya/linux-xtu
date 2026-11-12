# Tuning results: stability lessons and what the hardware did on write

General findings from tuning and write sittings on one Core Ultra 9 285K (Linux and Windows, 2026-10). The rules are stated generally; the reference
chip's offsets, words and voltages are in `examples/reference-285k/notes/tuning-history.md` (one sample, not a spec). Hardware rules derived from these
sittings are collected in `platform-arl-s.md` §3, §8.

## 1. Unstable undervolts fail silently
Every failure seen was OCCT "CPU error detected" = a wrong result, with **no WHEA event, no MCE, no system error** [MEASURED win 2026-10-04, lnx
2026-10-02]. A clean kernel/Event log is not evidence of stability. OCCT does not name the failing core (it reported "core 0" for an error caused by
an E-core offset), so bisect by reverting groups of offsets, one variable at a time.

## 2. The gate and what weaker gates missed
- The project's acceptance gate (D-019): OCCT Linpack 2021 (all threads, 2048 MB) 60 min + OCCT CPU SSE variable 60 min, OCCT unprivileged, no other
  mailbox client during apply, WHEA/MCE watched.
- OCCT SSE 10-15 min, CPU+RAM 20 min, clock cycler, per-core `stress-ng --verify` sweeps and 1-thread tests all passed states that Linpack 2021 later
  failed [MEASURED win 2026-10-04]. Short screens must be labelled as screens.
- Time-to-error is noisy (the same offsets failed after 50 min at one LLC level and ~2 min at another): trust only a full pass, never how long a fail
  took [MEASURED win 2026-10-04].

## 3. Tuning lessons
1. The heaviest all-core loads run between points, power-limited (the 48x-53x blend on the 285K), so the lower points matter for all-core stability,
   heat and clocks; the top points matter for light loads and set VccIA there (`platform-arl-s.md` §5).
2. Lowering the highest allowed VID points lowers VccIA package-wide; lowering a unit that does not set the maximum does not.
3. Setting the top points by target voltage (offset = target - measured stock VID) instead of a uniform offset gave margin back where it was needed;
   the cores with the worst fused VID had the most room (`favored-cores.md` §3).
4. The monotonic clamp can silently absorb an offset: check the re-measured voltage, not only the read-back word.
5. Judge a change by Vcore, power and temperature at a fixed (capped) load, not by all-core MHz, which the BIOS power/thermal limits set.

## 4. Measuring the stock curve
- A stock measured curve (offsets 0, cpufreq cap + pinned load + VID from `0x198`) reproduces the fused top point from cmd `0x09` within a few mV
  [MEASURED lnx 2026-10-11]; method and pitfalls in `power-profile-capping.md`.
- No unit was non-monotonic (no ratio's VID below the previous by > 3 mV); a ratio without a point sits at the interpolation of its neighbours
  [MEASURED lnx 2026-10-11].
- A favored core's top ratio settles only intermittently under a single pinned load (other active cores pull it to the next bucket); a retry pass helps.
- E-cores: VID is flat at a floor up to ~30x; ratios above the top E point run on its voltage. An E-core's `cpuinfo_max_freq` shows one bin more than
  its turbo table allows (intel_pstate rounding), so the E maximum comes from `0x650`, not from sysfs [MEASURED lnx 2026-10-11].

## 5. First write sittings: what the hardware did [MEASURED lnx 2026-10-11]
- An E OC ratio above the fused top (48 > 46) added a readable point `P2 = 7`; its adaptive target raised 48x, 47x interpolated, 46x unchanged; a
  target below point 6 was clamped up to point 6.
- `P2 = 0` offset on a P-core whose OC ratio equals the top fused ratio (no OC point): every point moved by the offset (whole-curve offset); the written
  V target was dropped from the read-back word.
- A per-point offset moved that point's VID as predicted, and the ratio between it and the next point by half.
- An OC ratio could not be written back to 0 (clears on reboot). Restoring the accepted state read back word for word.

## 6. Offset-only OC words [MEASURED lnx 2026-10-12]
- A whole-curve offset is additive to the per-point offsets.
- On a cold E word, an offset-only `0x11` (no `0x1D`/`0x27`) moved the whole cluster curve and added no OC point.
- **Target retention without an OC point is not reliable**: the same word kept its target in one apply and not in another. Rule adopted (G-124,
  D-035): a no-OC-point OC word is always written with V target 0.

## 7. Turbo-table writes and E OC 49× [MEASURED lnx 2026-10-12]
- Lowering the all-core bucket of `0x1AD` / `0x650` by one bin made a 30 s all-core load run one bin lower on P and E; restoring the words restored
  the ratios.
- E OC 49x worked with `0x11` + `0x1D` + `0x650` on the cluster; between the top fused point and the OC point the voltage is linear. HWP highest and
  `cpuinfo_max_freq` rose with `0x1D`, `scaling_max_freq` did not (uncapped load stayed at 48x until it was raised; the app raises and lowers it with the
  ratio since G-126).

## 2026-10-19 — compile stress (15 uncached llama.cpp builds, -j24, 6400 MT/s 36-38-38-80) [MEASURED lnx]
P state for all three runs: accepted P offsets + 53x <= 1.200 V (P2 -71, P5 -61, P7 -71) + 55x 1.270 V group (P2 -96, P4 -49, P5 -88, P6 -76, P7 -106),
P turbo 55x8 (`captures/lnx/profiles/p53-1200-p55-1270-*.toml`). Only the E state changed:
| TAG | E state | result |
|---|---|---|
| uv-p53p55 | 48x with no OC point (BIOS 0x1C 48 > fused 46: ran at the 46x voltage, EC0 1.157 V) | ICE in build 4 on cpu 8 (EC0), GCC 15 .cu |
| uv-p53p55-eacc | accepted: OC 48x EC0 1.123 / EC1-3 1.112 V, 46x -50/-40 mV | ICE in build 2 on cpu 13 (EC1), GCC 15 .cu |
| uv-p53p55-e46 | E turbo 46x8, point 6 offset 0 (stock 46x: EC0 1.1575 / EC1-3 1.1375 V) | **15/15, 0 ICE**, 111-114 s, MCE 0, btrfs clean, 0 SIGSEGV |
Reading: the P undervolt above passes this test; E at 48x failed at both voltages tried (two events, both GCC 15 at version.h:1). E 48x needs more voltage
than the accepted 1.11-1.12 V, or 48x is not worth it. Under load P ran 55x ~37% / 54x ~56%, rail 1.271 V, package ~245 W.

## 2026-10-19 22:2x — favored cores 56x -15 / 57x -75 mV (profile p53p55-fav5675, P turbo 57/57/55x6) [MEASURED lnx]
Hardware monotonic rule confirmed: with 56x at -15 mV the 57x point (-75 mV requested, word verified 0xF6600039) runs at the 56x voltage —
P0 57x VID 1.371 V (= 56x), P3 57x 1.344 V (= 56x); effective 57x undervolt ~-55 / ~-51 mV. stress-ng P0+P3 together, 120 s each, cpufreq cap 56x then
57x: both pass, MCE 0, 47-49 W, max 59 C, only turbo-table bit (0x1000) seen. Before the apply the BIOS-booted P3 held 56x -28.3 / 57x -31.3 mV
(BIOS per-core V/F setting, re-applied each boot). `captures/lnx/fav-cap-runs-*.txt`, `stress-fav-cap5[67]-*.txt`.

## 2026-10-19 23:xx — E-cluster search (3 all-core compile builds per step, auto-stop at first ICE; P = p53p55-fav5675, PL2 295 W) [MEASURED lnx]
| step | E state under load | result |
|---|---|---|
| 46x pt6 -40..-140 mV | 46x, EC0 1.118..1.018 / EC1-3 1.098..0.998 V | all 3/3 |
| 46x pt6 -150 / -160 mV | EC1-3 0.988 / 0.978 V | ICE cpu 21 (EC3), builds 3 / 1 |
| 49x OC 1.210 / 1.240 / 1.255 V (pt6 -120) | 49x at target | ICE cpu 23 / 23 / 21 (EC3) |
| 49x OC 1.270 V | 49x 1.270 V | 3/3 |
| 50x OC 1.300 V | **not 50x**: all-core load -> E 49x ~1.23 V (interpolated), P 48x | 3/3 but not a 50x result |
Every E failure was on EC3 (cpus 20-23): the weakest cluster sets the requirement. 46x edge -140 mV (working -120); 49x edge 1.270 V.
**All-core current limit:** with E at 50x (OC 1.285-1.300 V) a 24-core load sets 0x64F bit 8 ("Other (electrical)", Current/EDP group) + bit 12 at
~215 W (< PL2 295): E falls to 49x, P to 48x. E-only load runs 50x at 1.287 V with no limit bit. At E 49x 1.270 V, stress-ng 24 threads keeps E at 49x
but P drops to 46-54x (0x1100) — higher E voltage spends the shared current budget P would use. 50x all-core needs a higher IA current limit (IccMax,
BIOS or mailbox 0x16/0x17, not allowlisted) [inference: bit 8 = IccMax/EDP is UNVERIFIED on ARL]. **Superseded 2026-11-11: the bit-8 clamp was PL4
(MSR 0x601), not IccMax** (`throttling.md` §G; IccMax was 511 A + unlimited and bit 8 never set once PL4 was raised); read the paragraph above as "a PL4 /
predicted-peak clamp".
- 2026-10-20 03:12: E 48x OC 1.175 V (pt6 -120), P state B, PL1 250 / PL2 295 / tau 112 s: 10-build run 9/10 — ICE in build 10 on cpu 23 (EC3), GCC 15
  version.h:1. A 3-build screen at the edge is not enough; 1.185 V (20 mV above the 1.165 V failure) is the 48x working value, unconfirmed at 10/15 builds.
  During the run: E 48x 100 %, P 54x ~85 % / 55x ~7 %, package ~231 W avg (243 max), 0x64F bit 8 intermittent.
- 2026-10-20 03:39: E 46x pt6 -120 (P state B, PL1 250/PL2 295): 12/15, ICE build 13 cpu 21 (EC3). Long runs move the edge; next -100 x15.
- 2026-10-20 04:08: E 46x pt6 -100 (P state B, PL1 250/PL2 295/tau 112 s): **15/15**, 111-114 s, MCE 0, 0 SIGSEGV. Known-good = -100 (good-p53p55-fav-e46m100.toml).
- 2026-10-20 06:29: E 47x OC 1.077 V all clusters (+P0 58x OC 1426 mV, turbo P 58,58,55x6 E 47x8): 10/10. 1.057/1.037 failed b4 of 10, 1.077/1.057 failed b3 (EC3).
- 2026-10-20 07:14: E 47x 1.077 V uniform under tuned hpc-compute-zram, llama.cpp b11748: ICE build 2 on cpu 8 (EC0), mmq-instance TU, MCE 0 — first traced EC0 failure; EC0 needs its +20 mV (fused V 20 mV above EC1-3). Back to e47-2 (EC0 1.097 / EC1-3 1.077).
- 2026-10-20 07:49: e47-2 (EC0 1.097 / EC1-3 1.077) 10/10 under hpc-compute-zram on b11748 (107-109 s, MCE 0). Accepted as good-p58-e47-2. hpc-compute-zram: HWP min=max, cpu_dma_latency 1 us -> ~257 W / 86 C during builds vs ~220-240 W / 60-66 C balanced [MEASURED lnx 2026-10-20].

## 2026-10-24 — corrected MCEs on CPU0 under P0 58x; OC dropped (D-051) [MEASURED lnx 2026-10-24]
- Boot 2026-10-22 12:36 → 2026-10-24 14:00 ran good-p58-e47-2 (P0 OC 58x @ 1426 mV): **23** corrected "Machine check events logged", first 46 min after the
  apply (13:22), incl. `CPU0 BANK0 CMCI storm detected` (06:23, subsided 06:24). Bank 0 on a P core = L1 data cache. No mcelog/rasdaemon then, so no
  status/address; ABRT reported each as a "kernel oops" and deleted it. Every other boot that week: 0 MCE — including a 24 h boot on the same profile (Oct 21-22).
- The machine's abrupt reboots that week are NOT this: they were external power events (all 7 since Oct 11 hit within 2.2 min of the hour); no panic, no
  kdump vmcore, no boot-time MCE.
- Operator dropped the P0 OC: profile `good-p57-e47` (= good-p58-e47-2 without the P0 OC point, P turbo 57,57,55x6), applied 14:21, all writes read back
  equal, MCE 0; accepted 11:30Z (previous saved as accepted-before-20261024-113040). rasdaemon 0.8.0 installed — a recurrence at 57x now keeps bank/status.
- segv-trace noise: `lscpu` SIGSEGV code=128 is its own VMware-backdoor probe (caught), run by ABRT for each oops — benign.

## 2026-11-09 — BIOS ring 42x adaptive ~1.25 V, P 57/55x fixed in BIOS; health check before stability tests [MEASURED lnx 2026-11-09]
- Operator set in BIOS: ring 42x, adaptive ~1.25-1.265 V; P favored 57x / others 55x fixed (was auto); XMP 7200 (KF560C36-32 x2, 1.35 V, proven earlier).
- Live (plain rdmsr): `0x620` = `0x82a` (ring max 42, min 8); `0x621` = `0x280a002a` -> 42x, UncVID 1.2512 V; ring scales 8..42 dynamically at idle.
  `intel_uncore_frequency` max 4.2 GHz. `0x1AD` 57,57,55x6; cpufreq max cpu0/cpu3 5.7 GHz, others 5.5, E 4.7 GHz.
- Boot restore (`linux-xtu-restore.service` -> `restore-good.sh good-p57-e47`) writes no ring word: OK, 0 writes not equal, MCE 0. Nothing else writes
  the ring (tuned `balanced` has no uncore plugin; no other unit touches 0x620/uncore sysfs).
- Gap: `/etc/linux-xtu/accepted` records ring `oc_word = 0x00000000` (BIOS auto ring). `tools/lnx/restore_tuning.sh` / `tools/win/restore_tuning.ps1`
  will now print "RING NOT RESTORED" and exit non-zero (P/E still restored, the ring never written). Re-accept once 42x is proven stable.
- RAS baseline: 1 corrected MCE in rasdaemon (2026-10-31, L0 instruction-fetch, before this change); 0 this boot.
- Live trained memory (MCHBAR read, `telemetry/mem.py`): 7200 G2 2T, 36-44-44-96, tRC 140, tRFC 574, **tREFI 32767** = the same timings as the 7200 profile
  that gave 3 compile ICEs in 3 builds on 2026-10-19 (incl. one GCC 16; OCCT/Linpack/memtest86+ had passed it). The CPU accepted states were gated at
  6400 (0/15). No compile/stressapptest/y-cruncher run at 7200 since. So ring 42x + this 7200 are two untested variables, not one.
- **Compile gate PASS 15/15** (ring 42x / UncVID 1.2512 + 7200 36-44-44-96 tREFI 32767 + good-p57-e47; tuned throughput-performance; 17:43-18:12,
  112-118 s/build, -j24 uncached, 0 ICE; rasdaemon, kernel log, segv-trace, sio MCE-bank counters all 0; taint unchanged) [MEASURED lnx 2026-11-09].
  `captures/lnx/gate-ring42-x7200-20261109T174322-*` (summary, build log, turbostat, dimm.csv, sio.jsonl 308 samples). Under load (265 samples, pkg >150 W):
  ring 4051-4194 MHz (avg 4154), UncVID 1.235 avg; Vcore (NCT6686 in0) 1.408-1.456 V = same range as the 10-21 Linpack baseline (1.392-1.456), so the
  42x ring request does not raise Vcore; pkg 247 W avg / 280 W max, PECI 83 C max, IA 86 C max, no power/thermal throttle; VCCSA 1.20, VDD_CPU 1.36 V;
  DRAM 53 GB/s avg / 90 GB/s max; DIMMs 43.5 / 47.2 C max (the 10-19 7200 failures were at 51 / 46 C). PL1 now 270 W, PL2 295 W.
  Tools: `~/.local/share/linux-xtu-dev/compile_gate_stopfirst.sh TAG RUNS` (stops at the first ICE / MCE / crash signal / kernel error) +
  `sio_logger.sh` (sio JSONL every 5 s; touches the STOP file on an MCE-bank rise).

## 2026-11-11 — all-core light/medium/heavy clocks; AVX2 clamp root-caused to PL4 [MEASURED lnx]
- 60 s each, 24 threads, tuned balanced, good-p57-e47: int64 P 5499 / E 4701 MHz (162 W, 66 C); vecwide (AVX2-256 int) P 4800 / E 4601 (221 W, 74 C);
  matrixprod (x87) P 5389 avg, 5271 min / E 4701 (264 W, 82 C). 0 stress-ng failures, 0 MCE. `captures/lnx/avx2-clamp-20261111/allcore-3tier/`.
- The vecwide clamp is PL4 (MSR 0x601 = 425 W) on a predicted peak, deepened to 48/46x by a low HWP floor; hpc-compute-zram gets 54/47x.
  PL4 raised to 500 W at runtime: balanced runs vecwide at P 55/54/52x (5393 avg) / E 47x, 284 W, no electrical bit; 0xd48 restored.
  Details, the 0x601 unit correction (W, not A) and the IccMax/AVX-offset/TVB reads: `throttling.md` §G.

## 2026-11-11 — 56x all-core test (non-favored P OC 57x, no OC voltage; P turbo 57,57,56x6): dropped, hard hang [MEASURED lnx]
- Profile `captures/lnx/profiles/test-p57nf-t56.toml` (good-p57-e47 + `[[core]]` P 1,2,4,5,6,7 ratio 57, no `oc_voltage_mv`); applied through
  `restore-good.sh` 09:25: 0 writes not read back equal, MCE 0; 0x1AD read back 0x3838383838383939; `highest_perf` 92 on all 8 P-cores (the 0x1D writes
  erase the favored-core ranking until a cold boot).
- Single-core 57x on cpu 1 / 2 (`--cpu-method all --verify`, 20 s): 5694 / 5692 MHz, 56 / 60 C, 0 failures (`p57nf-t56/aborted-single/`).
- At PL4 425 / balanced, **scalar int64 all-core tripped 0x64F bit 8** (status `0x1100`) and fell to P 48x (one core 42x) / E 46x at 121 W — before the
  change it ran 55x / 47x at 162 W with no electrical bit.
- PL1 350 / PL2 375 (powercap) + PL4 500 (0x601), throughput-performance (`p57nf-t56-pl350/`): int64 P 5599 / E 4701 MHz, **194 W, P VID 1.348 V**
  (1.271 V at 55x), 0.095 M ops/s (+0.4 %); vecwide P 54-55x (bit 8 still set at PL4 500), 285-288 W, 88 C, 2.042 M ops/s (+0.3 %); both 0 failures.
  **x87 matrixprod all-core hung the machine ~4 s in** (journal ends 09:33:28; no MCE, no BERT/GHES record, package <= 88 C before; hard reset).
- Reading [inference]: the non-favored cores' 56x/57x points carry offset 0 = their stock 55x VID (favored-cores.md §3), so 56x runs one bin above the
  voltage it was qualified at and ~77 mV above the undervolted 55x point; under all-core heavy load the extra droop and heat exhaust that margin.
  Single-core checks at low current do not predict it. The 56x step also costs ~+20 % power (higher VID), which trips PL4 even on scalar loads.
- After the hard reset the boot restore re-applied good-p57-e47 (0 bad writes, MCE 0), favored ranking back (cpu 0/3 hp 92, others 88), limits back to
  BIOS 270 / 295 / 425 W; btrfs device stats all zero; full scrub of `/` (928.57 GiB, 2:09) finished with no errors. Decision D-052.

## 2026-10-02..06 — Windows sittings of the accepted state (migrated) [MEASURED win]
Provenance: earlier research note `win-first-apply.md` (not in this repository). Windows 11 Pro build 26300, BIOS 3.40; the Windows restore flow is in `windows-path.md`.
- **First `--device-win` apply (2026-10-02):** the identity check (fused `0x09 P1=0x11` words of P-cores 0-7) passed in every session, so the live LP map is
  right; three profiles (65 + 51 + 51 ops) all "Result: OK", read-back equal word for word on all 12 cores/clusters; WHEA 0. Probes past a table end
  (P `P2` = 9, E `P2` = 7) answer rc `0x11` and count as non-Pass in the audit; expected.
- **Warm vs cold boot** (corrects "reboots clear point offsets"): after a warm reboot Linux to Windows the offsets stayed on P-cores 1-7 and all E-clusters and
  only P-core 0 went back to stock (the BIOS writes CPU 0's points); after a cold boot everything was stock (`platform-arl-s.md` §7) [MEASURED win 2026-10-02].
- **Silent failure, again:** a profile that set the 53x points of four P-cores to the same voltage (about 1.181 V) ran OCCT CPU for a while and then reported
  "CPU error detected" with **no WHEA event and no system error**: an undervolt instability shows only in a self-checking load (`tuning-results.md` §1)
  [MEASURED win 2026-10-04].
- **A new test class finds what the old gate did not:** OCCT Linpack v2021 (24 threads, 2048 MB) failed on the then-accepted state after about 25 min and
  on its control after 50 min, with no WHEA (average P 5108-5211 MHz, E about 4585, 295 W; SVID VR current avg 172 A, max 213 A; the SVID power field read an
  implausible 452 W, ignore). **Time to error is not monotonic in margin:** the same offsets ran 50 min at BIOS LLC 7 and failed after about 2 min at LLC 6, so a
  single failure time is noise, not a margin measurement. The first state to pass was a revised P table (48x factory, all-P 53x -50 mV, the 55x points set to 1.270 V /
  1.285 V, favored 56/57x points set explicitly) at LLC 6: OCCT Linpack 2021 60 min and OCCT CPU SSE variable 60 min, WHEA unchanged [MEASURED win 2026-10-04].
- **LLC 7 on Windows** (2026-10-03): OCCT CPU+RAM 20 min pass (207 W, 65 C, P all-core 54x, E 48x, Vcore 1.41-1.42 V); OCCT SSE steady 10 min pass (295 W,
  Vcore 1.34 V, equal to Linux at the same LLC). The 54x VID is the midpoint of the 53x and 55x points (no point of its own). The 54x VID gap between cores
  (12-28 mV) is the fused curve: the cores 2/5/6/7 already carry the deepest offsets, so a high VID there is not by itself headroom. Board Vcore is set by the 55x
  points under all-core load, not by 54x actives.
- **Favored-core 57x test** (57x -75 mV on the two favored cores): the operator's 1-thread tests passed with no WHEA, expected effect about 25 mV lower Vcore on
  1-2-thread loads and none all-core [MEASURED win 2026-10-03/04].
- **Hot spots are die location, not VID** (OCCT monitor, 295 W, package 90 C): P-cores LP 12/13 (Linux CPUs 4/5) hottest at up to 92 C (avg 85 C) with mid-pack
  VIDs; E-clusters 2/3 averaged about 85 C vs about 75 C for the E-cores of the first cluster at the same 1.113 V [MEASURED win 2026-10-02]. A thinner
  mounting with an offset contact frame is reported to give -4 to -7 C on a 285K [COMMUNITY hwbusters.com, club386.com].
- **P-turbo 54x for 3-8 active** (BIOS PL1 250 / PL2 295, was 55x) gave **no change in power or temperature** in the operator's tests, against the hypothesis
  that Vcore would follow the 53x/55x midpoint and drop 30-50 mV [operator 2026-10-05; hypothesis not borne out].
- **First P-core 58x write on Windows** (2026-10-06): CPU 0 OC word `0x0005B83A` (58x, adaptive target 1429.69 mV; written target-first at 57x, then ratio),
  `0x1D` read back `0x393A`, `0x27` = 3, and **MSR `0x1AD` 57/57/55... to 58/57/55... (`0x373737373737393A`) read back equal on CPU 0 and CPU 8** = the first plain-MSR
  write on Windows [MEASURED win 2026-10-06]. After it the restore check flags CPU 0 until a reboot (OC word differs from the accepted one).
- **E 48x decoupled from 46x through the OC target** (an idea, not applied; operator model 2026-10-02): an E OC ratio adds a point whose adaptive target the BIOS
  sets equal to the point below, so 48x can get its own voltage through the `P2 = 0` word's V target (mode adaptive, offset 0) while the 46x point keeps its own
  offset. Evidence that fits: a stock OC point tracks point 6; an XTU E OC word `0x0004A931` (49x, target 1.165 V) raised the 48x request to 1.162 V vs fused 1.156 V
  [MEASURED lnx 2026-10-01]; OCCT showed 48x = point-6 voltage plus its offset (cluster 0 1.123 V = 1156 - 35 mV, clusters 1-3 1.113 V = 1137 - 25 mV)
  [MEASURED win 2026-10-02]. The hardware enforces V(48x) >= V(46x with offset), so **the split allows 46x only deeper than 48x**. Cautions: never use the
  `P2 = 0` offset field for this (whole-curve: it would move the 40x point that failed at -20 mV); a deeper 46x with a stock 40x steepens the 40-46x interpolation
  (about -22 mV at 43x, -37 mV at 45x for -45 mV at 46x), the region of the 40x failure; an absolute target no longer follows factory changes the way an offset does.
- **Per-boot op budget:** a restore (about 480 ops including reads) plus one complete P profile (78) fits the 600-op boot budget; a restore plus two more profiles
  did not (557/600 after restore + two profiles, the next step was refused) [MEASURED win 2026-10-04].
