# Golden cases (R-B4)

`voltage_cases.json` is the voltage model of the V/F words as a table of cases, language-neutral, so the desktop UI and the Python helper are held
to the same answers. Consumers: `desktop/app/ui/tests/lib_golden_voltage.test.mjs` (the UI lib and the mock backend) and, next, the helper's tests.
No case was produced by running hardware; every expected number follows from the facts its `evidence` tags cite. The unit data (fused words, point
ratios, limits, turbo tables) is the simulator's recording in `desktop/app/ui/fixtures/tune-read.json`, not reference-machine numbers (D-036).

## The model the cases pin
- A P-core or E-cluster has two offset layers: the whole-curve offset (offset field `[31:21]` of its `P2 = 0` word) and each fused point's own
  offset. The CPU adds them: effective offset = whole-curve + point.
- Fused points take offsets only. The OC point is one extra point above the fused top (the `P2 = 0` ratio + adaptive target). With no voltage given,
  a new OC point asks for the un-offset fused top voltage (`0x09`); the top point's offset is not inherited. A target below the top point's
  effective voltage is lifted to it.
- Only the adaptive-target OC mode is offered (D-053 item 6). Not measured, so flagged rather than predicted as fact: whether a whole-curve offset
  shifts an OC target, and whether the line from the top point to the OC point starts at its offset or its fused voltage.
- E-clusters are one unit of four CPUs (one row, one word per CPU).
- Refused, with a reason key (`desktop/app/ui/lib/hints.js` WHY): positive point / ring / whole-curve offsets, values outside the field or the
  CPU's limits (never clamped), a rising turbo table (P and E), a target on a unit with no OC point, a whole-curve and a point change on one unit
  in one intent, the OC modes "offset" and "target_offset".

## Shape
Top level: `encoding` (how a word is built), `units` (P0, P1, EC1: kind, CPUs, fused word, point number -> ratio, own max ratio, the OC word as
recorded), `limits`, `turbo`, `tolerance_v` (volts compare within it: typed mV vs the 1/1024 V raw the CPU holds), `cases`.

A case: `id`, `title`, `evidence` (tags as AGENTS.md "Evidence rules"), and
- `read` — the state the CPU holds before the edits, per unit: `oc: {ratio, v_target_v, offset_mv}` (the `P2 = 0` word; `offset_mv` is the
  whole-curve layer) and `points_mv: {ratio: mV}`. Unlisted = the fixture (all 0, P0's OC word `0x39`, the others `0x0`). Values are typed mV;
  a reader decodes them as the helper does (raw -> `raw * 1000 / 1024`). `read_words` gives the same state as words for the helper side.
- `uvp` — `"on"` when Undervolt Protection is known on. `baseline_v` — per unit, ratio -> stock volts (a measured stock curve stand-in).
- `edits` — in order: `curve {units, mv}`, `point {units, ratio, mv}`, `ring_point {point, mv}`, `oc_ratio {units, ratio}`,
  `oc_target {units, v}`, `oc_mode {units, mode}`, `bucket {kind, i (0 = 1 busy core), ratio}`.
- `expect` (every key optional):
  - `refusal {op, reason, values?}` — edit number `op` is refused (`values` is a subset of the reason's placeholders); nothing changes.
  - `draft {unit: {ratio, vt, vt_auto}}`; `layers {unit: {curve_mv (drafted whole-curve, null = unchanged), points_mv (drafted point layer)}}`;
    `read_layers {unit: {curve_mv, points_mv}}` (as read).
  - `effective_offset_mv` (within 1 mV) and `effective_offset_raw` (exact: whole-curve raw + point raw) per unit and ratio.
  - `pending {total}`; `intent` (the `tune.plan` intent, exactly) or `intent_refusal {reason, unit}`.
  - `words [{unit, cpu, p2, word, stage?}]` — the `0x11` data words the helper writes, in order, per CPU (`0x1D` / `0x27` after a ratio are not
    listed). Checked against `controls/planner.py` (`xtu_word`, `kept_word`, `_vf_words`) when the file was written.
  - `voltage_v`, `clamped_by`, `not_measured {unit: {ratio: [keys]}}`, `oc {unit: {ratio, mode, target, v, clamped_by, not_measured}}` with the
    case's `baseline_v` (the fused top stands in at the top ratio).
  - `warnings [{code, unit, hint}]`, `turbo`, `moved` (buckets that followed a lowering).
  - `helper_intent` + `helper_refusal {code, check?, message_re}` / `helper_warning` — what the helper answers to an intent the UI would not
    build (the UI refuses first). `helper_note` says where the helper does not do it yet.
  - `read_after {unit: {curve_mv, points_mv, oc_ratio?, v_target_v?}}` — what a re-read shows after the apply (decoded mV): the whole-curve
    layer stays its own layer.

Change a case only with a new evidence tag; add the matching assertion on both sides.
