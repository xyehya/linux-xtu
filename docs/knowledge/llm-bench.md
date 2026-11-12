# llama.cpp and memory-bandwidth measurements on the reference machine `host lnx`

One chip, one board, one GPU (RTX 5080 16 GB), 2026-10-03: how an LLM server workload uses the CPU, DRAM and PCIe, and DRAM bandwidth and latency
baselines. Useful as a fabric/memory A/B workload and as a bandwidth calibration; not a tuning recipe. State during the runs: NGU/D2D 32x, DDR5-7200,
VccSA fixed 1.185 V, BIOS LLC 7, the p-step4 CPU state (`tuning-results.md`).
Provenance: earlier research note `lnx-llama-bench.md` (not in this repository; its harness script is not part of this repository either).

## 1. Method
Server with P-cores 0-7 strictly (CPU affinity), 160k-token context, q8_0 KV cache, speculative decoding (MTP + n-gram), `--fit on --fit-target 128`; per
repetition a 4910-token raw prompt (fixed text, seed 42, no prompt cache) and 512 generated tokens, three repetitions. Monitors: `nvidia-smi dmon` (PCIe rx/tx,
SM, power), `perf stat` on `uncore_imc_free_running` (DRAM read/write; `telemetry-sources.md`) and the app's telemetry sampler.

## 2. Unified memory ON vs OFF (`GGML_CUDA_ENABLE_UNIFIED_MEMORY`; llama.cpp only checks that the variable exists) `[MEASURED lnx 2026-10-03]`
| | Dense 27B Q3 UM ON | Dense 27B Q3 UM OFF | MoE 35B-A3B Q8 (~37 GB) UM ON | MoE UM OFF |
|---|---|---|---|---|
| Prompt processing, tokens/s | 1985 (first run 1400, warm-up) | 1119-1141 | 288-301 | **2021-2132** (7.1x) |
| Token generation, tokens/s | 82.5-98.5 (median 85.6) | 10.8-12.0 (median 11.8) | 12.7-13.8 | **41.3-42.5** (3.2x) |
| GPU SM median / power | 91 % / 280 W | 3 % / 70 W | 99 % / 80 W (stalled on page faults) | 17 % / 78 W |
| DRAM read median under load | 2.2 GB/s | **19.4 GB/s** (max 31.3) | 11.7 GB/s | **33.3 GB/s** (max 37) |
| PCIe rx / tx median | 170 / 40 MB/s | 11 / 12 MB/s | **11.3 / 12.5 GB/s** (continuous paging) | 0.2 / 0.08 GB/s |
- **Mechanism** `[hypothesis]`: with unified memory the 160k-token KV cache is managed memory and untouched pages take no VRAM, so `--fit` puts every layer of
  the dense model on the GPU (7x token generation). Without it the full KV must be reserved in VRAM, `--fit` moves layers to the CPU, and the P-cores run
  DRAM-bound at about 19 GB/s. For the MoE, unified memory makes `--fit` treat the 37 GB as GPU memory, so the 16 GB card faults experts in over PCIe every
  token (latency-bound at 11-18 GB/s on a PCIe 5.0 x16 link); without it the experts stay in RAM on the P-cores (the classic `--n-cpu-moe` layout).
- **Rule for this machine:** unified memory ON for the dense 27B (KV allocation), OFF for the MoE. At short and medium context the GPU does everything (CPU,
  RAM and NGU are irrelevant); as the context really grows, touched KV pages exceed VRAM and RAM/NGU/PCIe start to matter [inference].
- The MoE without unified memory (all 8 P-cores about 41 % busy, 5.34-5.45 GHz) uses 33 GB/s of about 95: it is bound by per-token CPU-GPU hand-off latency,
  not bandwidth, so it is **the workload where NGU latency could show**, the metric for an NGU 32-to-34x A/B (`uncore-fabric.md`).

## 3. DRAM bandwidth calibration `[MEASURED lnx 2026-10-03]`
`stress-ng --stream`, 30 s, `perf` `uncore_imc` counters as the hardware truth (perf reports MiB: multiply by 1.0486 for MB): 8 P-cores (0-7) **95 GB/s**
read+write (48 R / 47 W); 16 E-cores 99 GB/s; all 24 CPUs 100 GB/s. A Windows AIDA64 read test reached 112 GB/s (pure reads; DDR5-7200 2-channel theoretical
115.2 GB/s; mixed read/write loses bus turnaround). **The 8 P-cores alone reach about 95 % of the package bandwidth**, so pinning llama.cpp to P-cores 0-7
costs almost none; the 27B no-UM run (20 GB/s median, 33 GB/s peak) is not bandwidth-bound (CPU-GPU hand-off and Q3 dequantisation).

## 4. Intel MLC v3.13 baseline (NGU/D2D 32x, DDR5-7200, VccSA 1.185 V fixed) `[MEASURED lnx 2026-10-03]`
Run unprivileged with `-e -r` (no prefetcher MSR writes; random-access latency); kernel taint unchanged, no msr kernel messages.
- Idle latency: default **63.7 ns**; from P-core 0 **50.3 ns** (500 MiB buffer); from E-core 8 **77.3 ns**.
- Peak injection bandwidth, all cores (MB/s): reads **109,626**, 3:1 103,065, 2:1 102,390, 1:1 101,120, triad 101,346. **8 P-cores only (`-k0-7`): reads
  111,205**, 3:1 104,589, 2:1 103,071, 1:1 102,685, triad 101,182: the P-cores alone saturate DDR5-7200 (matches AIDA64's 112 GB/s).
- Loaded latency (read-only; delay: ns at MB/s): 0: 211.6 at 109,713; 100: 176.4 at 109,618; 200: 130.8 at 108,179; 300: 87.1 at 79,479; 500: 67.1 at 50,816;
  1000: 57.9 at 28,314; 2500: 53.8 at 12,591; 20000: 51.8 at 2,701. The knee is at about 100-108 GB/s. Cache-to-cache: L2 to L2 HIT 26.4 ns, HITM 32.9 ns.
- The MoE-without-unified-memory run (about 33 GB/s) sits on the flat part of this curve (about 55-58 ns), so NGU's idle-latency gain applies directly there.
