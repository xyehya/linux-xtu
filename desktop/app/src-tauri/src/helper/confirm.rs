//! Human presence for writes (D-053 item 4; assessment 2026-11-11 F-06): the webview can plan, but it cannot write on its own.
//!
//! * A plan's confirmation code (`nonce`) stays in the shell: [`super::link::Link`] keeps it from the `*.plan` answer and
//!   [`super::link::public_response`] removes it from everything the webview receives.
//! * `app.confirm {plans: [{op, plan_id}, ...]}` (a shell op, never sent to the helper) shows ONE native dialog built from the shell's own
//!   copy of those plans (write count, what they touch). Only the operator's click on its write button approves them ([`confirm_plans`]).
//!   `*.apply {plan_id}` from the webview is then sent ([`apply_confirmed`]) only for an approved plan of this connection, with
//!   `typed: "CONFIRM <nonce>"` added here; spent on use. A `typed` from the webview is refused.
//! * A persistent op (`ops::PERSIST_OPS`: `profiles.accept`, `profiles.fingerprint`) shows its own dialog when the webview sends it and is
//!   sent only on the OK ([`persist_confirmed`]); a two-step accept is completed by the shell. Fail closed against either helper protocol.
//! * The dialog ([`Confirmer`]) is the GTK message dialog of `native.rs`: modal, presented with Cancel focused and the default, the write button
//!   insensitive for [`ARM_DELAY`] after the dialog is mapped ([`Arming`]; a focus it held and then lost disarms it again). [`GatedConfirmer`] allows one dialog at a time and none
//!   for [`COOLDOWN`] after a Cancel ([`ConfirmGate`]). A webview cannot click a native window: it reaches the shell only through `invoke`.
//! * What the dialog says (R-I1, review finding MEDIUM "the human never sees the values"): every value a plan writes, from the shell's own
//!   copy of the plan ([`item_of`]). V/F: one line per written point (`P0 · point 5 · 53× · offset 0 → −19.5 mV`), the whole-curve layer
//!   apart (`EC1 · whole curve · offset 0 → −30.3 mV`), the OC point (`P2 · OC point · ratio unset → 58× · target unset → 1.250 V`), each
//!   turbo table bucket by bucket; lines that raise a voltage (a positive offset, a higher OC target) come first, marked `↑`, and the dialog
//!   says how many there are even when the list is cut ([`MAX_TUNE_LINES`]). A written value the plan does not describe — an unknown step,
//!   a point without its after-value, a turbo table whose new ratios the shell cannot name, a step list the helper cut — fails closed: no
//!   dialog, no approval (`CONFIRM_UNAVAILABLE`). `ui/fixtures/mock-backend.js` builds the same text (held to it by the contract samples).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::link::{public_response, ApplyError, ApplyRefusal, Link, PlanRecord, Reply};
use super::ops::{self, PlanKind};
use super::{error_reply, started_reply};

/// Targets named in the dialog per item before "and N more" (power, caps and uncore).
const MAX_TARGETS: usize = 8;
/// Value lines of the V/F item before "and N more, all listed in the review" (voltage raises first).
pub const MAX_TUNE_LINES: usize = 12;
/// The mark of a line that raises a voltage.
pub const RAISE_MARK: &str = "↑ ";
/// The dialog's write button becomes sensitive only after the dialog has held the focus this long (a click or Enter aimed at the page
/// a moment earlier cannot land on it).
pub const ARM_DELAY: Duration = Duration::from_millis(700);
/// After a Cancel, `app.confirm` and the persistent ops are refused this long (no dialog storm).
pub const COOLDOWN: Duration = Duration::from_secs(2);

/// What a dialog line is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject {
    Plan(PlanKind),
    Accept,
    Fingerprint,
}

/// One line of the dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmItem {
    pub subject: Subject,
    /// What it changes, in operator words ("V/F and ratio words", "Power limits", ...).
    pub label: String,
    /// CPU register / sysfs writes (0 for a persistent op: it writes a record, not the CPU).
    pub writes: u64,
    /// What it writes: V/F — every value line, voltage raises first (cut to [`MAX_TUNE_LINES`] only in the text); power, caps and uncore —
    /// "PL1 200 W", "cpu 8–11 max 22×", ..., at most [`MAX_TARGETS`] + a count; a persistent op — what it records.
    pub targets: Vec<String>,
    /// How many of `targets` (the first ones) raise a voltage.
    pub raises: usize,
    /// Writes sent only when needed (the per-core voltage enable: `conditional: true` in the plan's steps). NOT part of `writes`.
    pub conditional: u64,
    /// G-248: the most extra writes a restore's apply may send when it finds a leftover OC point (`residual_writes_max` of the plan; 0 for a helper that does not say).
    /// NOT part of `writes` and not listed in the steps: the apply decides from its own reads, so the dialog says "up to N".
    pub residual_max: u64,
}

/// What the operator is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmRequest {
    pub items: Vec<ConfirmItem>,
}

/// The operator's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// The write button was clicked.
    Yes,
    /// Cancel, Escape or the window's close button.
    No,
    /// No dialog could be shown (no window, the app is quitting): nothing is approved.
    Unavailable(String),
    /// Not shown: another dialog is open, or a Cancel was a moment ago ([`ConfirmGate`]).
    Busy(String),
}

/// Shows the confirmation and waits for the human. Called from a worker thread (never the main thread).
pub trait Confirmer: Send + Sync + 'static {
    fn confirm(&self, req: &ConfirmRequest) -> Answer;
}

/// A confirmer with a fixed answer that records what it was asked (tests; with `Unavailable`, the safe default when there is no UI).
pub struct FixedConfirmer {
    answer: Answer,
    asked: Mutex<Vec<ConfirmRequest>>,
}

impl FixedConfirmer {
    pub fn new(answer: Answer) -> FixedConfirmer {
        FixedConfirmer { answer, asked: Mutex::new(Vec::new()) }
    }

    /// Every request shown so far.
    pub fn asked(&self) -> Vec<ConfirmRequest> {
        self.asked.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl Confirmer for FixedConfirmer {
    fn confirm(&self, req: &ConfirmRequest) -> Answer {
        self.asked.lock().unwrap_or_else(|p| p.into_inner()).push(req.clone());
        self.answer.clone()
    }
}

// ---- one dialog at a time, a pause after Cancel ----------------------------------------------------------------------------------------
/// The dialog gate (pure: the caller passes the clock). `begin` before showing, `end` with the answer after.
#[derive(Debug, Default)]
pub struct ConfirmGate {
    open: bool,
    last_no: Option<Instant>,
}

impl ConfirmGate {
    /// `Err(reason)` when a dialog may not be shown now.
    pub fn begin(&mut self, now: Instant) -> Result<(), String> {
        if self.open {
            return Err("a confirmation dialog is already open; answer it first".to_string());
        }
        if let Some(t) = self.last_no {
            if now.saturating_duration_since(t) < COOLDOWN {
                return Err("you cancelled a moment ago; try again in 2 s".to_string());
            }
        }
        self.open = true;
        Ok(())
    }

    pub fn end(&mut self, answer: &Answer, now: Instant) {
        self.open = false;
        if *answer == Answer::No {
            self.last_no = Some(now);
        }
    }
}

/// A [`Confirmer`] behind a [`ConfirmGate`]: what `HelperState` uses.
pub struct GatedConfirmer {
    inner: Arc<dyn Confirmer>,
    gate: Mutex<ConfirmGate>,
}

impl GatedConfirmer {
    pub fn new(inner: Arc<dyn Confirmer>) -> GatedConfirmer {
        GatedConfirmer { inner, gate: Mutex::new(ConfirmGate::default()) }
    }
}

impl Confirmer for GatedConfirmer {
    fn confirm(&self, req: &ConfirmRequest) -> Answer {
        if let Err(why) = self.gate.lock().unwrap_or_else(|p| p.into_inner()).begin(Instant::now()) {
            return Answer::Busy(why);
        }
        let answer = self.inner.confirm(req);
        self.gate.lock().unwrap_or_else(|p| p.into_inner()).end(&answer, Instant::now());
        answer
    }
}

// ---- the write button's arming (pure; native.rs polls it) -------------------------------------------------------------------------------
/// The write button is sensitive once [`ARM_DELAY`] has passed since the dialog was mapped (the first tick after it is shown): it starts
/// insensitive, so a click or Enter aimed at the page a moment earlier cannot land on it. A dialog that held the focus and then lost it is
/// disarmed again, and the delay starts over when the focus returns. (QA-26: the delay used to start only when the window reported itself
/// active, which a compositor may not do until the first click; that click then found the button still insensitive and was lost.)
#[derive(Debug, Default)]
pub struct Arming {
    since: Option<Instant>,
    had_focus: bool,
    lost: bool,
}

impl Arming {
    /// Whether the write button may be sensitive at `now`, the dialog having the focus (`active`) or not.
    pub fn tick(&mut self, now: Instant, active: bool) -> bool {
        if active {
            self.had_focus = true;
            self.lost = false;
        } else if self.had_focus {
            self.had_focus = false;
            self.lost = true;
            self.since = None;
            return false;
        } else if self.lost {
            return false;
        }
        let since = *self.since.get_or_insert(now);
        now.saturating_duration_since(since) >= ARM_DELAY
    }
}

// ---- the dialog's text ---------------------------------------------------------------------------------------------------------------
fn plural(n: u64, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

fn capped(mut v: Vec<String>) -> Vec<String> {
    if v.len() > MAX_TARGETS {
        let more = v.len() - (MAX_TARGETS - 1);
        v.truncate(MAX_TARGETS - 1);
        v.push(format!("and {more} more"));
    }
    v
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// CPU numbers as ranges: [1, 2, 3, 5, 7, 8] -> "1–3, 5, 7, 8".
fn ranges(mut cpus: Vec<u64>) -> String {
    cpus.sort_unstable();
    cpus.dedup();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < cpus.len() {
        let mut j = i;
        while j + 1 < cpus.len() && cpus[j + 1] == cpus[j] + 1 {
            j += 1;
        }
        out.push(if j >= i + 2 { format!("{}–{}", cpus[i], cpus[j]) } else if j == i + 1 { format!("{}, {}", cpus[i], cpus[j]) } else { cpus[i].to_string() });
        i = j + 1;
    }
    out.join(", ")
}

/// `|x|` in units of 10^-`decimals`, rounded half up, and whether `x` is below zero by at least one unit. The mock rounds the same way
/// (`Math.floor(Math.abs(x) * 10 ** d + 0.5)`): the same IEEE operations, so the two texts agree digit for digit.
fn scaled(x: f64, decimals: i32) -> (bool, u64) {
    let n = (x.abs() * 10f64.powi(decimals) + 0.5).floor() as u64;
    (x < 0.0 && n > 0, n)
}

/// Millivolts with one decimal at most: "0", "−19.5", "+10" (U+2212 for minus).
pub fn fmt_mv(x: f64) -> String {
    let (neg, n) = scaled(x, 1);
    if n == 0 {
        return "0".to_string();
    }
    let sign = if neg { "−" } else { "+" };
    if n % 10 == 0 {
        format!("{sign}{}", n / 10)
    } else {
        format!("{sign}{}.{}", n / 10, n % 10)
    }
}

/// Volts with three decimals: "1.250".
pub fn fmt_v(x: f64) -> String {
    let (_, n) = scaled(x, 3);
    format!("{}.{:03}", n / 1000, n % 1000)
}

/// One V/F word of a plan's `before` / `after` (`{ratio, offset_mv, v_target_v}`; a field that reads 0 is null).
#[derive(Debug, Clone, Copy)]
struct Word {
    ratio: Option<u64>,
    offset: Option<f64>,
    target: Option<f64>,
}

/// `Ok(None)` for a word that was not read (null / absent); `Err` for one the dialog cannot read.
fn word(entry: Option<&Value>, what: &str) -> Result<Option<Word>, String> {
    let e = match entry {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(e)) => e,
        Some(_) => return Err(format!("{what} is not a V/F word")),
    };
    let bad = || format!("{what} has a value the app cannot read");
    let int = |k: &str| match e.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_u64().map(Some).ok_or_else(bad),
    };
    let real = |k: &str| match e.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => num(Some(v)).map(Some).ok_or_else(bad),
    };
    Ok(Some(Word { ratio: int("ratio")?, offset: real("offset_mv")?, target: real("v_target_v")? }))
}

fn ratio_text(r: Option<u64>) -> String {
    r.map_or_else(|| "unset".to_string(), |r| format!("{r}×"))
}

fn target_text(v: Option<f64>) -> String {
    v.map_or_else(|| "unset".to_string(), |v| format!("{} V", fmt_v(v)))
}

fn ratios_text(r: &[u64]) -> String {
    r.iter().map(u64::to_string).collect::<Vec<_>>().join(" ")
}

/// Eight bucket ratios (0..255), as a plan step, a tune intent or the link's tables carry them.
fn eight(v: Option<&Value>) -> Option<Vec<u64>> {
    let a = v?.as_array()?;
    let r: Vec<u64> = a.iter().filter_map(Value::as_u64).filter(|x| *x <= 255).collect();
    (a.len() == 8 && r.len() == 8).then_some(r)
}

/// The value lines of a V/F plan, voltage raises first, and how many raise; `Err(why)` when a written value cannot be described.
/// Points come from the plan's `before` / `after` and `steps`; a turbo table's new ratios from the step (`after`, if a later helper sends them)
/// or the tune intent the plan was made from (`request.intent.turbo`), its old ones from the step (`before`) or the tables the helper reported.
pub fn tune_lines(rec: &PlanRecord) -> Result<(Vec<String>, usize), String> {
    let plan = &rec.plan;
    let steps = plan.get("steps").and_then(Value::as_array).ok_or("the plan lists no steps")?;
    let writes = plan.get("writes").and_then(Value::as_u64).ok_or("the plan does not say how many writes it sends")?;
    if plan.get("steps_truncated") == Some(&Value::Bool(true)) {
        return Err(format!("the helper cut the plan's step list ({} of {} writes listed)", steps.len(), writes));
    }
    let conditional = steps.iter().filter(|s| is_conditional(s)).count() as u64;
    if steps.len() as u64 != writes + conditional {
        return Err(format!("the plan lists {} of its {} writes", (steps.len() as u64).saturating_sub(conditional), writes));
    }
    let mut written: Vec<(String, u64)> = Vec::new();
    let mut tables: Vec<(String, Option<Vec<u64>>, Vec<u64>)> = Vec::new();
    for s in steps {
        let kind = s.get("kind").and_then(Value::as_str).ok_or("a step names no kind")?;
        let unit = || s.get("unit").and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("a {kind} step names no unit"));
        let at = match kind {
            "write_percore_enable" => continue, // the per-core mode bit (0x15 with bit 3 set), no tuning value
            "write_vf" | "write_favored" | "write_granular" => (unit()?, 0),
            "write_vf_point" | "write_ring_point" => {
                let p = s.get("point").and_then(Value::as_u64).filter(|p| *p >= 1).ok_or_else(|| format!("a {kind} step names no point"))?;
                (unit()?, p)
            }
            "write_msr" => {
                let t = s.get("table").and_then(Value::as_str).map(str::to_ascii_uppercase).filter(|t| t == "P" || t == "E").ok_or("a table write names no table")?;
                let after = eight(s.get("after"))
                    .or_else(|| eight(rec.request.get("intent").and_then(|i| i.get("turbo")).and_then(|tb| tb.get(&t))))
                    .ok_or_else(|| format!("the new ratios of turbo table {t} are not in the plan"))?;
                let before = eight(s.get("before")).or_else(|| eight(rec.tables.get(&t.to_ascii_lowercase())));
                if !tables.iter().any(|(x, _, _)| *x == t) {
                    tables.push((t, before, after));
                }
                continue;
            }
            other => return Err(format!("a step of kind {other}")),
        };
        if !written.contains(&at) {
            written.push(at);
        }
    }
    let units: Vec<&str> = plan.get("units").and_then(Value::as_array).map(|u| u.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let rank = |u: &str| units.iter().position(|x| *x == u).unwrap_or(usize::MAX);
    written.sort_by(|a, b| (rank(&a.0), &a.0, a.1).cmp(&(rank(&b.0), &b.0, b.1)));
    let entry = |side: &str, unit: &str, point: u64| plan.get(side).and_then(|s| s.get(unit)).and_then(|u| u.get(point.to_string()));
    let (mut raised, mut plain): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let mut put = |raise: bool, line: String| if raise { raised.push(format!("{RAISE_MARK}{line}")) } else { plain.push(line) };
    for (unit, point) in &written {
        let what = if *point == 0 { format!("{unit} OC word") } else { format!("{unit} point {point}") };
        let a = word(entry("after", unit, *point), &what)?.ok_or_else(|| format!("{what} is written but the plan gives no value for it"))?;
        let b = word(entry("before", unit, *point), &what)?;
        let was = |f: fn(&Word) -> String| b.as_ref().map_or_else(|| "not read".to_string(), f);
        if *point > 0 {
            let off = a.offset.ok_or_else(|| format!("{what} is written but the plan gives no offset for it"))?;
            let ratio = a.ratio.or(b.and_then(|b| b.ratio)).map_or_else(String::new, |r| format!(" · {r}×"));
            let before = was(|b| fmt_mv(b.offset.unwrap_or(0.0)));
            put(scaled(off, 1).1 > 0 && off > 0.0, format!("{unit} · point {point}{ratio} · offset {before} → {} mV", fmt_mv(off)));
            continue;
        }
        // the OC word holds two things: the whole-curve offset layer, and the OC point (ratio + adaptive target)
        let off = a.offset.unwrap_or(0.0);
        let curve_changed = b.map_or(true, |b| fmt_mv(b.offset.unwrap_or(0.0)) != fmt_mv(off));
        if curve_changed {
            put(scaled(off, 1).1 > 0 && off > 0.0, format!("{unit} · whole curve · offset {} → {} mV", was(|b| fmt_mv(b.offset.unwrap_or(0.0))), fmt_mv(off)));
        }
        let ratio_changed = b.map_or(true, |b| b.ratio != a.ratio);
        let target_changed = b.map_or(true, |b| b.target.map(fmt_v) != a.target.map(fmt_v));
        if ratio_changed || target_changed {
            let mut parts = vec![format!("{unit} · OC point")];
            if ratio_changed {
                parts.push(format!("ratio {} → {}", was(|b| ratio_text(b.ratio)), ratio_text(a.ratio)));
            } else if let Some(r) = a.ratio {
                parts.push(format!("{r}×"));
            }
            if target_changed {
                parts.push(format!("target {} → {}", was(|b| target_text(b.target)), target_text(a.target)));
            } else if a.target.is_some() {
                parts.push(format!("target {}", target_text(a.target)));
            }
            let up = match (a.target, b.and_then(|b| b.target)) {
                (Some(t), Some(was)) => scaled(t, 3).1 > scaled(was, 3).1,
                (Some(_), None) => true,
                (None, _) => false,
            };
            put(up && target_changed, parts.join(" · "));
        } else if !curve_changed {
            put(false, format!("{unit} · OC word · rewritten as it is (offset {} mV)", fmt_mv(off)));
        }
    }
    for (t, before, after) in tables {
        let was = before.map_or_else(|| "not read".to_string(), |b| ratios_text(&b));
        plain.push(format!("turbo table {t} · {was} → {}", ratios_text(&after)));
    }
    let raises = raised.len();
    raised.extend(plain);
    Ok((raised, raises))
}

/// A step the helper marks `conditional: true` (the per-core voltage enable): sent only when needed, so not one of the plan's `writes`.
fn is_conditional(s: &Value) -> bool {
    s.get("conditional") == Some(&Value::Bool(true))
}

/// `(writes, conditional)`: the plan's `writes` counts what it certainly sends; its step list holds those and the conditional ones.
fn check_count(plan: &Value, steps: &[&Value]) -> Result<(u64, u64), String> {
    let writes = plan.get("writes").and_then(Value::as_u64).ok_or("the plan does not say how many writes it sends")?;
    let conditional = steps.iter().filter(|s| is_conditional(s)).count() as u64;
    if writes + conditional != steps.len() as u64 {
        return Err(format!("the plan lists {} of its {} writes", (steps.len() as u64).saturating_sub(conditional), writes));
    }
    Ok((writes, conditional))
}

/// The dialog's item for one kept plan (`rec.plan` = the helper's plan result, nonce already removed). `Err(why)`: a written value the dialog
/// cannot describe — the shell then shows no dialog and approves nothing.
pub fn item_of(rec: &PlanRecord) -> Result<ConfirmItem, String> {
    let plan = &rec.plan;
    let st: Vec<&Value> = plan.get("steps").and_then(Value::as_array).map(|a| a.iter().collect()).ok_or("the plan lists no steps")?;
    if st.iter().any(|s| !s.is_object()) {
        return Err("a step is not an object".to_string());
    }
    let (label, targets, raises, (writes, conditional)) = match rec.kind {
        PlanKind::Tune => {
            let (lines, raises) = tune_lines(rec)?;
            ("V/F and ratio words", lines, raises, check_count(plan, &st)?)
        }
        PlanKind::Power => {
            // before → after (QA-17): the helper's step carries `before` in the same unit as `value` (µW, µs); a step without it reads "not read"
            let mut t = Vec::with_capacity(st.len());
            for s in &st {
                let v = num(s.get("value"));
                let b = num(s.get("before"));
                let watts = |uw: f64| (uw / 1e6 * 100.0).round() / 100.0;
                let secs = |us: f64| (us / 1e5).round() / 10.0;
                t.push(match (s.get("key").and_then(Value::as_str), v) {
                    (Some("pl1_w"), Some(uw)) => format!("PL1 {} → {} W", b.map_or_else(|| "not read".to_string(), |b| watts(b).to_string()), watts(uw)),
                    (Some("pl2_w"), Some(uw)) => format!("PL2 {} → {} W", b.map_or_else(|| "not read".to_string(), |b| watts(b).to_string()), watts(uw)),
                    (Some("tau_s"), Some(us)) => format!("time window {} → {} s", b.map_or_else(|| "not read".to_string(), |b| secs(b).to_string()), secs(us)),
                    (k, _) => return Err(format!("a power step ({}) the app cannot describe", k.unwrap_or("no key"))),
                });
            }
            ("Power limits", capped(t), 0, check_count(plan, &st)?)
        }
        PlanKind::Runtime => {
            // caps: one line per (old → new) ratio ("cpu 8–11 max 49× → 22×"); uncore: one per key. `before` is in kHz, the unit of `value` (QA-17)
            let mut by_ratio: Vec<(String, Vec<u64>)> = Vec::new();
            let mut t: Vec<String> = Vec::new();
            for s in &st {
                let key = s.get("key").and_then(Value::as_str).ok_or("a caps / uncore step names no key")?;
                let after = s
                    .get("ratio")
                    .and_then(Value::as_u64)
                    .map(|r| format!("{r}×"))
                    .or_else(|| num(s.get("value")).map(|k| format!("{}×", (k / 1e5).round())))
                    .ok_or_else(|| format!("the {key} step gives no value"))?;
                let was = num(s.get("before")).map_or_else(|| "not read".to_string(), |k| format!("{}×", (k / 1e5).round()));
                let ratio = format!("{was} → {after}");
                match s.get("domain").and_then(Value::as_str) {
                    Some("caps") => {
                        let cpu = key.strip_prefix("cpu").and_then(|n| n.parse::<u64>().ok());
                        match (by_ratio.iter_mut().find(|(x, _)| x == &ratio), cpu) {
                            (Some((_, cpus)), Some(c)) => cpus.push(c),
                            (None, Some(c)) => by_ratio.push((ratio, vec![c])),
                            (_, None) => t.push(format!("{key} max {ratio}")),
                        }
                    }
                    Some("uncore") => t.push(format!("uncore {} {ratio}", key.trim_end_matches("_ratio"))),
                    _ => return Err(format!("the {key} step names no domain the app knows")),
                }
            }
            let mut lines: Vec<String> = by_ratio.into_iter().map(|(r, cpus)| format!("cpu {} max {r}", ranges(cpus))).collect();
            lines.extend(t);
            ("Ratio caps and uncore", capped(lines), 0, check_count(plan, &st)?)
        }
    };
    let residual_max = if rec.kind == PlanKind::Tune { plan.get("residual_writes_max").and_then(Value::as_u64).unwrap_or(0) } else { 0 };
    Ok(ConfirmItem { subject: Subject::Plan(rec.kind), label: label.to_string(), writes, targets, raises, conditional, residual_max })
}

/// The dialog's line for a persistent op the webview sent (its arguments are the step-1 shape, already checked).
pub fn item_of_persist(op: &str, args: &Value) -> ConfirmItem {
    if op == "profiles.fingerprint" {
        return ConfirmItem { subject: Subject::Fingerprint, label: "CPU fingerprint of the accepted state".into(), writes: 0, targets: vec!["this CPU, from this boot's read".into()], raises: 0, conditional: 0, residual_max: 0 };
    }
    let what = match args.get("name").and_then(Value::as_str) {
        Some(n) => format!("profile “{n}”"),
        None => "the state of the last read".to_string(),
    };
    let mut targets = vec![what];
    if args.get("set_aside_unreadable") == Some(&Value::Bool(true)) {
        targets.push("the unreadable accepted state is moved aside".into());
    }
    ConfirmItem { subject: Subject::Accept, label: "Accepted state".into(), writes: 0, targets, raises: 0, conditional: 0, residual_max: 0 }
}

impl ConfirmRequest {
    /// CPU writes over all items.
    pub fn writes(&self) -> u64 {
        self.items.iter().map(|i| i.writes).sum()
    }

    /// G-248: the most residual-OC-point rewrites the plans may add to the counted writes.
    pub fn residual_max(&self) -> u64 {
        self.items.iter().map(|i| i.residual_max).sum()
    }

    fn only(&self, s: Subject) -> bool {
        !self.items.is_empty() && self.items.iter().all(|i| i.subject == s)
    }

    pub fn title(&self) -> String {
        "Linux XTU: confirm".to_string()
    }

    /// The question, bold in the dialog.
    pub fn primary(&self) -> String {
        if self.only(Subject::Accept) {
            let what = self.items[0].targets.first().cloned().unwrap_or_default();
            return format!("Set {what} as the accepted state?");
        }
        if self.only(Subject::Fingerprint) {
            return "Record this CPU’s fingerprint for the accepted state?".to_string();
        }
        match self.residual_max() {
            0 => format!("Apply {} to the CPU?", plural(self.writes(), "write")),
            r => format!("Apply {} (+ up to {r} if a leftover OC point is found) to the CPU?", plural(self.writes(), "write")),
        }
    }

    /// One block per item (V/F: its value lines, voltage raises first and counted; others: one line), then what the writes do and how long
    /// they last.
    pub fn secondary(&self) -> String {
        if self.only(Subject::Accept) {
            let mut lines: Vec<String> = self.items[0].targets.iter().skip(1).map(|t| format!("• {t}")).collect();
            lines.push("Restore accepted brings this state back; the boot restore does too when it is enabled. Nothing is written to the CPU now.".to_string());
            return lines.join("\n");
        }
        if self.only(Subject::Fingerprint) {
            return "Restores check it before they apply the accepted state. The accepted tuning stays as it is; nothing is written to the CPU.".to_string();
        }
        let mut lines: Vec<String> = Vec::new();
        for i in &self.items {
            if i.subject != Subject::Plan(PlanKind::Tune) {
                let what = if i.targets.is_empty() { String::new() } else { format!(": {}", i.targets.join(", ")) };
                lines.push(format!("• {} — {}{what}", i.label, plural(i.writes, "write")));
                continue;
            }
            let mut extra = if i.conditional > 0 { format!(" (+{} if per-core voltage control is off)", i.conditional) } else { String::new() };
            if i.residual_max > 0 {
                extra.push_str(&format!(" (+ up to {} if a leftover OC point is found; the apply decides from its own reads, so they are not listed)", i.residual_max));
            }
            lines.push(format!("• {} — {}{extra}:", i.label, plural(i.writes, "write")));
            if i.raises > 0 {
                lines.push(format!("   {RAISE_MARK}raises a voltage: {} listed first", plural(i.raises as u64, "line")));
            }
            let cut = i.targets.len() > MAX_TUNE_LINES;
            let shown = if cut { MAX_TUNE_LINES - 1 } else { i.targets.len() };
            lines.extend(i.targets.iter().take(shown).map(|t| format!("   {t}")));
            if cut {
                let hidden_raises = i.raises.saturating_sub(shown);
                let also = if hidden_raises > 0 { format!(" ({hidden_raises} of them raise a voltage)") } else { String::new() };
                lines.push(format!("   … and {} more{also}, all listed in the review", i.targets.len() - shown));
            }
        }
        lines.push(String::new());
        lines.push("Each write is sent alone and read back. V/F and ratio words last until a cold boot; power limits, caps and uncore until a reboot.".to_string());
        lines.join("\n")
    }

    /// The write button's label (never "OK"): names the action and its count.
    pub fn ok_label(&self) -> String {
        if self.only(Subject::Accept) {
            "Set as accepted".to_string()
        } else if self.only(Subject::Fingerprint) {
            "Record fingerprint".to_string()
        } else {
            match self.residual_max() {
                0 => format!("Apply {}", plural(self.writes(), "write")),
                r => format!("Apply {} + up to {r}", plural(self.writes(), "write")),
            }
        }
    }

    /// The text as the dialog shows it, for the confirmed answer and the contract samples: `{title, primary, secondary, ok_label}`.
    pub fn text(&self) -> Value {
        json!({"title": self.title(), "primary": self.primary(), "secondary": self.secondary(), "ok_label": self.ok_label()})
    }
}

// ---- the shell's answers to the webview --------------------------------------------------------------------------------------------------
fn nothing_written(code: &str, message: &str) -> Value {
    error_reply(code, message, Some(json!({"writes_sent": 0})))
}

const GONE: &str = "refused locally: the app no longer holds this plan (used, replaced, or the helper connection changed). Nothing was written. Review again.";
const NO_CODE: &str = "refused locally: this plan carries no confirmation code, so the app cannot apply it. Nothing was written.";

/// An answer other than Yes, as the webview gets it (nothing was sent in any of these).
fn not_yes(answer: Answer) -> Value {
    match answer {
        Answer::Yes => json!({"ok": true}),
        Answer::No => nothing_written("NOT_CONFIRMED", "Not confirmed in the system dialog. Nothing was written."),
        Answer::Unavailable(why) => nothing_written("CONFIRM_UNAVAILABLE", &format!("The confirmation dialog could not be shown ({why}). Nothing was written.")),
        Answer::Busy(why) => nothing_written("BUSY", &format!("No dialog: {why}. Nothing was written.")),
    }
}

/// Why a plan gets no dialog: the app cannot show every value it writes.
pub fn undescribed(why: &str) -> Answer {
    Answer::Unavailable(format!("the app cannot show every value this plan writes: {why}. Review again; if it persists, update the app and the helper together"))
}

/// The dialog for the named plans of this connection, or the answer that replaces it (nothing shown, nothing approved).
pub fn request_for(link: &Link, list: &[(PlanKind, String)]) -> Result<ConfirmRequest, Value> {
    let mut items = Vec::with_capacity(list.len());
    for (kind, id) in list {
        let Some(rec) = link.plan_record(*kind, id) else { return Err(nothing_written("PLAN_STALE", GONE)) };
        if rec.nonce.is_none() {
            return Err(nothing_written("BAD_REQUEST", NO_CODE));
        }
        items.push(item_of(&rec).map_err(|why| not_yes(undescribed(&why)))?);
    }
    Ok(ConfirmRequest { items })
}

/// `app.confirm {plans}`: describe the named plans of this connection in one native dialog and approve them on the operator's OK.
/// `{ok:true, result:{confirmed:true, plans, writes, dialog}}` (`dialog` = the text the operator confirmed), or NOT_CONFIRMED /
/// CONFIRM_UNAVAILABLE (also: a value the dialog cannot describe) / BUSY / PLAN_STALE / BAD_REQUEST with `detail.writes_sent: 0` (nothing
/// was sent: confirming never writes).
pub fn confirm_plans(link: &Link, confirmer: &dyn Confirmer, args: &Value) -> Value {
    let list = match ops::confirm_args(args) {
        Ok(l) => l,
        Err(r) => return nothing_written(r.code, &r.message),
    };
    let req = match request_for(link, &list) {
        Ok(r) => r,
        Err(answer) => return answer,
    };
    match confirmer.confirm(&req) {
        Answer::Yes => {
            if !link.approve(&list) {
                return nothing_written("PLAN_STALE", GONE);
            }
            json!({"ok": true, "result": {"confirmed": true, "plans": list.len(), "writes": req.writes(), "dialog": req.text()}})
        }
        other => not_yes(other),
    }
}

/// `*.apply {plan_id[, intent]}` from the webview: sent with the kept code (and the editor's intent, for the helper's stale check) when the
/// operator approved the plan; otherwise refused here, nothing sent.
pub fn apply_confirmed(link: &Link, kind: PlanKind, args: &Value, timeout: Duration) -> Value {
    let (plan_id, intent) = match ops::webview_apply_args(kind, args) {
        Ok(x) => x,
        Err(r) => return nothing_written(r.code, &r.message),
    };
    match link.apply(kind, &plan_id, intent.as_ref(), timeout) {
        Ok(Reply::Done(resp)) => public_response(&resp),
        Ok(Reply::Started(id)) => started_reply(&id),
        Err(ApplyError::Refused(ApplyRefusal::UnknownPlan)) => nothing_written("PLAN_STALE", GONE),
        Err(ApplyError::Refused(ApplyRefusal::NoNonce)) => nothing_written("BAD_REQUEST", NO_CODE),
        Err(ApplyError::Refused(ApplyRefusal::NotApproved)) => {
            nothing_written("NOT_CONFIRMED", "refused locally: this plan was not confirmed in the system dialog. Nothing was sent.")
        }
        Err(ApplyError::Call(e)) => {
            let (code, message) = e.code_message();
            error_reply(&code, &message, None)
        }
    }
}

/// A persistent op from the webview (`profiles.accept` step 1, `profiles.fingerprint`): its own native dialog, then sent on the OK only
/// ([`Link::persist`] completes a two-step accept). Every refusal before the send says `writes_sent: 0`.
pub fn persist_confirmed(link: &Link, confirmer: &dyn Confirmer, op: &str, args: &Value, timeout: Duration) -> Value {
    if let Err(r) = ops::webview_persist_args(op, args) {
        return nothing_written(r.code, &r.message);
    }
    let req = ConfirmRequest { items: vec![item_of_persist(op, args)] };
    match confirmer.confirm(&req) {
        Answer::Yes => {}
        other => return not_yes(other),
    }
    match link.persist(op, args, timeout) {
        Ok(resp) => public_response(&resp),
        Err(ApplyError::Refused(_)) => nothing_written(
            "BAD_REQUEST",
            "refused locally: the helper asked for a confirmation step but its answer carried no usable code. Nothing was accepted.",
        ),
        Err(ApplyError::Call(e)) => {
            let (code, message) = e.code_message();
            error_reply(&code, &message, None)
        }
    }
}

/// A V/F plan as the simulator answers one (P0 point 5, EC1's whole curve, a new OC point on P2, a positive point offset on P3, the P turbo
/// table) with the tune intent it was made from and the tables of the last read: the sample the unit tests and the contract samples describe.
#[doc(hidden)]
pub fn sample_tune_record() -> PlanRecord {
    let plan = json!({
        "plan_id": "7".repeat(64), "writes": 8, "units": ["P0", "EC1", "P2"],
        "steps": [
            {"n": 1, "kind": "write_percore_enable", "conditional": true},
            {"n": 2, "kind": "write_msr", "table": "p"},
            {"n": 3, "kind": "write_vf_point", "unit": "P0", "cpu": 0, "point": 5, "offset_mv": -20},
            {"n": 4, "kind": "write_vf", "unit": "EC1", "cpu": 12, "point": 0},
            {"n": 5, "kind": "write_vf", "unit": "EC1", "cpu": 13, "point": 0},
            {"n": 6, "kind": "write_vf", "unit": "P2", "cpu": 2, "point": 0},
            {"n": 7, "kind": "write_favored", "unit": "P2", "cpu": 2, "point": 0},
            {"n": 8, "kind": "write_granular", "unit": "P2", "cpu": 2, "point": 0},
            {"n": 9, "kind": "write_vf_point", "unit": "P3", "cpu": 3, "point": 6, "offset_mv": 10}
        ],
        "before": {
            "P0": {"5": {"ratio": 53, "offset_mv": 0.0, "v_target_v": null}},
            "EC1": {"0": {"ratio": null, "offset_mv": 0.0, "v_target_v": null}},
            "P2": {"0": {"ratio": null, "offset_mv": 0.0, "v_target_v": null}},
            "P3": {"6": {"ratio": 55, "offset_mv": 0.0, "v_target_v": null}}
        },
        "after": {
            "P0": {"5": {"ratio": 53, "offset_mv": -19.531, "v_target_v": null}},
            "EC1": {"0": {"ratio": 46, "offset_mv": -30.273, "v_target_v": null}},
            "P2": {"0": {"ratio": 58, "offset_mv": 0.0, "v_target_v": 1.25}},
            "P3": {"6": {"ratio": 55, "offset_mv": 9.766, "v_target_v": null}}
        }
    });
    let intent = json!({"scope": "unit", "rows": [
        {"target": "P0", "offset": {"kind": "points", "mv": {"53": -20}}, "v_target_v": null, "ratio": null},
        {"target": "EC1", "offset": {"kind": "curve", "mv": -30}, "v_target_v": null, "ratio": null},
        {"target": "P2", "offset": null, "v_target_v": 1.25, "ratio": 58},
        {"target": "P3", "offset": {"kind": "points", "mv": {"55": 10}}, "v_target_v": null, "ratio": null}],
        "turbo": {"P": [56, 56, 54, 54, 54, 54, 54, 54]}});
    let mut tables = Map::new();
    tables.insert("p".into(), json!([57, 57, 55, 55, 55, 55, 55, 55]));
    tables.insert("e".into(), json!([48, 48, 48, 48, 48, 48, 48, 48]));
    PlanRecord::new(PlanKind::Tune, &"7".repeat(64), Some("Q2W3E4"), plan, json!({"intent": intent}), tables)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(kind: PlanKind, plan: Value) -> PlanRecord {
        PlanRecord::new(kind, &"7".repeat(64), Some("Q2W3E4"), plan, json!({}), Map::new())
    }

    #[test]
    fn numbers_are_formatted_one_way() {
        assert_eq!([fmt_mv(0.0), fmt_mv(-0.04), fmt_mv(-19.531), fmt_mv(-20.0), fmt_mv(9.766), fmt_mv(-31.25), fmt_mv(31.25)], ["0", "0", "−19.5", "−20", "+9.8", "−31.3", "+31.3"]);
        assert_eq!([fmt_v(1.25), fmt_v(0.9), fmt_v(1.2)], ["1.250", "0.900", "1.200"]);
    }

    #[test]
    fn the_v_f_dialog_shows_every_written_value_raises_first() {
        let (lines, raises) = tune_lines(&sample_tune_record()).unwrap();
        assert_eq!(
            lines,
            [
                "↑ P2 · OC point · ratio unset → 58× · target unset → 1.250 V",
                "↑ P3 · point 6 · 55× · offset 0 → +9.8 mV",
                "P0 · point 5 · 53× · offset 0 → −19.5 mV",
                "EC1 · whole curve · offset 0 → −30.3 mV",
                "EC1 · OC point · ratio unset → 46×",
                "turbo table P · 57 57 55 55 55 55 55 55 → 56 56 54 54 54 54 54 54",
            ]
        );
        assert_eq!(raises, 2);
        let req = ConfirmRequest { items: vec![item_of(&sample_tune_record()).unwrap()] };
        assert_eq!(req.primary(), "Apply 8 writes to the CPU?");
        assert!(req.secondary().starts_with("• V/F and ratio words — 8 writes (+1 if per-core voltage control is off):\n   ↑ raises a voltage: 2 lines listed first\n   ↑ P2 · OC point"), "{}", req.secondary());
    }

    #[test]
    fn a_value_the_plan_does_not_give_fails_closed() {
        let base = sample_tune_record();
        let with = |f: &dyn Fn(&mut PlanRecord)| {
            let mut r = base.clone();
            f(&mut r);
            tune_lines(&r).unwrap_err()
        };
        assert!(with(&|r| r.request = json!({"intent": {"profile": "good"}})).contains("new ratios of turbo table P"), "a profile plan's table is not described");
        assert!(with(&|r| r.plan["after"]["P0"] = json!({})).contains("P0 point 5 is written but the plan gives no value"));
        assert!(with(&|r| r.plan["after"]["P0"]["5"]["offset_mv"] = Value::Null).contains("no offset"));
        assert!(with(&|r| r.plan["after"]["P0"]["5"]["offset_mv"] = json!("-20")).contains("cannot read"));
        assert!(with(&|r| r.plan["steps"][2]["kind"] = json!("write_mystery")).contains("a step of kind write_mystery"));
        assert!(with(&|r| r.plan["steps_truncated"] = json!(true)).contains("cut the plan's step list"));
        assert!(with(&|r| r.plan["writes"] = json!(400)).contains("lists 8 of its 400 writes"));
        assert!(with(&|r| r.plan.as_object_mut().unwrap().remove("steps").map(|_| ()).unwrap_or(())).contains("no steps"));
        // a later helper may put the ratios on the step itself: then a profile plan is described too
        let mut r = base.clone();
        r.request = json!({"intent": {"profile": "good"}});
        r.plan["steps"][1] = json!({"n": 2, "kind": "write_msr", "table": "p", "before": [57, 57, 55, 55, 55, 55, 55, 55], "after": [57, 57, 57, 57, 57, 57, 57, 57]});
        assert!(tune_lines(&r).unwrap().0.contains(&"turbo table P · 57 57 55 55 55 55 55 55 → 57 57 57 57 57 57 57 57".to_string()));
        // a table nobody read is "not read", never invented
        let mut r = base.clone();
        r.tables.clear();
        assert!(tune_lines(&r).unwrap().0.contains(&"turbo table P · not read → 56 56 54 54 54 54 54 54".to_string()));
    }

    #[test]
    fn a_restore_plan_with_a_turbo_change_is_described_from_the_step_alone() {
        // R-F1a: the helper's table step carries `before` / `after` for every plan kind; a restore has no `intent.turbo` and the shell kept no read of the tables
        let plan = json!({
            "plan_id": "7".repeat(64), "writes": 1, "units": [], "before": {}, "after": {},
            "steps": [{"n": 1, "kind": "write_msr", "table": "p", "before": [58, 58, 58, 58, 58, 58, 58, 58], "after": [57, 57, 55, 55, 55, 55, 55, 55]}]
        });
        let r = PlanRecord::new(PlanKind::Tune, &"7".repeat(64), Some("Q2W3E4"), plan, json!({"intent": {"restore": "accepted"}}), Map::new());
        let (lines, raises) = tune_lines(&r).unwrap();
        assert_eq!((lines, raises), (vec!["turbo table P · 58 58 58 58 58 58 58 58 → 57 57 55 55 55 55 55 55".to_string()], 0));
        assert!(item_of(&r).is_ok(), "a restore with a turbo change must produce a dialog, not CONFIRM_UNAVAILABLE");
        // an unread table (`before: null`) is "not read"; a step without `after` still fails closed
        let mut r2 = r.clone();
        r2.plan["steps"][0]["before"] = Value::Null;
        assert_eq!(tune_lines(&r2).unwrap().0, ["turbo table P · not read → 57 57 55 55 55 55 55 55"]);
        r2.plan["steps"][0].as_object_mut().unwrap().remove("after");
        assert!(item_of(&r2).unwrap_err().contains("new ratios of turbo table P"));
    }

    #[test]
    fn the_cut_never_hides_that_raises_exist() {
        let mut plan = json!({"writes": 20, "units": [], "steps": [], "before": {}, "after": {}});
        for n in 0..20u64 {
            let unit = format!("P{n}");
            plan["steps"].as_array_mut().unwrap().push(json!({"kind": "write_vf_point", "unit": unit, "point": 3}));
            plan["before"][&unit] = json!({"3": {"ratio": 40, "offset_mv": 0.0}});
            plan["after"][&unit] = json!({"3": {"ratio": 40, "offset_mv": if n < 14 { 5.0 } else { -5.0 }}});
        }
        let item = item_of(&rec(PlanKind::Tune, plan)).unwrap();
        assert_eq!((item.targets.len(), item.raises), (20, 14));
        let text = ConfirmRequest { items: vec![item] }.secondary();
        assert!(text.contains("↑ raises a voltage: 14 lines listed first"), "{text}");
        assert!(text.contains("   … and 9 more (3 of them raise a voltage), all listed in the review"), "{text}");
        assert_eq!(text.lines().filter(|l| l.starts_with("   ↑ P")).count(), 11);
    }

    #[test]
    fn items_name_what_each_plan_writes() {
        // QA-17: before → after for every line; a step without its `before` says "not read"
        let power = json!({"writes": 3, "steps": [{"key": "pl1_w", "before": 270_000_000, "value": 259_000_000}, {"key": "pl2_w", "value": 295_000_000}, {"key": "tau_s", "before": 128_000_000, "value": 56_000_000}]});
        assert_eq!(item_of(&rec(PlanKind::Power, power)).unwrap().targets, vec!["PL1 270 → 259 W", "PL2 not read → 295 W", "time window 128 → 56 s"]);
        let rt = json!({"writes": 6, "steps": [
            {"domain": "caps", "key": "cpu0", "before": 5_700_000, "ratio": 50, "value": 5_000_000},
            {"domain": "caps", "key": "cpu8", "before": 4_900_000, "ratio": 22, "value": 2_200_000}, {"domain": "caps", "key": "cpu9", "before": 4_900_000, "ratio": 22},
            {"domain": "caps", "key": "cpu10", "before": 4_900_000, "ratio": 22}, {"domain": "caps", "key": "cpu11", "before": 4_900_000, "ratio": 22},
            {"domain": "uncore", "key": "max_ratio", "before": 4_000_000, "value": 3_800_000}]});
        assert_eq!(item_of(&rec(PlanKind::Runtime, rt)).unwrap().targets, vec!["cpu 0 max 57× → 50×", "cpu 8–11 max 49× → 22×", "uncore max 40× → 38×"]);
        let unread = json!({"writes": 1, "steps": [{"domain": "caps", "key": "cpu3", "ratio": 40, "value": 4_000_000}]});
        assert_eq!(item_of(&rec(PlanKind::Runtime, unread)).unwrap().targets, vec!["cpu 3 max not read → 40×"]);
        for (kind, bad) in [
            (PlanKind::Power, json!({"writes": 1, "steps": [{"key": "pl4_w", "value": 1}]})),
            (PlanKind::Power, json!({"writes": 1, "steps": [{"key": "pl1_w"}]})),
            (PlanKind::Power, json!({"writes": 2, "steps": [{"key": "pl1_w", "value": 1}]})),
            (PlanKind::Runtime, json!({"writes": 1, "steps": [{"domain": "parking", "key": "cpu3", "value": 0}]})),
            (PlanKind::Runtime, json!({"writes": 1, "steps": [{"domain": "caps", "key": "cpu3"}]})),
            (PlanKind::Tune, json!({"writes": 1, "units": ["P0"]})),
        ] {
            assert!(item_of(&rec(kind, bad.clone())).is_err(), "{kind:?} {bad}");
        }
    }

    #[test]
    fn the_dialog_text_states_the_count_and_never_says_ok() {
        let power = |w: u64, steps: Value| item_of(&rec(PlanKind::Power, json!({"writes": w, "steps": steps}))).unwrap();
        let req = ConfirmRequest { items: vec![item_of(&sample_tune_record()).unwrap(), power(1, json!([{"key": "pl1_w", "before": 250_000_000, "value": 200_000_000}]))] };
        assert_eq!(req.primary(), "Apply 9 writes to the CPU?", "the conditional per-core enable is not counted");
        assert_eq!(req.ok_label(), "Apply 9 writes");
        assert!(req.secondary().contains("\n• Power limits — 1 write: PL1 250 → 200 W\n"), "{}", req.secondary());
        let one = ConfirmRequest { items: vec![power(1, json!([{"key": "pl2_w", "value": 1}]))] };
        assert_eq!(one.ok_label(), "Apply 1 write");
        let acc = ConfirmRequest { items: vec![item_of_persist("profiles.accept", &json!({"name": "x"}))] };
        assert_eq!((acc.primary().as_str(), acc.ok_label().as_str()), ("Set profile “x” as the accepted state?", "Set as accepted"));
        let read = ConfirmRequest { items: vec![item_of_persist("profiles.accept", &json!({"from": "read", "set_aside_unreadable": true}))] };
        assert_eq!(read.primary(), "Set the state of the last read as the accepted state?");
        assert!(read.secondary().starts_with("• the unreadable accepted state is moved aside\n"), "{}", read.secondary());
        let fp = ConfirmRequest { items: vec![item_of_persist("profiles.fingerprint", &json!({}))] };
        assert_eq!(fp.ok_label(), "Record fingerprint");
        assert_eq!(ranges(vec![3, 1, 2, 5, 7, 8]), "1–3, 5, 7, 8");
    }

    #[test]
    fn the_gate_allows_one_dialog_at_a_time_and_pauses_after_a_cancel() {
        let t0 = Instant::now();
        let mut g = ConfirmGate::default();
        assert!(g.begin(t0).is_ok());
        assert!(g.begin(t0).unwrap_err().contains("already open"), "a second dialog while one is open");
        g.end(&Answer::No, t0);
        assert!(g.begin(t0 + Duration::from_millis(1999)).unwrap_err().contains("cancelled a moment ago"));
        assert!(g.begin(t0 + COOLDOWN).is_ok(), "the pause is over");
        g.end(&Answer::Yes, t0 + COOLDOWN);
        assert!(g.begin(t0 + COOLDOWN).is_ok(), "a Yes starts no pause");
        g.end(&Answer::Unavailable("x".into()), t0 + COOLDOWN);
        assert!(g.begin(t0 + COOLDOWN).is_ok(), "nor does a dialog that could not be shown");
    }

    #[test]
    fn a_gated_confirmer_refuses_right_after_a_cancel_without_asking() {
        let inner = Arc::new(FixedConfirmer::new(Answer::No));
        let gated = GatedConfirmer::new(inner.clone());
        let req = ConfirmRequest { items: vec![item_of(&sample_tune_record()).unwrap()] };
        assert_eq!(gated.confirm(&req), Answer::No);
        assert!(matches!(gated.confirm(&req), Answer::Busy(_)), "the second request lands in the pause");
        assert_eq!(inner.asked().len(), 1, "no dialog was shown for it");
    }

    #[test]
    fn the_write_button_arms_after_the_delay_from_the_dialog_being_mapped() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        // QA-26: the delay starts at the first tick (the dialog is mapped), whether or not the compositor reports the window active yet
        let mut a = Arming::default();
        assert!(!a.tick(t0, false), "just mapped, not focused");
        assert!(!a.tick(t0 + ARM_DELAY - ms(1), false));
        assert!(a.tick(t0 + ARM_DELAY, false), "armed after the delay although the focus never arrived: the first click activates it");
        assert!(a.tick(t0 + ARM_DELAY + ms(5), true), "and the focus arriving changes nothing");
    }

    #[test]
    fn a_focus_held_and_then_lost_disarms_the_write_button_until_it_returns() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut a = Arming::default();
        assert!(!a.tick(t0, true));
        assert!(!a.tick(t0 + ARM_DELAY - ms(1), true));
        assert!(a.tick(t0 + ARM_DELAY, true), "armed after the delay");
        assert!(!a.tick(t0 + ms(900), false), "losing the focus disarms at once");
        assert!(!a.tick(t0 + ms(2000), false), "and it stays disarmed while the dialog has no focus");
        assert!(!a.tick(t0 + ms(2100), true), "the delay starts again when the focus returns");
        assert!(a.tick(t0 + ms(2100) + ARM_DELAY, true));
    }

    #[test]
    fn the_conditional_per_core_enable_is_not_a_counted_write_but_is_said() {
        // QA-05: the helper's `writes` is what the plan certainly sends; the 0x15 step is listed with `conditional: true` and the dialog says "+1 if ..."
        let item = item_of(&sample_tune_record()).unwrap();
        assert_eq!((item.writes, item.conditional), (8, 1));
        let mut r = sample_tune_record();
        r.plan["writes"] = json!(9); // the old helper counted it
        assert!(item_of(&r).unwrap_err().contains("lists 8 of its 9 writes"), "a plan whose count disagrees with its steps still fails closed");
        let no_cond = json!({"writes": 1, "units": ["P0"], "steps": [{"n": 1, "kind": "write_vf_point", "unit": "P0", "point": 5}],
            "before": {"P0": {"5": {"ratio": 53, "offset_mv": 0.0}}}, "after": {"P0": {"5": {"ratio": 53, "offset_mv": -10.0}}}});
        let item = item_of(&rec(PlanKind::Tune, no_cond)).unwrap();
        assert_eq!(item.conditional, 0);
        assert!(ConfirmRequest { items: vec![item] }.secondary().starts_with("• V/F and ratio words — 1 write:\n"));
    }

    #[test]
    fn residual_oc_point_writes_are_said_in_the_dialog_and_the_button_but_not_counted() {
        // G-248: a restore's apply may rewrite a leftover OC point; those writes are in neither `writes` nor `steps`, so the plan carries `residual_writes_max`
        let mut zero_writes = json!({"writes": 0, "units": [], "steps": [], "before": {}, "after": {}, "residual_writes_max": 16});
        let item = item_of(&rec(PlanKind::Tune, zero_writes.clone())).unwrap();
        assert_eq!((item.writes, item.conditional, item.residual_max), (0, 0, 16), "the strict steps == writes + conditional check is unchanged");
        let req = ConfirmRequest { items: vec![item] };
        assert_eq!(req.primary(), "Apply 0 writes (+ up to 16 if a leftover OC point is found) to the CPU?");
        assert_eq!(req.ok_label(), "Apply 0 writes + up to 16");
        assert!(req.secondary().contains("+ up to 16 if a leftover OC point is found"), "{}", req.secondary());
        zero_writes["residual_writes_max"] = json!(0);
        let none = ConfirmRequest { items: vec![item_of(&rec(PlanKind::Tune, zero_writes.clone())).unwrap()] };
        assert_eq!((none.primary().as_str(), none.ok_label().as_str()), ("Apply 0 writes to the CPU?", "Apply 0 writes"));
        zero_writes.as_object_mut().unwrap().remove("residual_writes_max"); // an older helper
        assert_eq!(item_of(&rec(PlanKind::Tune, zero_writes)).unwrap().residual_max, 0);
        // the count still has to match the steps
        let lying = json!({"writes": 2, "units": [], "steps": [], "before": {}, "after": {}, "residual_writes_max": 16});
        assert!(item_of(&rec(PlanKind::Tune, lying)).is_err());
    }

    #[test]
    fn the_accept_dialog_says_what_brings_the_state_back() {
        // QA-35: the boot restore is only "when it is enabled"
        let acc = ConfirmRequest { items: vec![item_of_persist("profiles.accept", &json!({"name": "x"}))] };
        assert_eq!(acc.secondary(), "Restore accepted brings this state back; the boot restore does too when it is enabled. Nothing is written to the CPU now.");
    }
}
