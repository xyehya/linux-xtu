#!/usr/bin/env python3
"""Visual capture harness for the desktop UI (R-A5). Renders every screen headlessly and screenshots it; doubles as a smoke test.

Usage
  python3 desktop/app/ui/tests/visual_capture.py --out DIR            all states, 1280x800 and 960x600 (the minimum window)
  python3 desktop/app/ui/tests/visual_capture.py --list               list state names (and what each one does) and exit
  python3 desktop/app/ui/tests/visual_capture.py --out DIR --only tune-cores-p0 review-ready      a subset
  python3 desktop/app/ui/tests/visual_capture.py --sizes 1280         one size only (1280, 960, 1920, 2560)
  python3 desktop/app/ui/tests/visual_capture.py --check              what tools/run_tests.py runs: every state at 1280x800 into a temp dir

How it works: ui/ is served from a loopback HTTP server that sends the SAME Content-Security-Policy as src-tauri/tauri.conf.json; the page runs on the
mock bridge (?bridge=mock, fixtures, no helper, no hardware); headless Chrome is driven over a DevTools pipe (cdp_pipe.py transport, no TCP port),
with a fresh page load per state. Chrome is told to resolve nothing but loopback, and any request to another origin is reported as an error.
A state FAILS when a setup step cannot find its element, when the page never becomes ready, or when the page logs a console error, a thrown exception,
a CSP violation or a failed request. Pixel contents are never compared (no baselines are committed; the redesign changes every pixel).

Output: DIR/<size>-<NN>-<state>.png (e.g. 1280-12-tune-cores-pending.png) and, at 1280 only, DIR/1280-<NN>-<state>-full.png for the states marked `full`
(the window grown until the whole screen area is visible). Exit code: 0 all good, 1 a state failed / the page logged errors, 2 usage error.
Chrome/Chromium is found via --chrome, $LINUX_XTU_CHROME, then PATH; if there is none the run is SKIPPED (message, exit 0).
Stdlib only. Uses the pipe transport in cdp_pipe.py. Touches no hardware and opens no network connection.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import functools
import http.server
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
UI = ROOT / "desktop" / "app" / "ui"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp_pipe import ToolError, find_chrome, spawn_chrome_pipe  # noqa: E402

SIZES = {"1280": (1280, 800), "960": (960, 600), "1920": (1920, 1080), "2560": (2560, 1440)}  # 1920 / 2560 are opt-in (--sizes): QA-03 large screens


# ---------------------------------------------------------------------------------------------------------------------------------------
# The states, declaratively. A step is a tuple: ("click", css) · ("type", css, value) · ("seg", button text) · ("wait", css) · ("eval", js) · ("pump", seconds)
# ("scroll", css). Every "click" / "type" / "seg" / "wait" / "scroll" FAILS the state when its element is absent (a harness that silently shot the wrong
# thing is worse than none). Query strings are the mock bridge's knobs (fixtures/mock-backend*.js headers).
# ---------------------------------------------------------------------------------------------------------------------------------------
@dataclass
class State:
    name: str
    hash: str                                   # "#/dashboard" ...
    query: str = "tick=200"                     # appended after ?bridge=mock& (tick=200: fast telemetry frames)
    steps: list[tuple] = field(default_factory=list)
    ready: str = ""                             # CSS selector that must exist before the steps (waited for, up to 10 s)
    settle: float = 1.2                         # seconds to let the page run before the shot
    full: bool = False                          # also write a -full shot at 1280
    mock: bool = True                           # False: no ?bridge=mock (what a browser without the desktop runtime shows)
    allow: tuple[str, ...] = ()                 # regexes of console messages this state is DESIGNED to log (kept narrow)
    note: str = ""


Q_MOTION = "motion=1&tick=200"
P0 = "[data-unit-table] tr[data-unit='P0']"   # R-S1: the unit table of Tune › Cores (data-* selectors, never lx- classes)
P0_ROW48 = "[data-vf-table='P'] tr[data-ratio='48'] input"
TILES = P0
BLUR = ("eval", "(document.activeElement && document.activeElement.blur(), true)")  # a mouse click leaves no focus ring; the harness's synthetic click does
FOCUS_ROW48 = ("eval", "(document.querySelector(\"[data-vf-table='P'] tr[data-ratio='48'] input\").focus(), true)")
# Ctrl-click / Shift-click on the unit table (the harness's click has no modifiers)
def MODCLICK(unit: str, mod: str) -> tuple:
    return ("eval", "(document.querySelector(\"[data-unit-table] tr[data-unit='%s']\").dispatchEvent(new MouseEvent('click', {bubbles: true, %s: true})), true)" % (unit, mod))

THROTTLE_SETUP = """(async () => {
  const st = await import('/store.js');
  const { store, bridge } = window.__linux_xtu;
  await bridge.call('telemetry.stop', {});
  await new Promise((r) => setTimeout(r, 200));
  const leaf = (v, src) => ({ value: v, status: 'ok', unit: '', source: src });
  const g = (label, active, duty, bits) => ({ label, active, duty, bits });
  const frame = { t: 11, values: {
    throttle: leaf({ samples: 10, failed: 0, window_s: 1.0, or_word: 0, bit_duty: { pl1: 0.2, pl2: 0.1, max_turbo_limit: 1.0 }, info_bits: [], unknown_bits: [14],
      groups: { power: g('Power limit', true, 0.3, ['pl1','pl2']), current: g('Current / EDP', false, 0, []), thermal: g('Thermal', false, 0, []), vr_thermal: g('VR thermal', false, 0, []), max_turbo: g('Max turbo cap', true, 1.0, ['max_turbo_limit']) } }, 'msr 0x64F status bits, oversampled'),
    limit_reasons: leaf({ raw: 0x1DC20C00, status: ['pl1','pl2'], log: ['thermal','pl1'], unknown_bits: [] }, 'msr 0x64F (decoded)'),
    limit_reasons_gfx: leaf({ raw: 0x01000000, status: [], log: ['other'], unknown_bits: [] }, 'msr 0x6B0 (decoded)'),
    kernel_thermal: leaf({ core_count: 0, package_count: 0, core_delta: 0, package_delta: 0 }, 'sysfs cpu*/thermal_throttle'),
  } };
  st.applyHelperEvent(store, 'telemetry', frame);
  return true;
})()"""

# The recorded simulator preflight says writes_allowed: false (msr_allow_writes unknown), so the frame gates Review (read-only mode, U-02). States that
# show the review flow first flip the store's preflight to "writes allowed" through the mock-only seam (the fixtures stay as recorded).
WRITABLE = ("eval", """(async () => {
  const st = await import('/store.js');
  const { store } = window.__linux_xtu;
  const pre = store.get().preflight || {};
  st.setPreflight(store, { ...pre, writes_allowed: true, checks: (pre.checks || []).map((c) => ({ ...c, status: 'pass' })) });
  return true;
})()""")
# The mock always has a read of this boot (tune.last); forget it to show the teaching empty state.
NO_READ = """(async () => {
  const t = await import('/views/tune.js');
  const { store } = window.__linux_xtu;
  t.patchTune(store, { model: null });
  store.set({ lastReadAt: null });
  return true;
})()"""
# The accepted state of the mock matches the read; make the top bar's ACCEPTED cluster say "differs · 2" (two units) to show Restore accepted.
DIFFERS = """(async () => {
  const st = await import('/store.js');
  const { store } = window.__linux_xtu;
  st.setLastRead(store, store.get().lastReadAt, [{ cpu: 0, match: false }, { cpu: 8, match: false }, { cpu: 1, match: true }], '');
  return true;
})()"""
# The g218 layer of the mock replays a measurement / stress run with 12 ms between events and `?step=` does not reach it: stretch the page's timers
# x50 so a run is still in progress when the shot is taken (capture only; the real helper sends events at its own pace).
SLOW_REPLAY = ("eval", "(() => { const st = window.setTimeout.bind(window); window.setTimeout = (f, ms, ...a) => st(f, (ms || 0) * 50, ...a); return true; })()")
# Preflight answered without a topology (the units' empty state): the store's preflight is replaced through the mock-only seam.
NO_TOPOLOGY = """(async () => {
  const st = await import('/store.js');
  const { store } = window.__linux_xtu;
  st.setPreflight(store, { ...(store.get().preflight || {}), topology: null });
  return true;
})()"""
QUIET = ("eval", "(async () => { const st = await import('/store.js'); st.setPref(window.__linux_xtu.store, 'hints', 'quiet'); return true; })()")
# Edit point 4 (ratio 48) of P0 to -20 mV; the page commits a field on Enter/change.
EDIT_P0 = [WRITABLE, ("click", P0), ("pump", 0.6), ("type", P0_ROW48, "-20"), ("pump", 0.6)]
# ... and open the commit sheet, wait for its Apply button.
OPEN_REVIEW = [("click", "#pending-review"), ("wait", "#apply-go"), ("pump", 0.8)]
# ... and press Apply (the mock plays the shell's native dialog: yes after a moment, `confirm=` knob), wait for the result box.
RUN_APPLY = [("click", "#apply-go"), ("wait", "#apply-outcome"), ("pump", 1.5)]
# R-S3: the commit sheet's states. Power + caps edits through the store (the runtime tabs' own markup is R-S2's), then the pending row's Review.
RUNTIME_EDITS = ("eval", """(async () => {
  const rk = await import('/views/tune/runtime-kinds.js');
  const rs = await import('/lib/rtstate.js');
  const { store, bridge } = window.__linux_xtu;
  rs.ensureRt(store);
  await rk.loadRead(store, bridge, 'power');
  await rk.loadRead(store, bridge, 'runtime');
  rs.editRt(store, (e) => ({ ...e, power: { pl1_w: 200 }, caps: { EC0: 44 } }));
  return true;
})()""")
# retype P0's 48x point after the plan: the plan no longer matches the edits on screen (F-05)
RETYPE_P0 = [("eval", "document.querySelector('#drawer-close') && document.querySelector('#drawer-close').click(), true"), ("pump", 0.4),
             ("type", P0_ROW48, "-25"), ("pump", 0.4), ("eval", "(async () => { (await import('/store.js')).openDrawer(window.__linux_xtu.store, 'Review'); return true; })()"), ("pump", 0.8)]
TUNE_READY = TILES
# R-S5: answer the next profiles.get with the R-B1 shape (ring, power, caps, uncore, version) plus a key this UI does not know, then pick that profile.
SECTIONS = """(async () => {
  const { bridge } = window.__linux_xtu;
  const orig = bridge.call.bind(bridge);
  bridge.call = async (op, a) => {
    const r = await orig(op, a);
    if (op === 'profiles.get' && r.ok && r.result.contents.rows[0]) Object.assign(r.result.contents.rows[0], { offset: null, layers: { curve_mv: -10, points_mv: { 48: -20, 53: -25 } } });
    if (op === 'profiles.get' && r.ok) Object.assign(r.result.contents, { ring: { oc_word: '0x00000000', points: { 1: 0, 2: -10, 3: -10 } }, power: { pl1_w: 200, pl2_w: 250, tau_s: 28 }, caps: { P0: 57, EC0: 46 }, uncore: { min_ratio: 8, max_ratio: 39 }, version: 2, fan_curve: { mode: 'quiet' } });
    return r;
  };
  const st = await import('/store.js');
  const { store } = window.__linux_xtu;
  st.setScreen(store, 'system');
  await new Promise((r) => setTimeout(r, 100));
  st.setScreen(store, 'profiles');
  return true;
})()"""
BOOT_RESTORE = """(async () => {
  const st = await import('/store.js');
  const { store } = window.__linux_xtu;
  st.setPreflight(store, { ...store.get().preflight, boot_restore: { state: 'disarmed', note: 'stopped after 3 restarts in a row; the next clean boot re-arms it' } });
  return true;
})()"""
AUDIT_EMPTY = """(() => {
  const { bridge } = window.__linux_xtu;
  const orig = bridge.call.bind(bridge);
  bridge.call = (op, a) => op === 'audit.tail' ? Promise.resolve({ ok: true, result: { records: [], path: '/var/lib/linux-xtu/audit.jsonl', truncated: false } }) : orig(op, a);
  document.querySelector('[data-audit=refresh]').click();
  return true;
})()"""

# R-S2: Tune › Frequency replaces "Turbo ratios" + "Ratio caps". Until the Tune tab list points a "frequency" tab at views/tune/frequency.js, the
# capture points the turbo tab's module at it (SUBTAB_MODULES is the tab wiring of views/tune.js; nothing else changes) and opens whichever tab exists.
FREQ_OPEN = ("eval", """(async () => {
  const t = await import('/views/tune.js');
  if (!t.SUBTAB_MODULES.frequency) t.SUBTAB_MODULES.turbo.path = './tune/frequency.js';
  (document.getElementById('subtab-frequency') || document.getElementById('subtab-turbo')).click();
  return true;
})()""")
FREQ = [FREQ_OPEN, ("wait", "[data-view='frequency'] [data-panel='turbo']"), ("pump", 1.5)]
P_BUCKET = "[data-panel='turbo'][data-kind='P'] [data-bucket='{}'] input"
PWR = "[data-view='power']"
UNC = "[data-view='uncore']"


def _sub(tab: str, name: str, **kw) -> State:
    return State(name, "#/tune", steps=[("click", f"#subtab-{tab}"), ("pump", 1.5)], ready=TILES, full=True, **kw)


STATES: list[State] = [
    # --- Dashboard ---
    State("dashboard", "#/dashboard", Q_MOTION, settle=5, full=True, note="live telemetry (invented waveform)"),
    State("dashboard-na", "#/dashboard", settle=3, note="no motion: honest n/a fixtures, said once per table"),
    State("dashboard-notopology", "#/dashboard", Q_MOTION, ready="#ov-units", steps=[("pump", 1), ("eval", NO_TOPOLOGY), ("pump", 0.6)], note="preflight without a topology: the units' empty state"),
    State("writes-popover", "#/dashboard", Q_MOTION, steps=[("pump", 1), ("click", "#ann-writes"), ("pump", 0.4)], note="top-bar annunciator popover: why writes are off"),
    State("accepted-differs", "#/tune", Q_MOTION + "&profiles=accepted", ready=TILES, steps=EDIT_P0 + [("eval", DIFFERS), ("eval", "document.getElementById('read-btn').focus(), true"), ("pump", 0.3)],
          note="ACCEPTED differs + Restore accepted…, the context line explains the focused Read"),
    State("readout-expanded", "#/dashboard", Q_MOTION, steps=[("pump", 3), ("click", "#ro-pkg_power"), ("pump", 0.6)], note="readout bar expanded: 60 s sparklines for all six values"),
    State("throttle-popover", "#/dashboard", Q_MOTION,
          steps=[("pump", 2), ("eval", THROTTLE_SETUP), ("pump", 1), ("click", "#limits-pl1"), ("pump", 0.5)], note="LIMITS popover from the readout bar, PL1/PL2 + Turbo lit"),
    # --- Tune ---
    State("tune-cores-empty", "#/tune", Q_MOTION, ready=TILES, note="Cores tab as opened: the first P-core selected"),
    State("tune-cores-p0", "#/tune", Q_MOTION, ready=TILES, steps=[("click", P0), BLUR, ("pump", 0.8)], full=True, note="P0 selected, V/F table"),
    State("tune-cores-pending", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + [FOCUS_ROW48, ("pump", 0.3)], full=True, note="P0 point 4 edited to -20 mV, pending row, field focused (plot cursor at 48x)"),
    State("tune-cores-curve", "#/tune", Q_MOTION, ready=TILES, steps=[WRITABLE, ("click", P0), ("type", "[data-curve='P'] input", "-10"), ("pump", 0.4)], note="whole-curve offset -10 mV: its own layer, adds to every point"),
    State("tune-cores-refused", "#/tune", Q_MOTION, ready=TILES, steps=[("click", P0), ("type", P0_ROW48, "-1200"), ("pump", 0.3)], note="a typed offset below the field floor refused in place, text kept"),
    State("tune-cores-positive", "#/tune", Q_MOTION, ready=TILES, steps=[("click", P0), ("type", P0_ROW48, "5"), ("pump", 0.3)], note="a positive offset refused in place (D-053 §5)"),
    State("tune-cores-both-layers", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + [("type", "[data-curve='P'] input", "-10"), ("pump", 0.3)], note="whole curve + points on one unit refused in place (one offset kind per apply)"),
    State("tune-cores-multi", "#/tune", Q_MOTION, ready=TILES, steps=[("click", P0), MODCLICK("P3", "ctrlKey"), MODCLICK("P5", "shiftKey"), ("pump", 0.6)], note="multi-select: Ctrl-click P3, Shift-click P5 = P3–P5, one section"),
    State("tune-cores-pe", "#/tune", Q_MOTION, ready=TILES, steps=[("click", P0), MODCLICK("EC1", "ctrlKey"), ("pump", 0.6)], note="P and E selected: two sections"),
    State("tune-cores-ring", "#/tune", Q_MOTION, ready=TILES, steps=[("click", "[data-unit-table] tr[data-unit='ring']"), BLUR, ("pump", 0.6)], full=True, note="the ring: points by number, no voltages, no OC band"),
    State("tune-cores-oc", "#/tune", Q_MOTION, ready=TILES, steps=[WRITABLE, ("click", "[data-unit-table] tr[data-unit='P1']"), ("type", "[data-oc-band='P'] [data-oc='ratio'] input", "58"), ("scroll", "[data-whys='oc-P']"), ("pump", 0.4)], full=True, note="OC ratio 58x on P1: the OC point row, its target, D-050 note"),
    State("tune-cores-oc-notmeasured", "#/tune", Q_MOTION, ready=TILES, steps=[WRITABLE, ("click", "[data-unit-table] tr[data-unit='P1']"), ("type", "[data-oc-band='P'] [data-oc='ratio'] input", "60"), ("type", "[data-vf-table='P'] tr[data-ratio='57'] input", "-20"), ("type", "[data-oc-band='P'] [data-oc='voltage'] input", "1.250"), ("scroll", "[data-whys='oc-P']"), ("pump", 0.4)], note="OC point with a lifted target and an unmeasured line: flagged, never a confident number"),
    State("tune-hints-quiet", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + [QUIET, ("pump", 0.3)], note="Hints: quiet (no context line)"),
    State("tune-read-confirm", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + [("click", "#read-btn"), ("pump", 0.3)], note="Read with an edit asks first (inline confirm in the top bar)"),
    State("tune-readonly", "#/tune", Q_MOTION, ready=TILES, steps=[("click", P0), ("pump", 0.6), ("type", P0_ROW48, "-20"), ("pump", 0.6)], note="read-only preflight: Review gated with its reason"),
    State("tune-noread", "#/tune", Q_MOTION, ready=TILES, steps=[("eval", NO_READ), ("pump", 0.5)], note="no read this boot: the teaching empty state with Read"),
    State("tune-cores-uvp", "#/tune", Q_MOTION, ready=TILES, steps=[("click", P0), ("eval", "(async () => { (await import('/store.js')).setUvp(window.__linux_xtu.store, 'on'); return true; })()"), ("pump", 0.4)], note="Undervolt Protection on: offset fields locked, the reason said once"),
    State("tune-cores-ec0", "#/tune", Q_MOTION, ready=TILES, steps=[("click", "[data-unit-table] tr[data-unit='EC0']"), BLUR, ("pump", 0.6)], full=True, note="E cluster 0 selected: one unit of four CPUs"),
    State("tune-cores-offline", "#/tune", Q_MOTION + "&offline=3", ready=TILES, steps=[("click", P0), ("pump", 0.6)], note="CPU 3 reads offline"),
    State("tune-cores-nolimits", "#/tune", Q_MOTION + "&cpulimits=unread", ready=TILES, steps=[("click", P0), ("pump", 0.6)], note="CPU limits not read yet"),
    State("tune-cores-nobaseline", "#/tune", Q_MOTION + "&baseline=none", ready=TILES, steps=[("click", P0), ("pump", 0.6)], note="no stored baseline curve"),
    _sub("turbo", "tune-turbo", query=Q_MOTION, note="deprecated Turbo ratios tab (until the Frequency tab is wired)"),
    State("tune-frequency", "#/tune", Q_MOTION, ready=TILES, steps=FREQ, full=True, note="Frequency: top ratio, cap and clock per unit; turbo tables P and E with their computed lines"),
    State("tune-frequency-edit", "#/tune", Q_MOTION, ready=TILES, steps=FREQ + [("type", P_BUCKET.format(2), "53"), ("pump", 0.4), ("type", "[data-cap='EC1'] input", "46"), ("pump", 0.6)],
          full=True, note="bucket 3 lowered (4..8 follow, said in place), EC1 capped: the computed turbo lines follow"),
    State("tune-frequency-refused", "#/tune", Q_MOTION, ready=TILES, steps=FREQ + [("type", P_BUCKET.format(3), "57"), ("pump", 0.6)],
          note="turbo order refused in the field: 4 busy may not exceed 3 busy, typed text kept"),
    State("tune-frequency-oc", "#/tune", Q_MOTION, ready=TILES,
          steps=[("eval", """(async () => { const t = await import('/views/tune.js'); const d = await import('/lib/draft.js'); const { store } = window.__linux_xtu;
            const s = store.get().tune; t.patchTune(store, { draft: d.setOcRatio(s.model, s.draft, ['P1'], 58) }); return true; })()""")] + FREQ,
          note="OC 58× on P1 above the 57× table: info line, the turbo line stays 57×"),
    _sub("power", "tune-power", query=Q_MOTION),
    State("tune-power-refused", "#/tune", Q_MOTION, ready=TILES, steps=[("click", "#subtab-power"), ("wait", PWR + " [data-key='pl1_w'] input"), ("pump", 1.2),
          ("type", PWR + " [data-key='pl1_w'] input", "300"), ("pump", 0.6)], note="PL1 above PL2 refused in place, typed text kept"),
    _sub("power", "tune-power-locked", query=Q_MOTION + "&locked=1", note="PL register lock bit set"),
    _sub("ring", "tune-ring", query=Q_MOTION),
    State("tune-ring-refused", "#/tune", Q_MOTION, ready=TILES, steps=[("click", "#subtab-ring"), ("wait", UNC + " [data-key='min_ratio'] input"), ("pump", 1.2),
          ("type", UNC + " [data-key='max_ratio'] input", "20"), ("pump", 0.4), ("type", UNC + " [data-key='min_ratio'] input", "30"), ("pump", 0.6)],
          note="maximum lowered to 20× (an edit), then a minimum of 30× refused in place: above the maximum"),
    # --- the commit sheet (R-S3, DESIGN.md §5.10) ---
    State("review-ready", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + OPEN_REVIEW, note="sheet open, plan ready, focus on Close, keep plan"),
    State("review-multi", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + [RUNTIME_EDITS, ("pump", 0.5)] + OPEN_REVIEW,
          note="V/F + power + caps in one review: grouped diff, amber warnings apart from the notes"),
    State("review-confirming", "#/tune", "tick=200&confirm=hold", ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + [("click", "#apply-go"), ("wait", "#apply-tag[data-state='confirming']"), ("pump", 0.4)],
          note="the shell's native dialog is open (mock: never answers)"),
    State("review-applying", "#/tune", "tick=200&step=350", ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + [("click", "#apply-go"), ("wait", "#apply-progress"), ("pump", 1.2)],
          note="writing: orange progress rule, live status column, Stop after this write"),
    State("review-applied", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + RUN_APPLY, note="applied, read back OK, the two shortcuts"),
    State("review-refused-uvp", "#/tune", "tick=200&uvp=on", ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + RUN_APPLY, note="BIOS Undervolt Protection refuses the offset"),
    State("review-mismatch", "#/tune", "tick=200&apply=mismatch", ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + RUN_APPLY, note="read-back word differs: the planned / read-back table"),
    State("review-stale", "#/tune", "tick=200&apply=stale", ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + RUN_APPLY, note="plan stale at the helper, Review again offered"),
    State("review-outdated", "#/tune", "tick=200", ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + RETYPE_P0, note="the edit changed after the plan (F-05): Apply locked, Review again"),
    State("review-nothing-written", "#/tune", "tick=200&confirm=no", ready=TILES, steps=EDIT_P0 + OPEN_REVIEW + [("click", "#apply-go"), ("wait", "#apply-outcome"), ("pump", 0.6)],
          note="Cancel in the system dialog: nothing was written, the plan stays"),
    # --- other screens ---
    State("curves", "#/curves", Q_MOTION, settle=2.5, full=True, note="Chart: stored baseline, P/E ramps with direct labels"),
    State("curves-nobaseline", "#/curves", "tick=200&baseline=none", settle=2.5, note="no stored curves: the teaching empty state"),
    State("curves-table", "#/curves", Q_MOTION, ready="#cv-tab-table", steps=[("pump", 1.5), ("click", "#cv-tab-table"), ("pump", 0.5)], note="Table: volts per ratio"),
    State("curves-library", "#/curves", Q_MOTION, ready="#cv-tab-library", steps=[("pump", 1.5), ("click", "#cv-tab-library"), ("pump", 0.5)], note="Library: baseline only for complete stock curves"),
    State("curves-measuring", "#/curves", Q_MOTION, ready="#btn-measure", steps=[("pump", 1.5), ("click", "[data-quick='P-cores']"), SLOW_REPLAY, ("click", "#btn-measure"), ("pump", 7)], settle=0.3, note="Measure running: live vf.point points"),
    State("stress", "#/stress", Q_MOTION, settle=2.5, full=True, note="setup, units, idle live panel, history"),
    State("stress-edits", "#/tune", Q_MOTION, ready=TILES, steps=EDIT_P0 + [("eval", "(location.hash = '#/stress', true)"), ("pump", 1.5)], note="Tune holds an edit: the run would not test it"),
    State("stress-running", "#/stress", Q_MOTION, ready="#btn-stress-start", steps=[("pump", 1.5), SLOW_REPLAY, ("click", "#btn-stress-start"), ("pump", 2.6)], settle=0.3, note="a screen running: timer, plots"),
    State("stress-result", "#/stress", Q_MOTION, ready="#btn-stress-start", steps=[("pump", 1.5), ("click", "#btn-stress-start"), ("wait", "#st-sum"), ("pump", 0.8)], note="result stated plainly with the next step"),
    State("profiles", "#/profiles", Q_MOTION, settle=2.5, full=True),
    State("profiles-none", "#/profiles", "tick=200&profiles=none", settle=2.5, note="empty library"),
    State("profiles-accepted", "#/profiles", "tick=200&profiles=accepted", settle=2.5, full=True, note="an accepted state exists: Restore, Windows apply"),
    # R-S5 states: Save form, the accept confirm (diff + evidence), a profile with the R-B1 runtime sections, the Hints-quiet look
    State("profiles-save", "#/profiles", "tick=200", ready="[data-pr='save-edits']", steps=[("pump", 1.5), ("click", "[data-pr='save-edits']"), ("type", "[data-pr='name']", "my-undervolt"), ("pump", 0.4)], note="Save Tune edits as…: the name row and its gate"),
    State("profiles-accept-ask", "#/profiles", "tick=200&profiles=accepted&diff=extras", ready="[data-pr='accept-read']", steps=[("pump", 1.5), ("click", "[data-pr='accept-read']"), ("wait", "[data-pr='ask-yes']"), ("pump", 0.4)], note="Set CPU state as accepted…: inline confirm with the helper's diff and evidence"),
    State("profiles-sections", "#/profiles", "tick=200", ready="[data-pr='save-edits']", steps=[("pump", 1.5), ("eval", SECTIONS), ("pump", 0.8), ("scroll", "[data-section='power']")], note="a profile with both offset layers on P0, ring, power, caps, uncore and an unknown section (R-B1 shape, injected)"),
    State("system", "#/system", Q_MOTION, settle=2.5, full=True),
    State("system-boot-restore", "#/system", "tick=200", steps=[("pump", 1.5), ("eval", BOOT_RESTORE), ("pump", 0.4)], note="preflight with the optional boot_restore field: the status panel appears"),
    State("audit", "#/audit", Q_MOTION, settle=2.5, full=True),
    State("audit-open", "#/audit", "tick=200", ready="[data-op]", steps=[("click", "[data-op='310']"), ("pump", 0.3), ("click", "[data-raw='310:4']"), ("pump", 0.4)], note="an operation opened to its raw rows, one raw record shown"),
    State("audit-empty", "#/audit", "tick=200", ready="[data-op]", steps=[("eval", AUDIT_EMPTY), ("pump", 0.6)], note="an empty audit log: the teaching empty state"),
    State("tips", "#/tips", Q_MOTION, settle=1.5, full=True, note="Tips: path, reading column, diagrams"),
    State("tips-power", "#/tips/power", Q_MOTION, settle=1.5, note="Tips opened at a section (F1 / More in Tips)"),
    # --- link / setup states (helper not usable) ---
    State("setup-not-installed", "#/dashboard", "helper=not_installed", settle=1.5, note="Setup screen: helper not installed"),
    State("setup-not-allowed", "#/dashboard", "helper=not_allowed", settle=1.5, note="Setup screen: user not allowed"),
    State("setup-version", "#/dashboard", "tick=200&helper=version", ready="[data-setup='versions']", settle=1.5, note="helper of another protocol: what differs, the reinstall command, Retry, Continue read-only"),
    State("system-version", "#/system", "tick=200&helper=version", ready="[data-setup='continue']", steps=[("click", "[data-setup='continue']"), ("wait", "#sys-banner"), ("pump", 1.5)],
          note="after Continue read-only: System says writes are off and reading works"),
    State("link-busy", "#/dashboard", "helper=busy", settle=1.5, note="helper busy"),
    State("link-error", "#/dashboard", "helper=error", settle=1.5, note="helper error / disconnected"),
    State("no-runtime", "#/dashboard", mock=False, settle=1.5, note="plain browser, no bridge: status bar says no desktop runtime"),
]
NAMES = [s.name for s in STATES]
assert len(set(NAMES)) == len(NAMES)


# ---------------------------------------------------------------------------------------------------------------------------------------
# Serving ui/ with the shipped CSP
# ---------------------------------------------------------------------------------------------------------------------------------------
def csp() -> str:
    return json.loads((UI.parent / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["app"]["security"]["csp"]


class Handler(http.server.SimpleHTTPRequestHandler):
    CSP = ""

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", self.CSP)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a) -> None:
        pass


@contextlib.contextmanager
def serve():
    handler = type("CspHandler", (Handler,), {"CSP": csp()})
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(handler, directory=str(UI)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


# ---------------------------------------------------------------------------------------------------------------------------------------
# Browser driver
# ---------------------------------------------------------------------------------------------------------------------------------------
class StateFailure(Exception):
    pass


class Chrome:
    def __init__(self, chrome: str, origin: str):
        self.origin = origin
        self.profile = tempfile.mkdtemp(prefix="arl-visual-")
        args = [chrome, "--headless=new", "--remote-debugging-pipe", f"--user-data-dir={self.profile}", "--no-first-run", "--no-default-browser-check",
                "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "--disable-background-networking", "--disable-sync",
                "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--window-size=1280,800", "about:blank"]
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            args.insert(1, "--no-sandbox")
        self.proc, self.ws = spawn_chrome_pipe(args)
        self._id = 0
        self._n = 0
        self.session: str | None = None
        self.errors: list[str] = []
        targets = self.call("Target.getTargets")["targetInfos"]
        page = next((t["targetId"] for t in targets if t.get("type") == "page"), None) or self.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.session = self.call("Target.attachToTarget", {"targetId": page, "flatten": True})["sessionId"]
        for m in ("Page.enable", "Runtime.enable", "Log.enable", "Network.enable"):
            self.call(m)
        # a headless page never has focus, so focus / focusin would not fire: the context line, the sheet's initial focus and the popovers need them
        self.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
        # every page: record CSP violations the console may not carry
        self.call("Page.addScriptToEvaluateOnNewDocument", {"source": "document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' blocked ' + e.blockedURI));"})

    # -- transport --
    def call(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method, "params": params or {}}
        if self.session and not method.startswith("Target.") and not method.startswith("Browser."):
            msg["sessionId"] = self.session
        self.ws.send_text(json.dumps(msg))
        end = time.monotonic() + timeout
        while True:
            raw = self.ws.recv_text(max(0.05, end - time.monotonic()))
            if raw is None:
                if time.monotonic() > end:
                    raise ToolError(method + " timed out")
                continue
            m = json.loads(raw)
            if m.get("id") == mid:
                if "error" in m:
                    raise ToolError(f"{method}: {m['error']}")
                return m.get("result", {})
            self._event(m)

    def _event(self, m: dict) -> None:
        method, p = m.get("method"), m.get("params", {})
        if method == "Runtime.exceptionThrown":
            d = p["exceptionDetails"]
            self.errors.append("exception: " + str((d.get("exception") or {}).get("description") or d.get("text"))[:300])
        elif method == "Runtime.consoleAPICalled" and p.get("type") in ("error", "assert"):
            self.errors.append("console.error: " + " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))[:300])
        elif method == "Log.entryAdded" and p["entry"].get("level") == "error":
            e = p["entry"]
            self.errors.append(f"log[{e.get('source')}]: {e.get('text', '')} {e.get('url', '')}"[:300])
        elif method == "Network.requestWillBeSent":
            url = p["request"]["url"]
            if not re.match(r"(http://127\.0\.0\.1[:/]|data:|blob:|about:)", url):
                self.errors.append("network: request to non-loopback URL " + url[:200])
        elif method == "Network.loadingFailed" and not p.get("canceled"):
            self.errors.append("network: request failed: " + str(p.get("errorText")))

    def pump(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            raw = self.ws.recv_text(0.05)
            if raw:
                self._event(json.loads(raw))

    def ev(self, expr: str):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise StateFailure("js: " + str((d.get("exception") or {}).get("description") or d.get("text"))[:200])
        return r["result"].get("value")

    def wait(self, expr: str, timeout: float = 10.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                if self.ev(expr):
                    return True
            except StateFailure:
                pass
            self.pump(0.1)
        return False

    # -- actions --
    def size(self, w: int, h: int) -> None:
        self.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})

    def goto(self, url: str) -> None:
        self._n += 1
        # the app asks before a reload / close with pending edits (its close guard); the harness leaving a state is not the user leaving.
        # UI preferences (Hints quiet, readout expanded) persist in localStorage: every state starts from the defaults.
        with contextlib.suppress(Exception):
            self.ev("(() => { const a = window.__linux_xtu; if (a) a.store.set({ pending: { changes: 0, units: 0 } }); localStorage.clear(); return true; })()")
        base, _, frag = url.partition("#")
        self.call("Page.navigate", {"url": "about:blank"})  # fresh document even when only the hash differs
        self.pump(0.05)
        self.call("Page.navigate", {"url": f"{base}{'&' if '?' in base else '?'}_n={self._n}" + (f"#{frag}" if frag else "")})

    def require(self, css: str, timeout: float = 8.0) -> None:
        if not self.wait(f"!!document.querySelector({json.dumps(css)})", timeout):
            raise StateFailure(f"element not found: {css}")

    def click(self, css: str) -> None:
        self.require(css)
        ok = self.ev(f"(() => {{ const e = document.querySelector({json.dumps(css)}); e.scrollIntoView({{block:'nearest'}}); e.click(); return true; }})()")
        if not ok:
            raise StateFailure(f"click failed: {css}")
        self.pump(0.25)

    def type(self, css: str, value: str) -> None:
        self.require(css)
        self.ev("""(([sel, val]) => { const e = document.querySelector(sel); e.focus(); e.value = val;
          e.dispatchEvent(new Event('input', {bubbles:true}));
          e.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
          e.dispatchEvent(new Event('change', {bubbles:true})); e.blur(); return true; })(%s)""" % json.dumps([css, value]))
        self.pump(0.3)

    def seg(self, text: str) -> None:
        if not self.wait(f"[...document.querySelectorAll('.seg-btn')].some((e) => e.textContent.trim() === {json.dumps(text)})", 8):
            raise StateFailure(f"segment button not found: {text}")
        self.ev(f"[...document.querySelectorAll('.seg-btn')].find((e) => e.textContent.trim() === {json.dumps(text)}).click()")
        self.pump(0.25)

    def shot(self, path: Path, full: bool = False, size: tuple[int, int] | None = None) -> None:
        if full:
            w, sh, ch, ih = self.ev("(() => { const s = document.getElementById('screen'); return [document.documentElement.clientWidth, s.scrollHeight, s.clientHeight, window.innerHeight]; })()")
            if sh > ch:
                self.size(w, ih + (sh - ch))
                self.pump(0.5)
        data = self.call("Page.captureScreenshot", {"format": "png"})["data"]
        path.write_bytes(base64.b64decode(data))
        if full and size:
            self.size(*size)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.call("Browser.close", timeout=5)
        with contextlib.suppress(Exception):
            self.proc.wait(5)
        with contextlib.suppress(Exception):
            self.proc.kill()
        self.ws.close()
        shutil.rmtree(self.profile, ignore_errors=True)


def render(b: Chrome, s: State, tag: str, size: tuple[int, int], out: Path, num: int, full: bool = True) -> list[str]:
    """Render one state at one size. Returns the problems (empty = fine)."""
    b.errors.clear()
    problems: list[str] = []
    try:
        b.size(*size)
        b.goto(f"{b.origin}/index.html?" + ("bridge=mock&" + s.query if s.mock else s.query or "x=1") + s.hash)
        if not b.wait("document.documentElement.dataset.ready === '1'", 15):
            raise StateFailure("page never became ready (data-ready)")
        if s.ready:
            b.require(s.ready, 10)
        for step in s.steps:
            op, args = step[0], step[1:]
            if op == "click":
                b.click(*args)
            elif op == "type":
                b.type(*args)
            elif op == "seg":
                b.seg(*args)
            elif op == "wait":
                b.require(*args)
            elif op == "scroll":
                b.require(args[0])
                b.ev(f"document.querySelector({json.dumps(args[0])}).scrollIntoView({{block:'center'}})")
            elif op == "eval":
                b.ev(args[0])
            elif op == "pump":
                b.pump(args[0])
            else:
                raise StateFailure("unknown step " + op)
        b.pump(s.settle)
        content = b.ev("(() => { const s = document.getElementById('screen'); return s ? s.children.length + ':' + (s.dataset.screen || '') : '-'; })()")
        if not content or content.startswith("0:") or content == "-":
            raise StateFailure("#screen is empty")
        b.shot(out / f"{tag}-{num:02d}-{s.name}.png")
        if s.full and full and tag == "1280":
            b.shot(out / f"{tag}-{num:02d}-{s.name}-full.png", full=True, size=size)
    except (StateFailure, ToolError) as e:
        problems.append(f"{e}")
        with contextlib.suppress(Exception):  # keep what the page looked like when the step failed
            b.shot(out / f"{tag}-{num:02d}-{s.name}-FAILED.png")
    b.pump(0.1)
    allowed = [re.compile(a) for a in s.allow]
    # Chrome asks for /favicon.ico on its own; the desktop shell never does, so that 404 is not a page error.
    problems += [e for e in dict.fromkeys(b.errors) if not e.endswith("/favicon.ico") and not any(a.search(e) for a in allowed)]
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Render every desktop UI screen headlessly (mock bridge) and report render / console errors.")
    ap.add_argument("--out", help="directory for the PNGs (created)")
    ap.add_argument("--only", nargs="+", metavar="NAME", help="render only these states (see --list)")
    ap.add_argument("--list", action="store_true", help="list the states and exit")
    ap.add_argument("--sizes", default="1280,960", help="comma list of 1280, 960, 1920, 2560 (default 1280,960)")
    ap.add_argument("--check", action="store_true", help="smoke mode: all states at 1280x800 into a temp dir; fail only on render/console errors")
    ap.add_argument("--chrome", help="path of the Chrome/Chromium binary")
    a = ap.parse_args(argv)

    if a.list:
        for i, s in enumerate(STATES, 1):
            print(f"{i:2d}  {s.name:28s} {s.hash:12s} ?{s.query if s.mock else '(no bridge)'}   {s.note}")
        return 0
    chosen = STATES
    if a.only:
        bad = [n for n in a.only if n not in NAMES]
        if bad:
            print("unknown state(s): " + ", ".join(bad) + "  (see --list)", file=sys.stderr)
            return 2
        chosen = [s for s in STATES if s.name in a.only]
    sizes = [x for x in a.sizes.split(",") if x]
    if any(x not in SIZES for x in sizes):
        print("--sizes takes 1280, 960, 1920 and/or 2560", file=sys.stderr)
        return 2
    if a.check:
        sizes = ["1280"]
    try:
        chrome = find_chrome(a.chrome)
    except ToolError as e:
        print(f"visual_capture: SKIPPED, {e}")
        return 0
    if not a.check and not a.out:
        print("--out DIR is required (or use --list / --check)", file=sys.stderr)
        return 2

    tmp = tempfile.mkdtemp(prefix="arl-visual-out-") if a.check else None
    out = Path(tmp or a.out)
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    failures: dict[str, list[str]] = {}
    count = 0
    try:
        with serve() as origin:
            b = Chrome(chrome, origin)
            try:
                for tag in sizes:
                    size = SIZES[tag]
                    for s in chosen:
                        num = NAMES.index(s.name) + 1
                        t0 = time.monotonic()
                        probs = render(b, s, tag, size, out, num, full=not a.check)
                        count += 1
                        key = f"{tag}/{s.name}"
                        print(f"{'FAIL' if probs else 'ok  '} {key:40s} {time.monotonic() - t0:5.1f}s", flush=True)
                        for p in probs:
                            print("       " + p)
                        if probs:
                            failures[key] = probs
            finally:
                b.close()
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"{count} renders ({len(chosen)} states x {len(sizes)} size(s)) in {time.monotonic() - started:.0f}s, {len(failures)} with problems"
          + ("" if a.check else f"; PNGs in {out}"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
