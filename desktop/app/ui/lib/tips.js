// Tips screen content (desktop/DESIGN.md §8). DATA ONLY: no DOM, no imports, no behaviour.
//
// TIPS.sections is the ordered reading path. Each section:
//   id     stable anchor (hints.js `tip:` and F1 point here)
//   n      display number ("01")
//   title  heading
//   meta   one line under the heading: the screen it concerns and the reading time
//   goto   the screen it concerns: { screen, tab? } — the Tips view renders "Open <label> ›" and routes there
//   blocks ordered content:
//     { p: "text" }                      paragraph; inline marks: **strong**, [set]edit[/set], [base]factory[/base], [write]orange[/write]
//     { steps: ["…", …] }                numbered steps
//     { bullets: ["…", …] }              bulleted list
//     { box: { title, text } }           neutral fact box (never alarming colours)
//     { indicators: [{ ann, state, text }] }  annunciator legend drawn with the real .lx-ann component
//     { figure: { kind, …data }, caption } diagram drawn with the plot grammar (kinds: vf, turbo, power); numbers are illustrations
//     { glossary: [{ term, expert?, text }] }
// Facts follow docs/knowledge (platform-arl-s.md, throttling.md §G, tuning-results.md) and D-049/D-050/D-053. No values from any
// particular machine. Check: node desktop/design/tools/check_copy.mjs (lengths, tone, links, word count).

export const TIPS = Object.freeze({
  title: "Tips",
  lead:
    "A short path for anyone new to tuning: what this app changes, how to read the screen, a first careful undervolt, how to test it, and when to stop. About ten minutes.",
  footer:
    "Linux XTU is an independent project, not affiliated with or endorsed by Intel. Intel, Intel Core and XTU are trademarks of Intel Corporation or its subsidiaries.",
  sections: [
    {
      id: "start",
      n: "01",
      title: "What this app changes, and what it cannot break",
      meta: "Read first · 2 min",
      goto: { screen: "overview" },
      blocks: [
        {
          p: "**Linux XTU** changes how an Intel Core Ultra 200S processor runs while Linux is up: the voltage it asks for at each speed step, the highest speed steps it may use, and how much power it may draw.",
        },
        {
          p: "Not affiliated with or endorsed by Intel. XTU is a trademark of Intel Corporation.",
        },
        {
          p: "**Nothing it writes is permanent.** The settings live inside the processor, not on disk. A cold boot (power off, then on) returns the processor to its BIOS settings; the app puts yours back only when you ask. A warm restart can keep some voltage offsets, so the app reads the processor again after every boot.",
        },
        {
          p: "**What it cannot protect you from:** an unstable setting does not always crash. It can compute a wrong result, such as a corrupted file or a failed build, often with nothing in the logs. Treat every new setting as untested until it has passed a long test.",
        },
        {
          box: {
            title: "Limits are not safety margins",
            text: "The app refuses values outside what the processor reports as its own limits and outside what each setting can hold. It does not know what is safe for your chip; testing does.",
          },
        },
      ],
    },
    {
      id: "reading",
      n: "02",
      title: "Reading the screen",
      meta: "Every screen · 1 min",
      goto: { screen: "tune", tab: "cores" },
      blocks: [
        { p: "Colour always means the same thing, on every screen:" },
        {
          bullets: [
            "**White** numbers are measured, or read back from the processor.",
            "[base]Grey[/base] numbers are factory values: what the chip came with.",
            "[set]Cyan[/set] marks your edits, values the processor does not have yet. A cyan square marks every unit and tab that holds one.",
            "[write]Orange[/write] appears on one button only: the one that writes to the processor.",
          ],
        },
        {
          p: "The top bar shows the helper link, whether writes are allowed, and whether the processor still matches your accepted state. **Read** there fetches everything again; the tag on it is the cost in mailbox requests.",
        },
        {
          p: "The bottom bar shows live package power, clock, temperature and core voltage, then the limit indicators. The line above it explains the control you are on; F1 opens its tip.",
        },
        {
          p: "Edits wait in the pending row. Nothing reaches the processor until you **Review**, read the plan, and **Apply**.",
        },
      ],
    },
    {
      id: "first-undervolt",
      n: "03",
      title: "A first, careful undervolt",
      meta: "Tune › Cores · 3 min",
      goto: { screen: "tune", tab: "cores" },
      blocks: [
        {
          p: "An undervolt lowers the voltage the processor asks for at a given speed. Less voltage means less heat and power, and often higher clocks under long loads. Too little gives wrong results, so you look for the edge slowly, one change at a time.",
        },
        {
          steps: [
            "Make sure Undervolt Protection is off in the BIOS. While the UVP indicator is lit, the processor refuses every negative offset.",
            "Press **Read**, open Tune › Cores and select one unit. A P-core not marked ★ is a good start, or one E-cluster.",
            "Set its whole-curve offset to [set]−10 mV[/set]. Point offsets add to it: −10 on the whole curve and −20 on one point make −30 at that point.",
            "Press **Review** and check the plan: unit, point, before, after. Then **Apply** and confirm.",
            "Run a quick screen on that unit in Stress. If it passes, go down another 5 to 10 mV. If it fails, return to the last value that passed.",
            "Once you have found a unit’s edge, give back 10 to 20 mV as margin, then move on to the next unit.",
          ],
        },
        {
          figure: {
            kind: "vf",
            alt: "A factory V/F curve, the same curve after a whole-curve offset and one point offset, and an OC point above the top ratio",
            x: [4, 62],
            y: [0.6, 1.6],
            xticks: [10, 20, 30, 40, 50, 60],
            yticks: [0.6, 0.8, 1.0, 1.2, 1.4],
            points: [
              { r: 8, v: 0.7 },
              { r: 20, v: 0.74 },
              { r: 30, v: 0.82 },
              { r: 40, v: 0.93 },
              { r: 48, v: 1.04 },
              { r: 53, v: 1.2 },
              { r: 55, v: 1.3 },
              { r: 57, v: 1.42 },
            ],
            curveMv: -50,
            pointIndex: 4,
            pointMv: -50,
            oc: { r: 59, v: 1.5 },
            labels: {
              factory: "factory curve",
              curve: "whole curve −50 mV",
              point: "one point: −50 more",
              oc: "OC point: own voltage",
            },
          },
          caption:
            "Grey: the factory curve. Cyan: after a whole-curve offset plus one point offset; the two add. An OC point sits above the factory top and has a voltage of its own: on the one chip tested, lowering the top point did not lower it. Dotted: ratios between two points rise in a straight line. Illustration, not one chip’s values.",
        },
        {
          p: "The processor does two things on its own. It keeps every point at or above the one below, so a very deep offset on a high point gets lifted; the After column shows ↑ when that happens. And speeds between two points get a voltage in between. The four cores of an E-cluster run one ratio, and the app writes all four.",
        },
      ],
    },
    {
      id: "testing",
      n: "04",
      title: "Testing for stability",
      meta: "Stress · 2 min",
      goto: { screen: "stress" },
      blocks: [
        { p: "A setting is stable when it survives the heaviest load you will give it, for hours, without a single wrong result. No short test can show that." },
        {
          bullets: [
            "**A quick screen** in Stress finds bad settings within minutes. Run one after every step. A pass means only “not obviously broken”.",
            "**The gate** is the long self-checking test a setting should pass before you accept it: an hour or more, every core loaded, with a program that checks its own results. Linpack-class tests and large compiles have caught settings that shorter screens passed.",
            "**Errors are often silent.** Most failures seen left no crash and no kernel message. A clean log is not evidence of stability.",
            "**Time to failure is noisy.** The same setting can fail after two minutes or after fifty. Count only full passes.",
            "**Change one thing at a time.** If a test fails after two changes, you cannot tell which one caused it.",
          ],
        },
        { p: "When the gate passes, **Accept** that state in Profiles. Restore accepted can then put it back after any boot, through the same review." },
      ],
    },
    {
      id: "indicators",
      n: "05",
      title: "What the indicators mean",
      meta: "Bottom bar · 1 min",
      goto: { screen: "overview" },
      blocks: [
        {
          p: "Each indicator names a reason the processor is running slower than it could. Dark means inactive. Lit means the condition holds right now; the percentage says how much of the last second it held.",
        },
        {
          indicators: [
            { ann: "PL1", state: "lit-warn", text: "The long-term limit PL1 holds the clocks down. Normal during long heavy loads." },
            { ann: "PL2", state: "lit-warn", text: "The short-term limit PL2 holds the clocks down." },
            { ann: "PL4", state: "lit-warn", text: "The peak limit PL4 binds. Seen on one tested chip with every core on AVX2 code: PL4 is checked against a predicted peak, not measured draw." },
            { ann: "Therm", state: "lit-fault", text: "A temperature limit binds. Check cooling before you tune any further." },
            { ann: "VR", state: "lit-warn", text: "The motherboard’s voltage regulator signals a thermal alert." },
            { ann: "Turbo", state: "lit-info", text: "The turbo table caps the ratio for the number of busy cores. Normal under load, so it lights grey." },
          ],
        },
      ],
    },
    {
      id: "power",
      n: "06",
      title: "Power limits in plain words",
      meta: "Tune › Power · 1 min",
      goto: { screen: "tune", tab: "power" },
      blocks: [
        {
          p: "Three numbers decide how much power the package may draw. The **Short-term limit PL2** is the ceiling: under a sudden heavy load the processor may draw up to PL2. The **Long-term limit PL1** is the sustained limit: the processor keeps a running average of its power over a time window, the **time window tau**, and once that average reaches PL1 it slows down to stay there. The **Peak limit PL4** is a watt limit checked against the processor’s own worst-case prediction; the app shows it and never changes it.",
        },
        {
          figure: {
            kind: "power",
            alt: "Package power under a long heavy load: a burst near PL2, then a settle to PL1, with PL4 above both",
            t: 120,
            ymax: 360,
            xticks: [0, 30, 60, 90, 120],
            yticks: [0, 100, 200, 300],
            burstStart: 10,
            tau: 30,
            refs: [
              { w: 330, label: "PL4 · peak" },
              { w: 250, label: "PL2 · short-term" },
              { w: 160, label: "PL1 · long-term" },
            ],
            trace: [
              [0, 22], [10, 22], [11, 242], [38, 244], [44, 205], [50, 172], [56, 162], [62, 160], [120, 160],
            ],
            labels: { tau: "≈ one time window (tau)" },
          },
          caption: "Package power under a long heavy load: near PL2 at first, then down to PL1 once the running average catches up. PL4 sits above both. Illustration, not one machine’s limits.",
        },
        {
          p: "Lower limits mean less heat and fan noise, and lower clocks under long loads. A lower limit also moves heavy loads onto lower V/F points, so test again after changing it. Power limits are runtime values: after a reset the BIOS limits were back on the tested chip.",
        },
      ],
    },
    {
      id: "ratios",
      n: "07",
      title: "Ratios and turbo tables",
      meta: "Tune › Frequency · 1 min",
      goto: { screen: "tune", tab: "frequency" },
      blocks: [
        {
          p: "A ratio is a speed step: ratio 55 means 55 × 100 MHz, 5.5 GHz. Several limits decide the ratio a core really reaches, and the lowest one wins: the unit’s own maximum or its OC ratio, the turbo table entry for the number of busy cores, and any ratio cap. Tune › Frequency shows them side by side and names the one that binds.",
        },
        {
          figure: {
            kind: "turbo",
            alt: "A turbo table: the highest ratio for 1 to 8 busy cores, level or falling, with one rising bucket marked invalid",
            buckets: [58, 58, 56, 56, 55, 55, 54, 54],
            y: [50, 60],
            yticks: [50, 52, 54, 56, 58],
            bad: { bucket: 5, value: 57 },
            labels: { few: "few busy: highest", all: "all busy: lowest", bad: "rising: refused" },
          },
          caption: "Each square is one bucket: the highest ratio for that many busy cores. Fewer busy cores may run higher. A bucket above its left neighbour is invalid.",
        },
        {
          p: "The table may stay level or fall as more cores get busy, but never rise; a rising table is refused. Setting an OC ratio does not raise the table: if the table says 55 for one busy core, the core stays at 55. A ★ marks the favored P-cores, which can reach a higher top ratio, but only while few cores are busy.",
        },
      ],
    },
    {
      id: "stop",
      n: "08",
      title: "When to stop, and how to go back",
      meta: "Profiles · 1 min",
      goto: { screen: "profiles" },
      blocks: [
        {
          bullets: [
            "Stop lowering a unit at its first error, and keep 10 to 20 mV of margin above the last value that passed.",
            "Stop when a step no longer lowers temperature or power at the same load. Judge by power and temperature at a fixed load, not by peak clocks.",
            "Do not test new settings while doing work you cannot afford to lose.",
            "If you raise an OC voltage and errors stay, the ratio is not worth it on your chip. Go back down.",
          ],
        },
        { p: "Ways back, from small to large:" },
        {
          steps: [
            "**Discard** drops edits that were never applied.",
            "**Restore boot values** (Tune › Power, Frequency, Ring & uncore): puts back what this boot started with.",
            "**Restore accepted** plans the writes back to your known-good state; you review and apply them as usual.",
            "**A reboot** clears power limits, ratio caps and the ring range; **a cold boot** also clears V/F offsets.",
          ],
        },
      ],
    },
    {
      id: "glossary",
      n: "09",
      title: "Glossary",
      meta: "Reference",
      goto: null,
      blocks: [
        {
          glossary: [
            { term: "Ratio", text: "A speed step. The clock is the ratio × 100 MHz." },
            { term: "V/F point", expert: "voltage/frequency point", text: "One ratio of a unit’s curve and the voltage it asks for there. Each unit has a handful." },
            { term: "Offset", text: "Millivolts added to a factory voltage. Negative values undervolt." },
            { term: "Whole-curve offset", text: "One offset for every point of a unit. It adds to the point offsets." },
            { term: "OC point", expert: "OC ratio + adaptive target", text: "An extra point above the factory top ratio, with its own voltage. Cleared by a cold boot." },
            { term: "Factory", expert: "fused", text: "Values set for this particular chip when it was made." },
            { term: "Favored core", expert: "★", text: "A P-core fused to reach a higher top ratio than the others." },
            { term: "E-cluster", text: "Four efficient cores that run one ratio. The app writes all four." },
            { term: "Ring", expert: "cache / LLC clock domain", text: "The bus between the cores and the shared cache, with its own curve and clock range. The fabric clocks NGU and D2D are separate, set in the BIOS." },
            { term: "Requested voltage", expert: "VID", text: "The voltage a core asks for. No sensor reports what actually reaches it." },
            { term: "Core voltage", expert: "Vcore, VccIA", text: "The board’s supply for the cores. It sits above the highest requested voltage." },
            { term: "Turbo table", expert: "turbo ratio limits", text: "The highest ratio for each number of busy cores." },
            { term: "Long-term limit, short-term limit", expert: "PL1, PL2", text: "Package power sustained on average, and allowed briefly. The time window tau is the averaging time." },
            { term: "Peak limit", expert: "PL4", text: "A watt limit checked against a predicted worst case. Shown, never changed." },
            { term: "Mailbox", expert: "OC mailbox", text: "The processor interface for V/F points. Every request, reads included, is a write to one processor register." },
            { term: "Undervolt Protection", expert: "UVP", text: "A BIOS setting. While it is on, the processor refuses negative offsets." },
            { term: "Accepted state", text: "Your known-good state, marked with Accept. Accept it only after the gate; the app does not check that." },
            { term: "Profile", text: "A saved, complete state that you can compare, load into Tune or apply." },
            { term: "Quick screen", text: "A short stress run that catches bad settings within minutes." },
            { term: "Gate", text: "The long self-checking test a setting should pass before you accept it." },
            { term: "Cold boot", text: "Power off, then on. The processor starts again from its BIOS settings." },
          ],
        },
      ],
    },
  ],
});
