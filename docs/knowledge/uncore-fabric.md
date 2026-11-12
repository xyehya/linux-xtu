# Ring, NGU and D2D fabric: voltages and community data `host lnx`

The three fabric controls on Arrow Lake-S and what is known about each. Which clock the ring, NGU and D2D settings are and where each can be set:
`platform-arl-s.md` §11. Voltage rails: `platform-arl-s.md` §13. Encodings (ring P1 = 2, NGU P1 = 7, `0x620`/`0x621`): `registers.md`.
Provenance: earlier research notes `ring-community.md` (desk research 2026-10-02/03) and `ngu-vccsa.md` (desk research 2026-10-03), not in this repository.
Community numbers come from the SkatterBencher articles read through a summarizer and from forum snippets; every one is `[COMMUNITY]` and is not a constant.

## 1. Ring / LLC (VccR)
- **Stock behaviour** [COMMUNITY https://skatterbencher.com/2024/10/24/arrow-lake-ring-overclocking/]: default ring 39x (3.9 GHz); the ring cannot run
  above the highest P/E core ratio (cores capped at 38x mean ring <= 38x). Up to 9 points: 8 fused plus an OC point, and the 4.0 GHz point is
  "unlocked" only when an OC ratio is programmed. Default ring voltage limit 1.356 V (1.450 V maximum at ambient).
- **One author's sample curves disagree:** about 0.826 V at 8-34x, 1.054 V at 38x, 1.106 V at 39x, 1.159 V at 40x (ring article) vs 1.116 V at 40x
  (#84 article). On the reference chip the stock 39x request was about 1.216 V (operator reading, one sample), roughly 110 mV above that author's sample: the
  spread is per chip, no third sample was found [COMMUNITY; UNVERIFIED for any other chip].
- **Ring points on the reference chip** `[MEASURED lnx 2026-10-02]`: 8, 14, 20, 28, 34, 37, 38, 39x (top fused = 39x, no OC point programmed). Point 8 (39x)
  carried -75.2 mV against a BIOS "-50 at 39x" (25 mV unexplained). Under an all-core OCCT load the ring request was 1.154 V at 3.9 GHz, an effective offset
  of about -62 mV `[MEASURED lnx 2026-10]`, date approximate.
- **Undervolt data:** one 39x run at 950 mV (-150 mV below that author's fused curve; one sample, test depth unknown); #84 final: 42x adaptive 1.200 V
  with "extremely limited ring headroom"; forum snippets 40-42x at 1.0-1.3 V and profiles with "ring voltage offset -0.150" or "VF point 5 offset -50"
  `[COMMUNITY, UNVERIFIED posters]`. **No per-point ring offset results were found anywhere.** No documented symptoms of too-low ring voltage were found
  (expect cache/WHEA errors, memory-test errors, idle or light-load crashes [UNVERIFIED]). Intel Community mentions that Ring Down Bin may misbehave with
  asymmetric core and ring undervolts (off by default on ARL) `[COMMUNITY, snippet]`. "WHEA above 1.2 V" is an **E-core** DLVR issue, not ring
  `[COMMUNITY skatterbencher.com/2025/02/14/285k-whea-when-e-core-voltage-over-1-2v/]`.
- **Ring VID requests count toward VccIA demand** together with the P and E requests (#84) `[COMMUNITY]`; consistent with a 40x request of about 1.2 V on the
  reference chip. Lab cross-check `[MEASURED lnx 2026-10-03, one chip]`: the ring sets VccIA only when the P-cores' allowed maximum is below about 53x
  (floor about 1.30 V); with 55x allowed (all-core and 8-P workloads) Vcore is set by the P 55x points, so a ring undervolt only saves ring power; a ring
  undervolt never passed a test in isolation on that chip.
- **Value of ring clock:** ring 4 to 2 GHz costs under 1.5 % Cinebench R23 nT; ring OC is about +1.2 % geomean in #84 [COMMUNITY]. Typical OC ceiling "a couple of
  bins at best, maybe 4.2 GHz" (overclock.net snippet "40x, sometimes 42x OK at 1.1 V", unverified poster). Test tools the same author uses for fabric work:
  y-cruncher FFT / component tester, OCCT, Cinebench R23, an AI benchmark.
- **Board names** [COMMUNITY]: ASUS "Max. CPU Cache Ratio", "Ring DLVR Voltage", "Additional Turbo mode Voltage" (ring V/F points not exposed in the ROG
  BIOS); ASRock and MSI names were not found.
- **llama.cpp and similar:** no ring data; token generation is DRAM-bound, so DDR5 matters far more than NGU, and NGU more than ring (`llm-bench.md`).

## 2. NGU and VccSA
NGU/NoC is on the external VccSA rail (no DLVR), shared with the memory controller; VccSA follows the highest request of all VccSA rails (NGU and MemSS)
`[COMMUNITY SkatterBencher MemSS article]`, with the MemSS default limit 1.122 V (1.219 V maximum at ambient). NoC fused points are 11/23/26/31x on the 270K Plus,
so 34x is beyond the fused curve.

| Source | CPU | NGU / D2D | VccSA (VnnAON) | DDR5 | Tested |
|---|---|---|---|---|---|
| Igor's Lab (igorslab.de, "wrong clock" NGU/D2D article) | 265K | 26/34 x 21/32 | 1.15 fixed (0.78) | 7800 CL36 | MLC latency only, no stability claim |
| SkatterBencher #101 | 270K Plus | 34 / 38 | **1.300** (1.000) | 8000 | Y-Cruncher, CB R23, AI bench, OCCT: "3.4 GHz NGU really needs 1.3V as it was unstable with 1.25V" |
| SkatterBencher #84 | **285K** | 34 / 38 | 1.300 (1.000) | 8600 | same, plus 1 h OCCT |
| SkatterBencher #101, 200S profile | 270K Plus | 32 / 32 | 1.200 (0.800) | 8000 | settings sheet |
| SkatterBencher NGU article | 285K | 35 | "typically 1.30 V" | - | Y-Cruncher +1 % for 2.6 to 3.5 GHz |
| #101 comment | 270K Plus | 34 | 1.28 | 7200 | "rock-solid stable" (unverified poster) |
| hardwareluxx advice | 270K Plus | 32 / 32 | 1.27-1.30 | 8600-8800 | advice only |

- **200S Boost profile:** NGU/D2D <= 3.2 GHz, VccSA <= 1.2 V, VDD/VDDQ/VDD2 <= 1.4 V, 3-year warranty `[DOC corsair.com restatement; Intel's own page not found]`.
- **Reading of the table:** no published NGU 34x is stable at VccSA <= 1.2 V; stable reports are 1.28-1.30 V and 1.25 V failed on one sample. 34x under a
  1.2 V cap is therefore unlikely; 33x is the realistic step (one bin, D2D unchanged) [inference, UNVERIFIED].
- **Too-low VccSA** shows only as "unstable" in fabric-sensitive tests (Y-Cruncher, CB R23, AI bench); no documented WHEA, boot or USB pattern [gap].
- **Gains:** Igor's Lab loaded latency 101.8 to 94.4 ns for NGU 2.6 to 3.4 GHz on a 265K (NGU 2.6 to 3.4 is about 3x the latency effect of D2D; both: 92.6 ns,
  bandwidth +4 %) `[COMMUNITY]`; throughput about +1 %; the 32-to-34 share is not separated. Reference-chip baseline at NGU/D2D 32x, DDR5-7200: MLC idle
  latency 50.3 ns from P-core 0 (`llm-bench.md` §4).
