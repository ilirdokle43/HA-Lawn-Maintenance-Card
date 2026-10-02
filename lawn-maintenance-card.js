// Lawn Maintenance Card — custom Lovelace card for a year-round lawn
// maintenance planner + history tracker.
//
// Tasks are fully defined in the card's YAML config (see examples/example.yaml).
// History, skipped-year flags, and manual next-due overrides are persisted
// by a pyscript backend (pyscript/lawn_maintenance.py) in entity attributes
// on pyscript.lawn_<id>, so history is not size-limited and survives HA
// restarts + browser refreshes.
//
// This file registers TWO independent cards:
//   * custom:lawn-maintenance-card — the full planner (this file's main body)
//   * custom:lawn-week-calendar    — a read-only 7-day strip (end of file)
// They share only module-level pure functions. The week calendar reads the
// maintenance card's own YAML out of the Lovelace config and the same
// pyscript entities, so there is one task list and one history store.
//
// Install: copy this file to <config>/www/, add it as a Lovelace JS module
// resource, and add a card of type "custom:lawn-maintenance-card" and/or
// "custom:lawn-week-calendar".
//
// Bump CARD_VERSION on every redeploy and keep the Lovelace resource URL's
// ?v= query param in sync (e.g. ?v=2) — browsers and HA's service worker
// cache this file by URL, so overwriting it in place is often not enough
// for a change to actually take effect.

const CARD_VERSION = "51";
// eslint-disable-next-line no-console
console.info(
  `%c LAWN-MAINTENANCE-CARD %c v${CARD_VERSION} `,
  "color: white; background: #2e7d32; font-weight: 700; border-radius: 3px 0 0 3px;",
  "color: #2e7d32; background: white; font-weight: 700; border-radius: 0 3px 3px 0;"
);

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---------------------------------------------------------------------------
// Date helpers (all dates are local-midnight Date objects; ISO strings are
// plain YYYY-MM-DD with no time component)
// ---------------------------------------------------------------------------

function todayLocal() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function formatShort(date) {
  return `${date.getDate()} ${MONTH_ABBR[date.getMonth()]}`;
}

function formatShortYear(date) {
  return `${date.getDate()} ${MONTH_ABBR[date.getMonth()]} ${date.getFullYear()}`;
}

function parseMonthDay(mmdd) {
  const [m, d] = (mmdd || "01-01").split("-").map(Number);
  return { month: m, day: d };
}

function windowDates(window, startYear) {
  const s = parseMonthDay(window.start);
  const e = parseMonthDay(window.end);
  const start = new Date(startYear, s.month - 1, s.day);
  const wraps = e.month < s.month || (e.month === s.month && e.day < s.day);
  const end = new Date(startYear + (wraps ? 1 : 0), e.month - 1, e.day);
  return { start, end };
}

// First active month strictly after today's month, within the SAME calendar
// year — the "does this task come back before the year is out?" question that
// separates an optional recurring task's Inactive (yes, it returns) from
// Season finished (no, that's it for this year). Returns the month number
// (1-12), or null when nothing is left this year.
//
// Deliberately does NOT wrap into next year, unlike nextActiveMonth() below:
// wrapping would make every task "resuming" forever and Season finished
// unreachable. A season that spans New Year (active_months [11, 12, 1, 2])
// still behaves sensibly — viewed in June it reports 11, and by the time
// December arrives that month is itself active, so the task is in Optional
// rather than needing a resume date at all.
function nextActiveMonthThisYear(activeMonths, today) {
  const currentMonth = today.getMonth() + 1;
  const later = activeMonths.filter((m) => m > currentMonth);
  return later.length ? Math.min(...later) : null;
}

function nextActiveMonth(activeMonths, today) {
  for (let i = 1; i <= 12; i++) {
    const m = ((today.getMonth() + i) % 12) + 1;
    const y = today.getFullYear() + Math.floor((today.getMonth() + i) / 12);
    if (activeMonths.includes(m)) return { month: m, year: y };
  }
  return null;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Status engine — pure functions, no DOM/hass dependency, so this layer can
// later grow condition-based rules (soil moisture, weather, etc.) without
// touching rendering or storage code.
//
// Each status carries a statusKey; STATUS_META maps that key to a display
// color/icon plus which of the five priority sections it belongs in and its
// sort rank within that section (lower = more urgent, shown first).
// ---------------------------------------------------------------------------

// How far ahead a task has to be before it stops being "coming up" and gets
// parked in Inactive instead. Applies to a seasonal task's window start; see
// computeSeasonalStatus and the note on optional recurring tasks in
// applyOptionalRemap.
const INACTIVE_THRESHOLD_DAYS = 30;

const SECTION_ORDER = ["needs_attention", "upcoming", "logs", "on_hold", "optional", "season_finished", "inactive"];
const SECTION_LABELS = {
  needs_attention: "Needs attention",
  upcoming: "Upcoming",
  logs: "Activity",
  on_hold: "On hold",
  optional: "Optional",
  season_finished: "Season finished",
  inactive: "Inactive",
};
// Sections collapsed by default when a task list first renders — low-priority
// sections stay out of the way until the user asks to see them. "on hold" is
// collapsed too: the whole point of a lockout is that those tasks stop
// competing for attention, and the lockout's own task shows the countdown.
const DEFAULT_COLLAPSED_SECTIONS = ["on_hold", "optional", "season_finished", "inactive"];
const COLLAPSIBLE_SECTIONS = new Set(["on_hold", "optional", "season_finished", "inactive"]);

const STATUS_META = {
  overdue: { color: "#ef4444", icon: "mdi:alert-circle", section: "needs_attention", rank: 0 },
  window_ending_soon: { color: "#f97316", icon: "mdi:timer-sand", section: "needs_attention", rank: 1 },
  due_today: { color: "#f97316", icon: "mdi:alert", section: "needs_attention", rank: 2 },
  window_open: { color: "#22c55e", icon: "mdi:calendar-check", section: "needs_attention", rank: 3 },
  // Task is active but has no history to calculate a due date from — distinct
  // from due_today (which implies a real calculated date has arrived).
  recommended_now: { color: "#0ea5e9", icon: "mdi:calendar-check-outline", section: "needs_attention", rank: 4 },
  due_soon: { color: "#eab308", icon: "mdi:clock-alert-outline", section: "upcoming", rank: 0 },
  window_upcoming: { color: "#eab308", icon: "mdi:calendar-clock", section: "upcoming", rank: 1 },
  upcoming: { color: "#3b82f6", icon: "mdi:calendar-clock", section: "upcoming", rank: 2 },
  not_started: { color: "#60a5fa", icon: "mdi:calendar-blank-outline", section: "upcoming", rank: 3 },
  missed_window: { color: "#b45309", icon: "mdi:calendar-remove", section: "season_finished", rank: 0 },
  completed: { color: "#10b981", icon: "mdi:check-circle", section: "season_finished", rank: 1 },
  skipped: { color: "#9ca3af", icon: "mdi:cancel", section: "season_finished", rank: 2 },
  inactive: { color: "#9ca3af", icon: "mdi:moon-waning-crescent", section: "inactive", rank: 0 },
  // Seasonal window further out than INACTIVE_THRESHOLD_DAYS. Shares rank 0
  // with every other Inactive key on purpose: with ranks equal, _renderTasks'
  // tie-break sorts the whole section by secondaryTime, i.e. chronologically
  // by when each task comes back (see secondaryTime).
  season_inactive: { color: "#9ca3af", icon: "mdi:calendar-arrow-right", section: "inactive", rank: 0 },
  // Optional tasks (task.optional: true) never compute overdue/missed —
  // computeRecurringStatus/computeSeasonalStatus run normally for the date
  // math, then applyOptionalRemap() maps their result onto these calm,
  // non-urgency statuses instead. completed/skipped pass through unchanged
  // (already calm colors) and just get moved into the optional section.
  optional_available: { color: "#a78bfa", icon: "mdi:leaf-circle-outline", section: "optional", rank: 0 },
  optional_upcoming: { color: "#a78bfa", icon: "mdi:calendar-clock-outline", section: "optional", rank: 1 },
  optional_finished: { color: "#a78bfa", icon: "mdi:calendar-blank-outline", section: "optional", rank: 2 },
  // Optional recurring, out of season but returning later this year — its own
  // key so it can carry the calm optional purple into the Inactive section
  // while mandatory tasks there keep the grey "inactive" styling. Rank 0 like
  // the other Inactive keys, so the section sorts purely chronologically.
  optional_inactive: { color: "#a78bfa", icon: "mdi:moon-waning-crescent", section: "inactive", rank: 0 },
  // Optional recurring with no active months left this calendar year — done
  // for the year, so it joins the seasonal tasks in Season finished.
  optional_season_over: { color: "#a78bfa", icon: "mdi:calendar-blank-outline", section: "season_finished", rank: 3 },
  // type: log tasks (see computeLogStatus) — a single calm status regardless
  // of how long ago the last entry was. Never overdue/alarming by design;
  // any "may be due" nudge from target_interval_days is conveyed in the
  // row/detail text, not through color.
  log: { color: "#3b82f6", icon: "mdi:calendar-check-outline", section: "logs", rank: 0 },
  // type: treatment — on-demand, never due, never overdue. Sits with the other
  // "record it when it happens" rows rather than in a scheduled section.
  treatment: { color: "#3b82f6", icon: "mdi:beaker-outline", section: "logs", rank: 1 },
  // A follow-up that is satisfied (or whose parent has never been done) is
  // simply not rendered — see _renderTasks. The entry exists so the section
  // lookup can never fall through to the "inactive" default.
  follow_up_done: { color: "#10b981", icon: "mdi:check-circle", section: "season_finished", rank: 4 },
  // A task silenced by another task's lockout window (see applyLockoutRemap).
  // Deliberately grey and calm: it is not overdue, not missed, and nothing is
  // wrong — it is simply not allowed to be done right now. The row stays
  // visible and fully loggable; only its claim on your attention is removed.
  on_hold: { color: "#94a3b8", icon: "mdi:pause-circle-outline", section: "on_hold", rank: 0 },
  // The daily "day N of M" marker the lockout's OWN task paints across the
  // week calendar for every day of its window, so the period reads as a
  // visible band you can count rather than an absence of other markers.
  // Its own section (not logs/upcoming) so eventDisplayColor gives it this
  // colour instead of the source task's identity colour.
  lockout_day: { color: "#a855f7", icon: "mdi:progress-clock", section: "on_hold", rank: 1 },
};

// Maps a normally-computed seasonal statusKey onto its optional-task
// equivalent. completed/skipped are deliberately absent — they pass through
// unchanged (see applyOptionalRemap).
const OPTIONAL_SEASONAL_REMAP = {
  not_started: "optional_upcoming",
  window_upcoming: "optional_upcoming",
  window_open: "optional_available",
  window_ending_soon: "optional_available",
  missed_window: "optional_finished",
};

// statusKeys for which the collapsed row / details panel should not show a
// "Next"/"Next due" date — either there's nothing to show (inactive) or the
// optional remap intentionally hides a due date that no longer means
// "you must do this" (optional_available/optional_finished). optional_upcoming
// keeps showing its date ("next in N days") since that's still informative.
const HIDE_NEXT_DUE_STATUS_KEYS = new Set([
  "inactive", "optional_available", "optional_finished",
  // Same reasoning as plain "inactive" — an out-of-season date isn't a real
  // recommendation, and the row already says when the task comes back.
  "optional_inactive", "optional_season_over",
]);

// Builds the label for a suspended/inactive recurring task, e.g.
// "Inactive · resumes September" (or "· resumes January 2027" if the next
// active month falls in a different year than today).
function inactiveLabel(activeMonths, fromDate, today) {
  const next = nextActiveMonth(activeMonths, fromDate);
  if (!next) return "Inactive";
  const yearSuffix = next.year !== today.getFullYear() ? ` ${next.year}` : "";
  return `Inactive · resumes ${MONTH_NAMES[next.month - 1]}${yearSuffix}`;
}

function computeRecurringStatus(task, data, today) {
  const activeMonths = task.active_months || [];
  // No active_months configured means "no season restriction", i.e. active
  // all year — the reading a year-round task like a monthly treatment needs.
  // (It previously meant the opposite by accident: an empty list matched no
  // month, so such a task was permanently Inactive and could never come due.
  // Every task that configures active_months is unaffected either way.)
  const hasSeason = activeMonths.length > 0;
  const inSeasonNow = !hasSeason || activeMonths.includes(today.getMonth() + 1);
  const last = data.h.length ? parseISODate(data.h[0]) : null;

  const overridden = !!data.override;
  const autoNextDue = last ? addDays(last, task.interval_days) : null;
  const nextDue = overridden ? parseISODate(data.override) : autoNextDue;
  // Keep the raw calculated/overridden date + override metadata on every
  // returned status (even the inactive one) so the expanded panel's
  // override controls stay fully visible and usable regardless of season —
  // a manual override always takes precedence and can always be cleared.
  const base = { last, nextDue, overridden, autoNextDue };
  const suffix = overridden ? " (manually set)" : "";

  // A calculated/overridden due date that lands in a month outside the
  // configured season is not a real recommendation — interval math alone
  // can walk a date straight into an inactive gap (e.g. spring+fall active,
  // summer off). Season state always wins over the interval calculation.
  const seasonSuspended = hasSeason && !!nextDue && !activeMonths.includes(nextDue.getMonth() + 1);

  if (!inSeasonNow || seasonSuspended) {
    // If today itself is inactive, resume-search from today. If today is
    // active but the calculated date fell in a later inactive gap, resume-
    // search from that date instead (it's the more relevant reference).
    const resumeFrom = inSeasonNow && seasonSuspended ? nextDue : today;
    const label = inactiveLabel(activeMonths, resumeFrom, today);
    // First day of the month this task becomes live again. Purely a sort key
    // for the Inactive section (see secondaryTime) — the label above is still
    // what the row displays, and a task with no active_months has no resume
    // date, so it stays null and sorts as before.
    const resumes = nextActiveMonth(activeMonths, resumeFrom);
    const resumesAt = resumes ? new Date(resumes.year, resumes.month - 1, 1) : null;
    return { ...base, statusKey: "inactive", label, detail: "", resumesAt };
  }

  if (!nextDue) {
    return { ...base, statusKey: "recommended_now", label: "Recommended now", detail: "Never completed" };
  }

  return { ...base, ...dueDateStatus(nextDue, today, task.due_soon_days ?? 3, suffix), detail: "" };
}

// "How urgent is this date?" — the shared countdown wording used by both
// recurring tasks and follow-ups (see computeFollowUpStatus), so a follow-up
// counts down in exactly the same language and colours as everything else:
// Due in N days -> Due tomorrow -> Due today -> Overdue by N days.
function dueDateStatus(dueDate, today, dueSoonDays, suffix = "") {
  const diff = daysBetween(today, dueDate);
  if (diff < 0) {
    const n = -diff;
    return { statusKey: "overdue", label: `Overdue by ${n} day${n === 1 ? "" : "s"}${suffix}` };
  }
  if (diff === 0) return { statusKey: "due_today", label: `Due today${suffix}` };
  if (diff === 1) return { statusKey: dueSoonDays >= 1 ? "due_soon" : "upcoming", label: `Due tomorrow${suffix}` };
  if (diff <= dueSoonDays) return { statusKey: "due_soon", label: `Due in ${diff} days${suffix}` };
  return { statusKey: "upcoming", label: `Due in ${diff} days${suffix}` };
}

function currentWindowOccurrence(window, today) {
  const y = today.getFullYear();
  const prev = windowDates(window, y - 1);
  if (today >= prev.start && today <= prev.end) return prev;
  const cur = windowDates(window, y);
  if (today >= cur.start && today <= cur.end) return cur;
  return cur;
}

function computeSeasonalStatus(task, data, today) {
  const window = task.window;
  const occ = currentWindowOccurrence(window, today);
  const occYear = occ.start.getFullYear();
  const last = data.h.length ? parseISODate(data.h[0]) : null;
  const upcomingDays = task.upcoming_days ?? 21;
  const endingSoonDays = task.ending_soon_days ?? 5;

  const graceStart = addDays(occ.start, -60);
  const graceEnd = addDays(occ.end, 30);
  const completedThisOcc = data.h.some((iso) => {
    const d = parseISODate(iso);
    return d >= graceStart && d <= graceEnd;
  });
  const skippedThisOcc = data.sy.includes(occYear);

  let statusKey;
  let label;
  let detail = `Window: ${formatShort(occ.start)} – ${formatShort(occ.end)}`;

  if (skippedThisOcc) {
    statusKey = "skipped";
    label = `Skipped for ${occYear}`;
  } else if (completedThisOcc) {
    statusKey = "completed";
    label = `Completed for ${occYear}`;
  } else if (today < occ.start) {
    const daysUntil = daysBetween(today, occ.start);
    if (daysUntil > INACTIVE_THRESHOLD_DAYS) {
      // Too far out to be worth a slot in Upcoming — parked in Inactive until
      // it comes within the horizon, at which point the two branches below
      // take over again unchanged.
      statusKey = "season_inactive";
      label = `Inactive · starts ${formatShort(occ.start)}`;
    } else if (daysUntil <= upcomingDays) {
      statusKey = "window_upcoming";
      label = `Upcoming — opens in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
    } else {
      statusKey = "not_started";
      label = "Not started";
    }
  } else if (today <= occ.end) {
    const daysLeft = daysBetween(today, occ.end);
    if (daysLeft <= endingSoonDays) {
      statusKey = "window_ending_soon";
      label = `Window ending soon — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
    } else {
      statusKey = "window_open";
      label = "Application window open";
    }
  } else {
    statusKey = "missed_window";
    label = "Missed window";
    const nextOcc = windowDates(window, occYear + 1);
    detail = `Next window ${formatShortYear(nextOcc.start)}`;
  }

  return { statusKey, last, windowStart: occ.start, windowEnd: occ.end, occurrenceYear: occYear, label, detail };
}

// type: log — a generic "record an event, show when it last happened, keep
// full history" task with no season/interval concept and never overdue. The
// first use case is mowing, but nothing here is mowing-specific: task.name
// and task.value_label carry all the wording, so any future log task (blade
// sharpening, soil test, sprinkler inspection, ...) behaves identically.
function relativeDayLabel(days) {
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function computeLogStatus(task, data, today) {
  const last = data.h.length ? parseISODate(data.h[0]) : null;
  const daysSince = last ? daysBetween(last, today) : null;
  const label = last === null ? "Never logged" : relativeDayLabel(daysSince);
  return { statusKey: "log", last, daysSince, label, detail: "" };
}

// ---------------------------------------------------------------------------
// type: program — a fixed set of scheduled applications per calendar year,
// written either as an explicit list of month-day strings:
//
//   schedule_dates: ["MM-DD", "MM-DD", ...]
//
// or as an annual anchor plus a fixed step, when the dates are regular enough
// that listing them would be noise (see generatedTargets):
//
//   schedule_start: "MM-DD"
//   schedule_interval_days: N
//   schedule_end: "MM-DD"          # optional, defaults to 31 December
//
// Both produce the same list of absolute dates for the year in question, and
// everything downstream treats them identically. An anchored sequence is a
// *schedule*, not a recurrence: its step runs from the anchor, never from what
// was last logged, so a late completion cannot drag the following targets — the
// distinction from `recurring`, which deliberately does count from the last
// completion and is left untouched.
//
// Unlike `recurring` (an interval that never ends) or `seasonal` (one window),
// a program has a KNOWN, FINITE number of applications whose dates never move.
// Logging one late does not shift the rest — the targets are absolute — and
// the program can never generate more applications than it declares. Nothing
// here knows any particular date; it all comes from the task's own YAML.
// ---------------------------------------------------------------------------

function programTargets(schedule, year) {
  return (schedule || [])
    .map((md) => {
      const { month, day } = parseMonthDay(md);
      return new Date(year, month - 1, day);
    })
    .sort((a, b) => a - b);
}

// The second way to describe a programme: an annual anchor plus a fixed step,
// instead of writing every date out by hand.
//
//   schedule_start: "02-16"        # the anchor, re-derived every year
//   schedule_interval_days: 30     # step between targets
//   schedule_end: "10-31"          # optional, defaults to 31 December
//
// The anchor is rebuilt from the year being viewed, so the sequence restarts on
// the same calendar date every year and cannot accumulate drift — a target's
// date is a pure function of (anchor, step, index), never of what was logged.
// Real date arithmetic throughout (addDays walks the calendar), so February
// length and leap years are handled by the platform rather than by arithmetic
// on month numbers.
function generatedTargets(task, year) {
  const step = Number(task.schedule_interval_days);
  if (!task.schedule_start || !Number.isFinite(step) || step < 1) return [];
  const { month, day } = parseMonthDay(task.schedule_start);
  const end = task.schedule_end
    ? (() => {
        const e = parseMonthDay(task.schedule_end);
        return new Date(year, e.month - 1, e.day);
      })()
    : new Date(year, 11, 31);
  const out = [];
  let cursor = new Date(year, month - 1, day);
  // The 366 cap is a runaway guard only — a step of 1 fills a whole year and
  // nothing legitimate can exceed one target per day.
  while (cursor <= end && out.length < 366) {
    out.push(cursor);
    cursor = addDays(cursor, step);
  }
  return out;
}

// A programme's targets for one year, however its schedule is written. Both
// spellings produce the same plain list of dates, so every downstream consumer
// — status, sections, the week calendar, Year Overview — is identical for the
// two and neither needs to know which was used.
function programTargetsFor(task, year) {
  if (Array.isArray(task.schedule_dates) && task.schedule_dates.length) {
    return programTargets(task.schedule_dates, year);
  }
  return generatedTargets(task, year);
}

function computeProgramStatus(task, data, today) {
  const year = today.getFullYear();
  const targets = programTargetsFor(task, year);
  const last = data.h.length ? parseISODate(data.h[0]) : null;
  const base = { last, targets, occurrenceYear: year };
  if (!targets.length) {
    return { ...base, statusKey: "inactive", label: "No schedule configured", detail: "", remainingIdx: [], currentIdx: null };
  }

  // Each of THIS year's applications counts toward the latest target on or
  // before it (anything earlier in the year counts toward the first). That is
  // what makes a late application satisfy the target it was meant for without
  // consuming a later one: applied 3 May still fills the 1 May slot, and the
  // next target stays 21 May rather than sliding to 23 May.
  const satisfied = new Set();
  for (const iso of data.h) {
    const applied = parseISODate(iso);
    if (applied.getFullYear() !== year) continue;
    let idx = 0;
    for (let i = 0; i < targets.length; i++) if (targets[i] <= applied) idx = i;
    satisfied.add(idx);
  }
  const appliedCount = satisfied.size;
  const lastSatisfied = satisfied.size ? Math.max(...satisfied) : -1;

  // Only targets after the newest satisfied one are still outstanding —
  // anything skipped before it is simply missed, never a growing backlog.
  const remainingIdx = [];
  for (let i = lastSatisfied + 1; i < targets.length; i++) if (!satisfied.has(i)) remainingIdx.push(i);
  let missedCount = 0;
  for (let i = 0; i < lastSatisfied; i++) if (!satisfied.has(i)) missedCount++;

  // Of the outstanding targets whose date has already passed, only the most
  // recent one is shown as actionable; earlier ones are counted as missed.
  const passed = remainingIdx.filter((i) => targets[i] <= today);
  let currentIdx = null;
  if (passed.length) {
    currentIdx = passed[passed.length - 1];
    missedCount += passed.length - 1;
  } else if (remainingIdx.length) {
    currentIdx = remainingIdx[0];
  }

  const detail = `${appliedCount} of ${targets.length} applied in ${year}` + (missedCount ? ` · ${missedCount} missed` : "");
  const shared = { ...base, appliedCount, missedCount, remainingIdx, currentIdx, satisfiedIdx: [...satisfied].sort((a, b) => a - b) };

  // Past the final target, the programme is done for the year regardless of
  // how many were actually applied — it must not nag into the autumn — and
  // next January's targets start the cycle again on their own.
  if (currentIdx === null || today > targets[targets.length - 1]) {
    return {
      ...shared,
      remainingIdx: [],
      currentIdx: null,
      statusKey: "completed",
      label: `Season finished — ${appliedCount} of ${targets.length} applied`,
      detail,
    };
  }

  const nextDue = targets[currentIdx];
  if (daysBetween(today, nextDue) > INACTIVE_THRESHOLD_DAYS) {
    return { ...shared, nextDue, statusKey: "season_inactive", label: `Inactive · starts ${formatShort(nextDue)}`, detail };
  }
  return { ...shared, nextDue, ...dueDateStatus(nextDue, today, task.due_soon_days ?? 3), detail };
}

// type: treatment — an on-demand action with NO schedule of its own. Unlike
// `recurring` it never computes a next-due date and can never become overdue:
// it is performed when the user decides it's warranted, not because an
// interval elapsed. Unlike `log` it is a deliberate treatment that can carry
// products, entry_fields and follow-ups (see below), which is the whole point
// — the schedule that matters is the follow-up cycle each application starts,
// not a recurrence of the treatment itself.
function computeTreatmentStatus(task, data, today) {
  const last = data.h.length ? parseISODate(data.h[0]) : null;
  const daysSince = last ? daysBetween(last, today) : null;
  return {
    statusKey: "treatment",
    last,
    daysSince,
    // Deliberately never a "due"/"overdue" phrasing, and never a next date.
    label: last ? `Last applied ${formatShort(last)}` : "Not applied",
    detail: "",
  };
}

// Collapsed-row line for a treatment: what was last done and how long ago,
// with no scheduling language at all.
function treatmentRowText(task, status) {
  const valueLabel = task.value_label || "Last applied";
  if (!status.last) return `${escapeHtml(valueLabel)}: Never`;
  return `${escapeHtml(valueLabel)}: ${formatShortYear(status.last)} <span class="dim">· ${relativeDayLabel(status.daysSince).toLowerCase()}</span>`;
}

// ---------------------------------------------------------------------------
// Follow-ups — a dependent action a task creates when it is actually done,
// due a fixed number of days after the REAL completion date (not the date it
// was scheduled for). Configured on the parent task:
//
//   follow_up: { id, name, icon, after_days, action_label }
//
// Storage-wise a follow-up is simply its own task id, "<parent>__<id>", so it
// reuses pyscript.lawn_<id> and lawn_log_task unchanged — no backend change,
// and it inherits persistence, restart-restore, history and the year-history
// journal for free. Nothing about it lives in browser memory.
//
// The parent's own schedule is untouched: next_fungicide stays
// last_application + interval_days, and completing the follow-up writes only
// to the follow-up's entity, so it can never shift the parent's next due date.
// ---------------------------------------------------------------------------

// Joins a parent id and a follow-up id into the storage id, and so into the
// entity id pyscript.lawn_<id>. It must not introduce a double underscore:
// Home Assistant's VALID_ENTITY_ID rejects "__" anywhere in an entity id, and
// pyscript's state.set() then fails silently, leaving the follow-up with
// nowhere to persist. "_fu_" keeps every underscore single while staying
// distinctive enough not to collide with a real task id.
const FOLLOW_UP_SEPARATOR = "_fu_";

// A task may declare `follow_ups:` (a list) or `follow_up:` (a single object,
// the original v38 spelling). Both are read here and normalised to a list, so
// nothing downstream needs to know which spelling a task used and existing
// single-follow-up configs keep working untouched. Each entry becomes its own
// independent task with its own storage id, so two follow-ups on one parent
// never share state.
function followUpConfigsFor(parent) {
  if (Array.isArray(parent.follow_ups)) return parent.follow_ups.filter((f) => f && f.id);
  if (parent.follow_up && parent.follow_up.id) return [parent.follow_up];
  return [];
}

function followUpTasksFor(parent) {
  return followUpConfigsFor(parent).map((config) => ({
    id: `${parent.id}${FOLLOW_UP_SEPARATOR}${config.id}`,
    name: config.name || config.id,
    icon: config.icon || "mdi:check-circle-outline",
    type: "follow_up",
    after_days: config.after_days ?? 1,
    action_label: config.action_label || "DONE TODAY",
    due_soon_days: config.due_soon_days ?? parent.due_soon_days,
    // Per-entry values recorded when this follow-up is completed (e.g. an
    // inspection result). With prompt_on_done the action opens the log form
    // instead of one-tap logging, so the value is chosen rather than defaulted.
    entry_fields: config.entry_fields,
    prompt_on_done: config.prompt_on_done,
    // Its OWN allocated identity color (see normalizeTaskConfig), not the
    // parent's — a follow-up is visually its own task. The history source chip
    // is what keeps the relationship visible, not a shared color.
    color: config.color,
    // A follow-up is never categorised in its own right: the parent is the
    // single source of truth, so re-categorising a parent moves its follow-ups
    // with it automatically and they can never end up stranded in a category
    // their parent has left. Copied raw (possibly undefined) so the same
    // categoryForTask() fallback applies to both.
    category: parent.category,
    // Same reasoning for the assignee: whoever owns the treatment owns the
    // wash that follows from it, so a parent and its follow-ups can never end
    // up on two different people's tablets.
    assigned_to: parent.assigned_to,
    // Kept so the row can say what it follows, and so the status can be
    // computed against the parent's history.
    parent_id: parent.id,
    parent_name: parent.name,
  }));
}

// A follow-up is pending from the moment its parent is logged until it is
// itself logged on or after that application date. Matching by "wash on or
// after the application" rather than by an id stored on the entry is what
// makes a late completion work (applied 13th, washed 19th still closes the
// 13th's follow-up) while a new application always opens a fresh one — the
// next application date is later than every wash recorded so far, so the
// cycle re-arms automatically.
function computeFollowUpStatus(task, data, parentData, today) {
  const last = data.h.length ? parseISODate(data.h[0]) : null;
  const parentIso = parentData && parentData.h.length ? parentData.h[0] : null;
  if (!parentIso) {
    // Parent never applied — there is nothing to follow up on yet.
    return { statusKey: "follow_up_done", pending: false, last, label: "Nothing pending", detail: "" };
  }
  const parentDate = parseISODate(parentIso);
  const dueDate = addDays(parentDate, task.after_days);
  const doneIso = data.h.find((iso) => iso >= parentIso) || null;
  if (doneIso) {
    return {
      statusKey: "follow_up_done",
      pending: false,
      last,
      dueDate,
      parentDate,
      label: `Done ${formatShort(parseISODate(doneIso))}`,
      detail: "",
    };
  }
  return {
    ...dueDateStatus(dueDate, today, task.due_soon_days ?? 3),
    pending: true,
    last,
    nextDue: dueDate,
    dueDate,
    parentDate,
    detail: `After ${task.parent_name} on ${formatShort(parentDate)}`,
  };
}

// Configured tasks, each immediately followed by its synthesized follow-up
// task (if it configures one). THE single source of truth for "all tasks" —
// the planner card's _allTasks() and the week calendar's buildWeekEvents()
// both go through here, so the two cards can never disagree about which
// follow-ups exist.
function withFollowUps(tasks) {
  const out = [];
  for (const task of tasks || []) {
    out.push(task);
    out.push(...followUpTasksFor(task));
  }
  return out;
}

// Collapsed-row line for a pending follow-up: the countdown, then the
// application it belongs to — which is the whole point of the relationship.
function followUpRowText(task, status) {
  return `${escapeHtml(status.label)} <span class="dim">· after ${escapeHtml(task.parent_name)} on ${formatShort(status.parentDate)}</span>`;
}

// Collapsed-row line: "<value_label>: <date> · <relative>[ · <target clause>]".
// The target clause is purely informational (item 9) — never a status
// change, just a neutral nudge using the task's own name so it never reads
// as mowing-specific.
function logRowText(task, status) {
  const valueLabel = task.value_label || "Last logged";
  if (!status.last) return `${escapeHtml(valueLabel)}: Never`;
  const dateText = formatShortYear(status.last);
  const relative = relativeDayLabel(status.daysSince);
  let targetClause = "";
  if (status.lockedOut) {
    // The target is suspended, not merely not-yet-reached, so neither "may be
    // due" nor "target 5 days" is true right now — say what is actually
    // going on instead. Mowing during overseeding is the motivating case.
    targetClause = ` · <span class="dim">on hold · ${escapeHtml(status.lockedOut.label)} until ${formatShort(status.lockedOut.end)}</span>`;
  } else if (task.target_interval_days) {
    targetClause = status.daysSince >= task.target_interval_days
      ? ` · ${escapeHtml(task.name)} may be due`
      : ` · target ${task.target_interval_days} days`;
  }
  return `${escapeHtml(valueLabel)}: ${dateText} · ${relative}${targetClause}`;
}

// Generic per-entry custom fields — not tied to type: log or to mowing in
// any way. Any task can set:
//   entry_fields:
//     - id: height
//       label: Mowing height
//       type: number
//       unit: cm
//       default: 6
//       min: 1
//       max: 10
//       step: 1
// to record a structured value alongside each history entry: MOWED TODAY /
// ADD APPLICATION silently use each field's `default`, and values are
// edited per-entry via a bounded dropdown for type: number (see
// _renderHistoryItem). A list (not a single object) so more fields can be
// added later without any storage/format change. Same spirit as
// computeRotationSuggestion, just for arbitrary structured fields instead
// of a list of named products.
function entryFieldRange(field) {
  const min = field.min !== undefined ? field.min : 1;
  const max = field.max !== undefined ? field.max : 10;
  const step = field.step && field.step > 0 ? field.step : 1;
  const values = [];
  for (let v = min; v <= max; v += step) values.push(v);
  return values;
}

function defaultEntryFieldValues(task) {
  const values = {};
  for (const f of task.entry_fields || []) {
    // Skips a blank/unset default (undefined or "") rather than writing a
    // meaningless empty value into every quick-logged entry — a field with
    // nothing configured just isn't recorded on that entry at all.
    if (f && f.id && f.default !== undefined && f.default !== "") values[f.id] = f.default;
  }
  return values;
}

// Renders one entry_fields control (number -> bounded <select>, text -> free
// <input>), shared by the ADD APPLICATION form and the history edit form so
// both stay in sync as new field types are added. `dataRole` distinguishes
// the two call sites ("add-app-field" / "edit-field") for the click-handler
// querySelectorAlls that read these back on Save; `data-field-type` on the
// element itself is what lets that same generic read-back know whether to
// coerce the value with Number() or keep it as a string.
function renderEntryFieldInput(field, dataRole, currentValue) {
  if (!field || !field.id) return "";
  if (field.type === "number") {
    const current = currentValue !== undefined ? currentValue : field.default;
    return `<select class="date-input" data-role="${dataRole}" data-field-id="${escapeHtml(field.id)}" data-field-type="number">
      ${entryFieldRange(field).map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${v}${field.unit ? " " + escapeHtml(field.unit) : ""}</option>`).join("")}
    </select>`;
  }
  if (field.type === "text") {
    const current = currentValue !== undefined && currentValue !== null ? currentValue : field.default || "";
    return `<input type="text" class="date-input" data-role="${dataRole}" data-field-id="${escapeHtml(field.id)}" data-field-type="text" value="${escapeHtml(String(current))}" placeholder="${escapeHtml(field.label || field.id)}">`;
  }
  // A fixed list of allowed values from the task's own YAML — same bounded
  // <select> shape as `number`, but the options are authored rather than
  // generated from min/max/step. Values are stored and read back as plain
  // strings, so entryFieldsText/populatedEntryFields need no special case.
  if (field.type === "select") {
    const options = Array.isArray(field.options) ? field.options : [];
    const current = currentValue !== undefined && currentValue !== null && currentValue !== ""
      ? currentValue
      : field.default !== undefined ? field.default : options[0];
    return `<select class="date-input" data-role="${dataRole}" data-field-id="${escapeHtml(field.id)}" data-field-type="select">
      ${options.map((o) => `<option value="${escapeHtml(String(o))}" ${String(o) === String(current) ? "selected" : ""}>${escapeHtml(String(o))}</option>`).join("")}
    </select>`;
  }
  return "";
}

// Resolves a history entry's stored product_id against the task's current
// `products:` list. Shared by the Tasks tab's history list and Year History
// so both resolve products the exact same way.
function resolveProduct(task, entry) {
  return entry.productId && task.products ? task.products.find((p) => p.id === entry.productId) || null : null;
}

// ---------------------------------------------------------------------------
// Task identity colors
//
// Every task gets its own stable accent, derived from its id alone — so it is
// identical after a restart, a refresh, on another device, in a second card
// instance, and in the week calendar, with nothing stored anywhere. A task may
// also pin its own with `color: "#..."` (any CSS color) when the generated one
// isn't wanted.
//
// Generated as HSL rather than picked from a short list, because a handful of
// hex values repeats almost immediately once there are dozens of tasks:
// IDENTITY_HUE_STEPS hues x IDENTITY_TONES tones gives plenty of visually
// distinct slots. The tones are tuned for the dark card — nothing near-black,
// near-white or washed out — and the hue range deliberately starts past red so
// an identity color can never be mistaken for the overdue red that overrides
// it (see eventDisplayColor).
const IDENTITY_HUE_START = 18;    // skip the reds/oranges reserved for status
const IDENTITY_HUE_SPAN = 324;    // 18deg .. 342deg
const IDENTITY_HUE_STEPS = 30;    // ~11deg apart — comfortably distinguishable
const IDENTITY_TONES = [
  { s: 68, l: 62 },
  { s: 50, l: 74 },
  { s: 82, l: 55 },
  { s: 38, l: 65 },
];
const IDENTITY_SLOTS = IDENTITY_HUE_STEPS * IDENTITY_TONES.length;
// Probe stride for collision resolution. Coprime with IDENTITY_SLOTS so
// probing eventually visits every slot, and large enough that a displaced task
// lands on a clearly different hue rather than the neighbouring shade.
const IDENTITY_PROBE_STRIDE = 37;

// FNV-1a-ish with a final avalanche mix. The mixing matters: ids that share a
// long prefix — a parent task and the follow-ups synthesized beneath it — must
// not land on neighbouring hues, which a plain rolling hash would do.
function identityHash(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return Math.abs(h | 0);
}

function identitySlotColor(slot) {
  const tone = IDENTITY_TONES[slot % IDENTITY_TONES.length];
  const hueIndex = Math.floor(slot / IDENTITY_TONES.length) % IDENTITY_HUE_STEPS;
  const hue = IDENTITY_HUE_START + (hueIndex * IDENTITY_HUE_SPAN) / IDENTITY_HUE_STEPS;
  return `hsl(${Math.round(hue)}, ${tone.s}%, ${tone.l}%)`;
}

// The slot an id would like, from two independent bit-fields of its mixed hash.
function preferredIdentitySlot(id) {
  const h = identityHash(id);
  return (((h >>> 8) % IDENTITY_HUE_STEPS) * IDENTITY_TONES.length) + ((h & 0xff) % IDENTITY_TONES.length);
}

// Assigns every id a DISTINCT color. Hashing alone cannot promise that — with
// 30-odd tasks the birthday paradox makes a shared slot likely however large
// the palette — so ids that want a taken slot probe forward deterministically.
// Allocation walks the ids in sorted order, not config order, so re-ordering
// the YAML cannot repaint anything. Ids with an explicit `color:` are honoured
// as-is and never occupy a generated slot.
//
// Same task list in, same colors out — which is what makes the planner card and
// the week calendar agree, since both normalize the identical configured list.
function allocateIdentityColors(entries) {
  const taken = new Set();
  const out = {};
  for (const entry of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const explicit = typeof entry.color === "string" && entry.color.trim() ? entry.color.trim() : null;
    if (explicit) {
      out[entry.id] = explicit;
      continue;
    }
    let slot = preferredIdentitySlot(entry.id);
    for (let i = 0; i < IDENTITY_SLOTS && taken.has(slot); i++) {
      slot = (slot + IDENTITY_PROBE_STRIDE) % IDENTITY_SLOTS;
    }
    taken.add(slot);
    out[entry.id] = identitySlotColor(slot);
  }
  return out;
}

// The color to paint a task with. Normalization (see normalizeTaskConfig) has
// already written the allocated value onto `color`, so this is a plain read;
// the hash fallback only covers tasks built by hand that never went through it.
function taskIdentityColor(task) {
  const explicit = task && task.color;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return identitySlotColor(preferredIdentitySlot((task && (task.id || task.name)) || ""));
}

// The sections whose status color says nothing beyond "scheduled" or "logged".
// For those the task's identity color is shown instead; every other section —
// needs attention, season finished, inactive, optional — keeps its semantic
// color, because those genuinely report something the identity color would
// bury. This is the single place that decides identity-vs-status, so the
// planner card and the week calendar can never disagree.
const IDENTITY_COLOR_SECTIONS = new Set(["upcoming", "logs"]);

// THE resolver. Priority:
//   1. a status whose section carries meaning -> that status's own color
//      (red for overdue, green for completed, purple for optional, ...)
//   2. otherwise -> the task's stable identity color
// `attention` is true only for the needs-attention section, and is what the
// week calendar uses to also redden the status text.
function eventDisplayColor(task, statusKey) {
  const meta = statusKey ? STATUS_META[statusKey] : null;
  if (meta && !IDENTITY_COLOR_SECTIONS.has(meta.section)) {
    return { color: meta.color, attention: meta.section === "needs_attention" };
  }
  return { color: taskIdentityColor(task), attention: false };
}

// The entry_fields whose value is actually set on this entry — skips
// undefined (legacy entries logged before the field existed) and blank text
// values. Shared by entryFieldsText below and Year History's compact/
// multi-line layout decision (see _renderYearHistoryItem), so both agree on
// exactly what counts as "populated" without duplicating the filter.
function populatedEntryFields(entryFields, entry) {
  return (entryFields || []).filter(
    (f) => f && f.id && entry.fields && entry.fields[f.id] !== undefined && entry.fields[f.id] !== null && entry.fields[f.id] !== ""
  );
}

// Builds the "label: value unit" (or bare "value unit" when only one field
// is populated) text for a history entry's entry_fields values, with no
// leading dash/span — callers wrap it for their own layout. Shared by the
// Tasks tab's history list and Year History so the multi-field disambiguation
// rule (see _renderHistoryItem) only lives in one place.
function entryFieldsText(entryFields, entry) {
  const populatedFields = populatedEntryFields(entryFields, entry);
  if (!populatedFields.length) return "";
  const fieldValueText = (f) => `${escapeHtml(String(entry.fields[f.id]))}${f.unit ? " " + escapeHtml(f.unit) : ""}`;
  return populatedFields.length === 1
    ? fieldValueText(populatedFields[0])
    : populatedFields.map((f) => `${escapeHtml(f.label || f.id)}: ${fieldValueText(f)}`).join(" · ");
}

// Builds the "label: value unit · label: value unit" text for a history
// entry's snapshot_entities values — always the value stored at log time,
// never re-read live. Shared by the Tasks tab's history list and Year History.
function entrySnapshotsText(entry) {
  return Object.values(entry.snapshots || {})
    .map((s) => `${escapeHtml(s.label)}: ${escapeHtml(String(s.value))}${s.unit ? " " + escapeHtml(s.unit) : ""}`)
    .join(" · ");
}

// Renders a compact thumbnail for a history entry's attached photo (v1: at
// most one item in `media`, but this reads the whole array so multi-photo
// support later needs no change here). Only ever requests the two fixed
// sizes image_upload actually supports (confirmed via proof-of-concept —
// arbitrary WxH thumbnail requests return 400 Bad Request); CSS scales
// 256x256 down to the small on-page size. A failed load hides itself via
// inline onerror rather
// than a delegated listener, since the DOM's error/load events don't
// bubble and so can't be caught by this file's usual [data-action]
// delegation — this keeps one broken/deleted photo from breaking the rest
// of an otherwise-readable history entry, with no retry/error spam. Shared
// by the Tasks tab's history list and Year History so both stay in sync.
function renderMediaThumb(media, thumbClass) {
  const item = Array.isArray(media) && media[0];
  if (!item || !item.id || item.type !== "image") return "";
  const id = escapeHtml(String(item.id));
  const thumbUrl = `/api/image/serve/${id}/256x256`;
  const originalUrl = `/api/image/serve/${id}/original`;
  return `<img class="${thumbClass}" src="${thumbUrl}" data-action="view-photo" data-original="${originalUrl}" loading="lazy" alt="Photo" onerror="this.style.display='none'">`;
}

// ---------------------------------------------------------------------------
// Categories
//
// A task belongs to exactly one category, named by an arbitrary id string
// ("lawn", "house", "cars_bikes", and equally "solar", "pool", "equipment",
// ... — nothing here enumerates them). No behaviour is ever keyed off a
// particular id: a category is only ever compared for equality and looked up
// in a label map, so adding one is pure configuration.
//
// A task with no `category:` is treated as DEFAULT_CATEGORY. That is a
// *runtime* fallback for configs written before categories existed (this
// project started as a lawn-only card, so lawn is the only sensible default);
// nothing ever rewrites anyone's YAML to make it explicit.
const DEFAULT_CATEGORY = "lawn";

function categoryForTask(task) {
  const raw = task && task.category;
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_CATEGORY;
}

// THE filter. Everything category-scoped goes through here, so "which tasks
// participate" is decided in exactly one place and the status/section/history
// code downstream never learns that categories exist. A null/empty category
// means "no restriction" — the week calendar's unrestricted mode.
function tasksForCategory(tasks, category) {
  if (!category) return tasks || [];
  return (tasks || []).filter((t) => categoryForTask(t) === category);
}

function distinctCategories(tasks) {
  const out = [];
  for (const t of tasks || []) {
    const c = categoryForTask(t);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// Last-resort label when a category id has no configured label: "cars_bikes"
// -> "Cars Bikes". Any label that is not a plain word-per-separator rendering
// (e.g. "Cars/Bikes") has to be configured explicitly — which is precisely
// what `categories:` / `category_labels:` are for.
function defaultCategoryLabel(id) {
  return String(id)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Reads both supported spellings off a card config and returns {id: label}:
//
//   categories:                    category_labels:
//     - id: cars_bikes               cars_bikes: Cars/Bikes
//       label: Cars/Bikes
//
// `categories:` additionally fixes the selector's order (see categoryOrder);
// `category_labels:` is a pure label map and wins on conflict, so a bare
// `categories: [lawn, house]` id list can be labelled separately.
function buildCategoryLabels(config) {
  const map = {};
  if (Array.isArray(config && config.categories)) {
    for (const entry of config.categories) {
      if (typeof entry === "string") map[entry] = defaultCategoryLabel(entry);
      else if (entry && entry.id) map[entry.id] = typeof entry.label === "string" ? entry.label : defaultCategoryLabel(entry.id);
    }
  }
  const explicit = config && config.category_labels;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    for (const [id, label] of Object.entries(explicit)) if (typeof label === "string") map[id] = label;
  }
  return map;
}

function configuredCategoryIds(config) {
  if (!Array.isArray(config && config.categories)) return [];
  return config.categories.map((e) => (typeof e === "string" ? e : e && e.id)).filter(Boolean);
}

function categoryLabel(id, labels) {
  return (labels && labels[id]) || defaultCategoryLabel(id);
}

// The categories the selector offers, in order: every explicitly configured
// one first (so an empty category still gets a chip — categories exist because
// they are declared, not because a task happens to use them), then any
// category a task uses that was not declared, then the active one if it is
// somehow neither. Never empty.
function categoryOrder(config, tasks, active) {
  const out = [];
  const push = (id) => {
    if (id && !out.includes(id)) out.push(id);
  };
  for (const id of configuredCategoryIds(config)) push(id);
  for (const id of distinctCategories(tasks)) push(id);
  push(active);
  return out.length ? out : [DEFAULT_CATEGORY];
}

// ---------------------------------------------------------------------------
// Assignees
//
// A task may name exactly one person responsible for it:
//
//   people:                     # card level, ids stable, names editable
//     - id: person_1
//       name: Person 1
//   tasks:
//     - id: some_task
//       assigned_to: person_1   # a scalar id, never a list
//
// and a card instance may narrow itself to one of them:
//
//   assignee: person_1 | unassigned | all      # default: all
//
// This is a VISIBILITY property only. There is exactly one task and one
// completion state behind every view — filtering changes which tasks a card
// shows, never what a task is or what logging one does. Omitting `assigned_to`
// (every task written before this existed) means unassigned, and nothing is
// ever auto-assigned or auto-cleared.
const ASSIGNEE_ALL = "all";
const ASSIGNEE_UNASSIGNED = "unassigned";

// Normalizes the card's `people:` list. Entries without an id are dropped (a
// person with no stable id could not be referenced by a task), duplicates keep
// the first definition, and a missing name falls back to the id so a
// half-written config still renders something meaningful.
function normalizePeopleConfig(people, cardName) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(people) ? people : []) {
    const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      // eslint-disable-next-line no-console
      console.warn(`${cardName}: a people[] entry has no \`id\` and was ignored — an id is what tasks reference.`);
      continue;
    }
    if (seen.has(id)) {
      // eslint-disable-next-line no-console
      console.warn(`${cardName}: duplicate person id "${id}" — only the first definition is used.`);
      continue;
    }
    seen.add(id);
    out.push({ id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id });
  }
  return out;
}

// The person responsible for a task, or null when nobody is. A list is
// rejected outright rather than silently taking the first element: "exactly
// one assignee" is the rule, and quietly honouring half of a mistake would
// hide it.
function assigneeForTask(task, cardName) {
  const raw = task && task.assigned_to;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    // eslint-disable-next-line no-console
    console.warn(
      `${cardName || "lawn-maintenance-card"}: task "${(task && task.id) || "?"}" has a non-scalar \`assigned_to\` — a task may have at most one assignee, so it is treated as unassigned.`
    );
    return null;
  }
  const id = raw.trim();
  return id || null;
}

// THE assignee filter. Both cards call this and nothing else, so a person's
// task list, their week calendar and every count derived from either can never
// disagree. `all` (and anything falsy, i.e. an unconfigured card) passes
// everything through unchanged — that is what keeps old configs working.
function tasksForAssignee(tasks, assignee) {
  if (!assignee || assignee === ASSIGNEE_ALL) return tasks || [];
  if (assignee === ASSIGNEE_UNASSIGNED) return (tasks || []).filter((t) => assigneeForTask(t) === null);
  return (tasks || []).filter((t) => assigneeForTask(t) === assignee);
}

// Display name for an assignee id. An id that no longer exists in `people:`
// (renamed, removed, or a typo) is shown as unknown rather than hidden or
// silently reassigned — see the warning in warnUnknownAssignees.
function personName(id, people) {
  if (!id) return "Unassigned";
  const match = (people || []).find((p) => p.id === id);
  return match ? match.name : `Unknown: ${id}`;
}

function isKnownPerson(id, people) {
  return !!(people || []).some((p) => p.id === id);
}

// Warns once per unresolved id at config time. Deliberately does NOT touch the
// task: removing a person from `people:` must never silently delete or move
// their assignments, so they stay visible as unknown until reassigned by hand.
function warnUnknownAssignees(tasks, people, cardName) {
  if (!people || !people.length) return;
  const reported = new Set();
  for (const task of tasks || []) {
    const id = assigneeForTask(task, cardName);
    if (!id || isKnownPerson(id, people) || reported.has(id)) continue;
    reported.add(id);
    // eslint-disable-next-line no-console
    console.warn(
      `${cardName}: task "${task.id}" is assigned to "${id}", which is not in people[]. It is shown as unknown and left untouched — add the person back or reassign the task.`
    );
  }
}

// Fills in derived task/product ids and the boolean flags the rest of this
// file relies on. Module-level and card-name-parameterized so both cards
// normalize the same YAML into the same shape — LawnWeekCalendar reads the
// maintenance card's raw config straight out of the Lovelace config, which
// has not been through anyone's setConfig, so it has to run the exact same
// normalization or a task without an explicit `id` would resolve to a
// different entity in each card.
// Accepts either the full block or the `lockout_days: 30` shorthand and
// returns {lockout} / {} to spread onto the task. Validated here, once, so a
// typo surfaces as a console warning at config time rather than as a lockout
// that silently never fires. Returns {} — not a disabled lockout — when the
// task declares none, so `task.lockout` stays undefined for the vast majority
// of tasks and every check downstream is a plain truthiness test.
function normalizeLockoutConfig(t, id, cardName) {
  const raw = t.lockout || (t.lockout_days ? { days: t.lockout_days } : null);
  if (!raw) return {};
  const days = Number(raw.days);
  if (!Number.isFinite(days) || days <= 0) {
    // eslint-disable-next-line no-console
    console.warn(`${cardName}: task "${id}" has a lockout with no usable days (${JSON.stringify(raw.days)}) — ignoring it.`);
    return {};
  }
  const scope = raw.scope === undefined ? "category" : raw.scope;
  if (!Array.isArray(scope) && scope !== "category" && scope !== "all") {
    // eslint-disable-next-line no-console
    console.warn(`${cardName}: task "${id}" has lockout.scope "${scope}" — expected "category", "all", or a list of task ids. Falling back to "category".`);
  }
  return {
    lockout: {
      days,
      scope: Array.isArray(scope) || scope === "all" ? scope : "category",
      exempt: Array.isArray(raw.exempt) ? raw.exempt : undefined,
      label: raw.label || t.name || id,
    },
  };
}

function normalizeTaskConfig(tasks, cardName) {
  const seen = new Set();
  const normalized = tasks.map((t, i) => {
    const id = t.id || t.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!t.id) {
      // eslint-disable-next-line no-console
      console.warn(`${cardName}: task "${t.name}" has no explicit id, derived "${id}" from its name — set id explicitly to keep history stable if you rename it later.`);
    }
    if (seen.has(id)) {
      throw new Error(`${cardName}: duplicate task id "${id}" (task #${i + 1})`);
    }
    seen.add(id);
    const products = Array.isArray(t.products)
      ? t.products.map((p) => {
          const pid = p.id || String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
          if (!p.id) {
            // eslint-disable-next-line no-console
            console.warn(`${cardName}: product "${p.name}" on task "${t.name}" has no explicit id, derived "${pid}" — set it explicitly to keep logged history stable if you rename the product later.`);
          }
          return { ...p, id: pid };
        })
      : undefined;
    return { ...t, id, optional: !!t.optional, allow_photo: !!t.allow_photo, ...(products ? { products } : {}), ...normalizeLockoutConfig(t, id, cardName) };
  });

  // Identity colors are allocated across the WHOLE list at once — including the
  // ids follow-ups will be synthesized under, so a parent and its follow-ups
  // are as distinct from each other as any two tasks. Doing it here means both
  // cards get the same answer for free: each normalizes the same configured
  // list, so neither can invent a palette of its own.
  const entries = [];
  for (const task of normalized) {
    entries.push({ id: task.id, color: task.color });
    for (const followUp of followUpConfigsFor(task)) {
      entries.push({ id: `${task.id}${FOLLOW_UP_SEPARATOR}${followUp.id}`, color: followUp.color });
    }
  }
  const palette = allocateIdentityColors(entries);
  return normalized.map((task) => {
    const followUps = followUpConfigsFor(task);
    if (!followUps.length) return { ...task, color: palette[task.id] };
    // Rewritten onto whichever spelling the task used, so followUpTasksFor
    // finds the allocated color without knowing anything about allocation.
    const withColors = followUps.map((f) => ({ ...f, color: palette[`${task.id}${FOLLOW_UP_SEPARATOR}${f.id}`] }));
    return {
      ...task,
      color: palette[task.id],
      ...(Array.isArray(task.follow_ups) ? { follow_ups: withColors } : { follow_up: withColors[0] }),
    };
  });
}

// Turns one raw pyscript.lawn_<task_id> state object into the normalized
// {h, entries, sy, override} shape every status/date computation in this file
// expects. Pure (a state object in, plain data out) and module-level so both
// cards in this file normalize stored history through exactly one code path —
// LawnMaintenanceCard._taskState adds the live-vs-override state selection on
// top, LawnWeekCalendar just passes the live state straight in.
//
// A raw history entry is either a plain "YYYY-MM-DD" string or a
// {date, product_id?, fields?, snapshots?, captured_at?, media?} object (see
// pyscript/lawn_maintenance.py). `fields` is a generic {field_id: value} map
// for whatever the task's `entry_fields` config defines; `snapshots` is a
// generic {entity_id: {label, value, unit}} map for whatever the task's
// `snapshot_entities` config defines, captured once at log time and never
// re-read live afterward — `captured_at` is the ISO timestamp of that
// capture, distinct from `date` (the application date itself). `media` is a
// generic list of {id, type} references into HA's image_upload storage
// (allow_photo tasks only, v1 caps it at one item, but the shape is an array
// so a later multi-photo version needs no migration) — never image bytes.
// Normalized to {date, productId, fields, snapshots, capturedAt, media}
// objects, while `h` stays a plain array of date strings — the shape every
// existing status/date computation already expects.
function normalizeTaskState(st) {
  const attrs = (st && st.attributes) || {};
  const rawHistory = Array.isArray(attrs.history) ? attrs.history : [];
  const entries = rawHistory.map((e) =>
    typeof e === "string"
      ? { date: e, productId: null, fields: {}, snapshots: {}, capturedAt: null, media: [] }
      : {
          date: e.date,
          productId: e.product_id || null,
          fields: e.fields || {},
          snapshots: e.snapshots || {},
          capturedAt: e.captured_at || null,
          media: Array.isArray(e.media) ? e.media : [],
        }
  );
  return {
    h: entries.map((e) => e.date),
    entries,
    sy: Array.isArray(attrs.skipped_years) ? attrs.skipped_years : [],
    override: typeof attrs.next_due_override === "string" ? attrs.next_due_override : null,
  };
}

// Re-labels an already-computed status for an optional task (task.optional:
// true) so it never reads as an obligation — no "overdue"/"missed", just
// calm "available"/"starts"/"season finished" language. All the date math
// (nextDue, windowStart/End, occurrenceYear, override metadata, ...) comes
// straight from computeRecurringStatus/computeSeasonalStatus untouched, so
// history editing, ADD APPLICATION, and the next-due override panel keep
// working exactly as before — only statusKey/label/detail change here.
function applyOptionalRemap(task, status, today) {
  // Log tasks have no overdue/obligation concept to begin with (see
  // computeLogStatus) so `optional` simply doesn't apply to them — leave
  // their status untouched regardless of the flag.
  if (!task.optional || task.type === "log" || status.statusKey === "completed" || status.statusKey === "skipped") {
    return status;
  }

  if (task.type === "seasonal") {
    const key = OPTIONAL_SEASONAL_REMAP[status.statusKey];
    if (!key) return status;
    const label =
      key === "optional_upcoming" ? `Optional · starts ${formatShort(status.windowStart)}`
      : key === "optional_available" ? "Optional · available now"
      : "Optional · season finished";
    return { ...status, statusKey: key, label };
  }

  // Recurring: "inactive" covers both ways computeRecurringStatus can decide
  // the task isn't live right now — today's month is outside active_months,
  // or the interval landed in a season gap. Either way the useful question is
  // the same: does this task come back before the year ends?
  //
  //   yes -> Inactive, labelled with the month it resumes
  //   no  -> Season finished, alongside the seasonal tasks that are done
  //          for the year
  //
  // Tasks with no active_months configured have no season to be in or out of,
  // so they keep the original "Optional · inactive" in Optional rather than
  // being declared finished for a year they were never scheduled against.
  if (status.statusKey === "inactive") {
    const activeMonths = task.active_months || [];
    if (!activeMonths.length) {
      return { ...status, statusKey: "optional_finished", label: "Optional · inactive", detail: status.label };
    }
    const resumesMonth = nextActiveMonthThisYear(activeMonths, today);
    if (resumesMonth) {
      return {
        ...status,
        statusKey: "optional_inactive",
        label: `Inactive · resumes ${MONTH_ABBR[resumesMonth - 1]}`,
        // The fuller "Inactive · resumes September 2027"-style line stays as
        // the detail, so the expanded row still spells out the year when the
        // next occurrence is further off.
        detail: status.label,
      };
    }
    return { ...status, statusKey: "optional_season_over", label: "Optional · season finished", detail: status.label };
  }
  // Never completed, currently active — nothing to be "overdue" about yet.
  if (status.statusKey === "recommended_now") {
    return { ...status, statusKey: "optional_available", label: "Optional · available now" };
  }
  // Has a real calculated/overridden next-due date: if it's today or in the
  // past (would otherwise be "due today"/"overdue"), it's simply available
  // again; if it's still ahead (would otherwise be "due soon"/"upcoming"),
  // show the day count without any urgency framing.
  if (status.nextDue) {
    const diff = daysBetween(today, status.nextDue);
    if (diff <= 0) return { ...status, statusKey: "optional_available", label: "Optional · available again" };
    return { ...status, statusKey: "optional_upcoming", label: `Optional · next in ${diff} day${diff === 1 ? "" : "s"}` };
  }
  return status;
}

// statusKeys that mean "this seasonal task's annual window is over" —
// whether it went unused (optional_finished, from the missed_window remap),
// or was completed/skipped (passed through applyOptionalRemap unchanged).
// Only meaningful for seasonal tasks; a recurring task reaching the end of
// its interval is not a "season ending" and must stay in Optional (see
// computeTaskStatus below).
const OPTIONAL_SEASON_ENDED_KEYS = new Set(["optional_finished", "completed", "skipped"]);

// Keys that opt out of the blanket "optional tasks live in Optional" rule and
// use their STATUS_META section instead: an optional task that is out of
// season, done for the year, or whose window is still beyond the 30-day
// horizon belongs in Inactive/Season finished the same way a mandatory one
// does. season_inactive needs no optional-specific remap — "Inactive · starts
// 24 Sep" already reads calmly, and the row keeps its Optional badge.
const OPTIONAL_OWN_SECTION_KEYS = new Set(["optional_inactive", "optional_season_over", "season_inactive"]);

// Lockouts — an "establishment period". Some jobs make the lawn untouchable
// for a while afterwards: overseed it and for the next month you must not
// fertilize, spray or even mow, because the seedbed is still knitting in.
// A task declares that with:
//
//   lockout:
//     days: 30               # how long the period lasts, from the log date
//     scope: category        # "category" (default) | "all" | [task ids]
//     exempt: [some_task]    # optional ids that carry on as normal
//     label: Overseeding     # wording for the hold text and daily marker
//
// `lockout_days: 30` is accepted as shorthand for `lockout: {days: 30}`.
//
// What a lockout does and does NOT do is the whole design:
//   - It suppresses PREDICTIONS (due / overdue / available / target markers).
//   - It never touches HISTORY. Anything actually done still shows as done,
//     and every task stays fully loggable throughout — you still record
//     irrigation and lawn condition during establishment, and those entries
//     appear exactly as they always did.
// That split is why a locked-out task keeps its row instead of vanishing.

// A lockout started by `entry` ends `days` later, unless that entry carries an
// explicit `lockout_until` field — which is how "end the hold early" is
// stored, via the existing lawn_edit_history_entry service and its per-entry
// `fields`. No backend change was needed for it.
function lockoutEndFor(task, entry, startDate) {
  const explicit = entry && entry.fields ? entry.fields.lockout_until : null;
  if (explicit) {
    const parsed = parseISODate(explicit);
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  }
  return addDays(startDate, task.lockout.days);
}

// Every lockout covering `today`, newest first. A task can only be locking
// things down off the back of a real history entry, so a lockout that was
// never logged simply does not exist.
function activeLockouts(tasks, dataFor, today) {
  const out = [];
  for (const task of tasks) {
    if (!task.lockout || !task.lockout.days) continue;
    const data = dataFor(task.id);
    if (!data || !data.entries || !data.entries.length) continue;
    // entries are newest-first; the most recent one is the only one that can
    // still be running, so an overseeding done last autumn never re-arms.
    const entry = data.entries[0];
    const start = parseISODate(entry.date);
    if (!start || Number.isNaN(start.getTime())) continue;
    const end = lockoutEndFor(task, entry, start);
    if (today < start || today >= end) continue;
    const totalDays = Math.max(1, daysBetween(start, end));
    out.push({
      sourceId: task.id,
      sourceName: task.name,
      label: task.lockout.label || task.name,
      category: categoryForTask(task),
      scope: task.lockout.scope,
      exempt: task.lockout.exempt,
      start,
      end,
      totalDays,
      // Day 1 is the day it was logged, which is how you'd count it out loud.
      dayIndex: daysBetween(start, today) + 1,
    });
  }
  return out;
}

// Does `lockout` silence `task`? A lockout never silences the task that
// started it (you must still be able to see and correct the overseeding
// itself), and never reaches outside its declared scope — which defaults to
// the source task's own category, so overseeding the lawn says nothing about
// when the AC filter is due.
function lockoutSilences(lockout, task) {
  if (task.id === lockout.sourceId) return false;
  if (task.parent_id === lockout.sourceId) return false;
  if (Array.isArray(lockout.exempt) && lockout.exempt.includes(task.id)) return false;
  if (Array.isArray(lockout.scope)) return lockout.scope.includes(task.id);
  if (lockout.scope === "all") return true;
  return categoryForTask(task) === lockout.category;
}

// The lockout silencing this task, or null. First match wins; with more than
// one running the earliest-ending is irrelevant, since any single active
// lockout is enough to hold the task.
function lockoutFor(lockouts, task) {
  if (!lockouts || !lockouts.length) return null;
  return lockouts.find((l) => lockoutSilences(l, task)) || null;
}

function lockoutHoldLabel(lockout) {
  return `On hold · ${escapeHtml(lockout.label)} day ${lockout.dayIndex} of ${lockout.totalDays} · until ${formatShort(lockout.end)}`;
}

// Statuses a lockout must leave exactly as they are: all of them report
// something that already HAPPENED, and a lockout only ever suppresses what is
// predicted. Holding a completed task would be rewriting history.
const LOCKOUT_PASSTHROUGH_KEYS = new Set([
  "completed", "skipped", "missed_window", "follow_up_done", "optional_finished",
]);

function applyLockoutRemap(task, status, lockout) {
  if (!lockout) return status;
  if (LOCKOUT_PASSTHROUGH_KEYS.has(status.statusKey)) return status;
  // A log task has no due/overdue concept to suppress (computeLogStatus), and
  // several of them — irrigation, rainfall, lawn condition — are exactly what
  // you go on recording DURING an establishment period. They keep their row,
  // their section and their pin; `lockedOut` only tells logRowText to drop
  // the "may be due" nudge a target_interval_days would otherwise print, and
  // upcomingEventFor to stop drawing that target on the calendar.
  if (task.type === "log") return { ...status, lockedOut: lockout };
  return {
    ...status,
    statusKey: "on_hold",
    label: lockoutHoldLabel(lockout),
    lockedOut: lockout,
  };
}

// `parentData` is only used by follow-up tasks, which need their parent's
// history to know what they are following and whether they are still pending.
// `lockout` is the active lockout silencing this task, or null — resolved by
// the caller via lockoutFor() so the lockout set is computed once per render
// rather than per task.
function computeTaskStatus(task, data, today, parentData, lockout) {
  let status;
  if (task.type === "seasonal") status = computeSeasonalStatus(task, data, today);
  else if (task.type === "log") status = computeLogStatus(task, data, today);
  else if (task.type === "program") status = computeProgramStatus(task, data, today);
  else if (task.type === "treatment") status = computeTreatmentStatus(task, data, today);
  else if (task.type === "follow_up") status = computeFollowUpStatus(task, data, parentData, today);
  else status = computeRecurringStatus(task, data, today);
  status = applyOptionalRemap(task, status, today);
  // After the optional remap, not before: a lockout outranks "optional ·
  // available" just as it outranks "overdue", and both must land on the same
  // calm hold rather than one of them keeping its own wording.
  status = applyLockoutRemap(task, status, lockout);
  const meta = STATUS_META[status.statusKey] || STATUS_META.inactive;
  // Belt-and-suspenders: even if a future statusKey slipped through the
  // remap above without being reassigned, an optional task must never be
  // sorted into needs_attention. Within that constraint, an optional
  // seasonal task whose window has closed for the year (finished unused,
  // completed, or skipped) moves to Season finished alongside its
  // mandatory counterparts instead of sitting in Optional forever — its
  // label/color stay whatever the remap already set (calm purple, never
  // the red/orange "missed" styling), only the section changes. An optional
  // recurring task has three destinations, decided by the remap above and
  // carried here by its statusKey: Inactive when it returns later this year,
  // Season finished when it doesn't, Optional the rest of the time. Log tasks
  // always use their own "logs" section regardless of `optional` — that
  // flag has no meaning for them (see applyOptionalRemap).
  let section;
  if (task.type === "log") {
    section = meta.section;
  } else if (status.statusKey === "on_hold") {
    // Checked before the optional branches below, which would otherwise sweep
    // an optional task (iron, nitrogen boost) into "Optional" and leave it
    // advertising itself as available right through the lockout.
    section = meta.section;
  } else if (!task.optional) {
    section = meta.section;
  } else if (OPTIONAL_OWN_SECTION_KEYS.has(status.statusKey)) {
    section = meta.section;
  } else if (task.type === "seasonal" && OPTIONAL_SEASON_ENDED_KEYS.has(status.statusKey)) {
    section = "season_finished";
  } else {
    section = "optional";
  }
  // The accent every view paints this task with, resolved once here so the
  // planner row, its icon, and the week calendar all read the same value:
  // a meaningful status color, else the task's own identity color.
  const display = eventDisplayColor(task, status.statusKey);
  return { ...status, section, rank: meta.rank, color: display.color, attention: display.attention, icon: meta.icon };
}

// Product rotation — pure function, same style as the status engine above:
// looks at the most recent history entry that has a product_id, and
// suggests the first configured product whose group differs from it (a
// simple, honest "don't repeat the same mode of action back-to-back" rule,
// not a full resistance-management planner). Returns null if the task has
// no `products` configured.
function computeRotationSuggestion(task, data) {
  if (!task.products || !task.products.length) return null;
  const lastEntry = data.entries.find((e) => e.productId);
  const lastProduct = lastEntry ? task.products.find((p) => p.id === lastEntry.productId) || null : null;
  const suggested = task.products.find((p) => !lastProduct || p.group !== lastProduct.group) || task.products[0];
  return { lastProduct, suggested };
}

// Water-in instruction — pure function, same style as the status engine
// above. `product` (optional) is whichever product is currently relevant
// (selected in the log-application form, or the suggested rotation product
// for the always-visible details row); a product's own water_in/water_in_note
// take priority over the task's, independently per field. Returns null when
// neither the product nor the task configures water_in at all, so tasks
// that never set it behave exactly as before (no row/badge/hint anywhere).
function resolveWaterIn(task, product) {
  const waterIn = product && product.water_in !== undefined ? product.water_in : task.water_in;
  if (waterIn === undefined) return null;
  const note = product && product.water_in_note !== undefined ? product.water_in_note : task.water_in_note;
  return { waterIn: !!waterIn, note: note || null };
}

// Sensor-based advisories — pure helpers, generic across any numeric HA
// sensor (soil moisture, temperature, salinity, ...). task.advisory shape:
//   { entity, below?, above?, duration_hours?, message, clear_message? }
// Exactly one of below/above is expected. Deliberately no
// conductivity/EC-specific naming anywhere in this layer — see README.
function advisoryOperator(advisory) {
  if (!advisory) return null;
  if (advisory.below !== undefined) return { op: "below", threshold: advisory.below };
  if (advisory.above !== undefined) return { op: "above", threshold: advisory.above };
  return null;
}

function advisoryConditionMet(value, advisory) {
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  const cond = advisoryOperator(advisory);
  if (!cond) return false;
  return cond.op === "below" ? value < cond.threshold : value > cond.threshold;
}

// Reads the current value of an advisory's sensor straight from hass.states
// — never hard-codes a unit, and treats unavailable/unknown/non-numeric
// states as simply "not available" rather than throwing.
function readAdvisorySensor(hass, entityId) {
  const st = hass.states[entityId];
  if (!st) return { exists: false, available: false, value: null, unit: "", friendlyName: entityId, rawState: null };
  const raw = st.state;
  const numeric =
    raw !== "unavailable" && raw !== "unknown" && raw !== "" && raw !== undefined && !Number.isNaN(Number(raw))
      ? Number(raw)
      : null;
  return {
    exists: true,
    available: numeric !== null,
    rawState: raw,
    value: numeric,
    unit: (st.attributes && st.attributes.unit_of_measurement) || "",
    friendlyName: (st.attributes && st.attributes.friendly_name) || entityId,
  };
}

// snapshot_entities: [{entity, label}] captures each entity's live state at
// the moment a history entry is logged (DONE TODAY / ADD APPLICATION) so it
// can be stored *with* that entry — unlike the Advisory row above, which
// always reads live, a stored snapshot must keep showing what was true when
// it was captured, forever, even after the sensor moves on. Missing/
// unavailable/unknown entities are silently omitted rather than storing a
// misleading placeholder (option A from the snapshot_entities design: never
// save data that could be mistaken for a real reading) — logging still
// proceeds normally either way, a snapshot entity is never a hard
// requirement to complete an action. Unlike readAdvisorySensor, the raw
// state is kept as a string rather than forced numeric: a snapshot isn't
// restricted to sensors usable in a numeric advisory threshold.
function captureSnapshotEntities(hass, task) {
  const configs = task.snapshot_entities;
  if (!Array.isArray(configs) || !configs.length || !hass || !hass.states) return null;
  const snapshots = {};
  for (const cfg of configs) {
    if (!cfg || !cfg.entity) continue;
    const st = hass.states[cfg.entity];
    if (!st || st.state === undefined || st.state === "unavailable" || st.state === "unknown") continue;
    snapshots[cfg.entity] = {
      label: cfg.label || cfg.entity,
      value: st.state,
      unit: (st.attributes && st.attributes.unit_of_measurement) || "",
    };
  }
  return Object.keys(snapshots).length ? snapshots : null;
}

// Downscales (never upscales) a picked photo to a JPEG blob before upload —
// decoding via <img>/canvas relies on the browser's own EXIF-orientation
// normalization rather than parsing EXIF by hand, so no extra image library
// is needed. Long edge and quality are the only knobs (see allow_photo).
function resizeImageForUpload(file, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (!width || !height) {
        reject(new Error("Could not read the selected image."));
        return;
      }
      const longEdge = Math.max(width, height);
      if (longEdge > maxEdge) {
        const scale = maxEdge / longEdge;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not process the selected image."))), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read the selected image."));
    };
    img.src = objectUrl;
  });
}

function advisoryTriggerText(advisory) {
  const cond = advisoryOperator(advisory);
  if (!cond) return "";
  const durationText = advisory.duration_hours ? ` for ${advisory.duration_hours} h` : "";
  return `Trigger: ${cond.op} ${cond.threshold}${durationText}`;
}

function secondaryTime(task, status) {
  if (task.type === "seasonal") {
    return status.windowStart ? status.windowStart.getTime() : 0;
  }
  // An out-of-season recurring task sorts by when it comes back, not by a
  // nextDue that season state has already overruled — this is what puts the
  // Inactive section in "nearest return first" order alongside seasonal rows,
  // which sort by their window start above.
  if (status.resumesAt) return status.resumesAt.getTime();
  return status.nextDue ? status.nextDue.getTime() : status.last ? status.last.getTime() : 0;
}

function monthsOverlappingWindow(window) {
  const s = parseMonthDay(window.start);
  const e = parseMonthDay(window.end);
  const months = [];
  let m = s.month;
  while (true) {
    months.push(m);
    if (m === e.month) break;
    m = (m % 12) + 1;
    if (months.length > 12) break;
  }
  return months;
}

// ---------------------------------------------------------------------------
// Card element
// ---------------------------------------------------------------------------

class LawnMaintenanceCard extends HTMLElement {
  setConfig(config) {
    if (!config || !Array.isArray(config.tasks)) {
      throw new Error("lawn-maintenance-card: `tasks` (array) is required in the card config");
    }
    this._config = {
      // An explicit `title:` still wins outright, so configs that set one keep
      // exactly the heading they asked for; left null it follows the selected
      // category instead ("LAWN MAINTENANCE" / "HOUSE MAINTENANCE" / ...).
      title: typeof config.title === "string" ? config.title : null,
      tasks: normalizeTaskConfig(config.tasks, "lawn-maintenance-card"),
      show_overview: config.show_overview !== false,
      // Declared categories exist whether or not any task uses them yet — an
      // empty category is a normal state, not a reason to hide it.
      categories: configuredCategoryIds(config),
      categoryLabels: buildCategoryLabels(config),
      // The card's *initial* category. Never falls back to another category
      // just because this one is currently empty (that shows an empty state),
      // and never itself changes — see _setCategory.
      defaultCategory: typeof config.category === "string" && config.category.trim() ? config.category.trim() : null,
      people: normalizePeopleConfig(config.people, "lawn-maintenance-card"),
      // Which person's tasks this card instance shows. Absent means "all",
      // which is what makes every pre-assignee config keep working untouched.
      assignee:
        typeof config.assignee === "string" && config.assignee.trim() ? config.assignee.trim() : ASSIGNEE_ALL,
    };
    warnUnknownAssignees(this._config.tasks, this._config.people, "lawn-maintenance-card");
    if (
      this._config.assignee !== ASSIGNEE_ALL &&
      this._config.assignee !== ASSIGNEE_UNASSIGNED &&
      this._config.people.length &&
      !isKnownPerson(this._config.assignee, this._config.people)
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `lawn-maintenance-card: assignee "${this._config.assignee}" is not in people[] — this card will show no tasks until it is corrected.`
      );
    }
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    // Runtime-only selection, seeded from the config here and afterwards owned
    // solely by _setCategory. A Lovelace reload runs setConfig again and so
    // returns to the configured default; a hass push never touches it.
    this._activeCategory =
      this._config.defaultCategory ||
      categoryOrder(this._config, this._config.tasks, null)[0];
    this._built = false;
    this._view = "tasks";
    // Selected year on the Year History tab. Deliberately only ever
    // defaulted once (on first render of that tab, in _renderYearHistory) —
    // never reset on re-render — so a live update or tab switch never yanks
    // the user back to the newest year while they're looking at an older one.
    this._historyYear = null;
    // Newest-first by default, user-togglable, and — like _historyYear —
    // never reset by a re-render, tab switch, or year change; only ever
    // set here at construction and by the toggle-history-sort action.
    this._historySortDesc = true;
    this._expandedId = null;
    this._addAppOpen = null;
    this._addAppSelectedProduct = null;
    // The <input type="file"> selected for the currently-open log/add form
    // (allow_photo tasks only) — a File object, never persisted, cleared
    // every time that form closes for any reason. Never re-rendered from
    // this field directly; it only feeds save-add-app's upload step.
    this._addAppPhotoFile = null;
    this._overrideOpen = null;
    this._editingEntry = null;
    this._error = null;
    this._undo = null;
    // Original-image URL currently shown in the full-screen lightbox, or
    // null when closed — see _renderBody's direct DOM sync and the
    // view-photo/close-lightbox actions.
    this._lightboxUrl = null;
    // ESC-to-close on desktop needs a document-level listener (the
    // lightbox has no natural keyboard focus target for a bare Escape
    // keypress) — bound once here so add/removeEventListener in
    // connectedCallback/disconnectedCallback always refer to the same
    // function identity, and (re-)attached on every connectedCallback, not
    // just the first _buildShell(): a Lovelace card can be disconnected and
    // reconnected (e.g. editing the dashboard) without ever being torn down
    // and rebuilt from scratch, and disconnectedCallback always removes it.
    this._lightboxKeyHandler = (ev) => {
      if (ev.key === "Escape" && this._lightboxUrl) {
        this._lightboxUrl = null;
        this._renderBody();
      }
    };
    // _stateOverrides: task_id -> pyscript.lawn_<id> state object fetched
    // explicitly right after a successful write, so the UI is guaranteed to
    // reflect a save immediately even if HA's reactive hass-state push is
    // slow to arrive — see _refreshTaskState. Cleared automatically once the
    // normal reactive hass state catches up (compared by last_updated).
    this._stateOverrides = {};
    // _advisoryCache: task_id -> { fetching, fetchedAt, durationMet, error }
    // for advisory.duration_hours checks — see _refreshAdvisoryDuration.
    this._advisoryCache = {};
    // Task id whose assignee is currently being written back to the dashboard
    // config, or null. Only used to disable the select and show "Saving…".
    this._assigneeSaving = null;
    if (!this._collapsedSections) this._collapsedSections = new Set(DEFAULT_COLLAPSED_SECTIONS);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._scheduleRender();
  }

  connectedCallback() {
    // Keep due-date labels ("Due in X days") fresh even when no lawn
    // entity has changed (e.g. overnight, or on a dashboard with no other
    // frequently-updating entities to trigger the hass setter).
    if (!this._tick) {
      this._tick = setInterval(() => this._scheduleRender(), 60000);
    }
    document.addEventListener("keydown", this._lightboxKeyHandler);
  }

  disconnectedCallback() {
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
    // Keep the bound function itself (only remove the listener) — the card
    // can reconnect later without going through the constructor again, and
    // connectedCallback re-adds using this same reference.
    document.removeEventListener("keydown", this._lightboxKeyHandler);
  }

  // Home Assistant pushes a new `hass` object on *any* entity state change
  // anywhere on the dashboard (e.g. a sprinkler countdown ticking every
  // second) — re-rendering on every one of those would wipe out an open
  // <input type="date"> (closing the picker) or any other in-progress
  // interaction. Only re-render when a lawn task's own entity actually
  // changed, and never while an inline form is open.
  _scheduleRender() {
    if (!this._hass || !this._config) return;
    if (!this._built) {
      this._buildShell();
      this._built = true;
      this._lastSignature = null;
    }
    if (this._addAppOpen || this._overrideOpen || this._editingEntry) return;
    const sig = this._computeSignature();
    if (sig === this._lastSignature) return;
    this._lastSignature = sig;
    this._renderBody();
  }

  _computeSignature() {
    // Category-scoped: only the tasks actually on screen can change what is on
    // screen, so a write in another category cannot force a repaint here. The
    // active category is part of the signature because it changes the render
    // just as much as an entity does.
    const taskSig = this._categoryTasks()
      .map((t) => {
        const st = this._hass.states[`pyscript.lawn_${t.id}`];
        return st ? `${t.id}:${st.last_updated}` : `${t.id}:none`;
      })
      .join("|");
    // The expanded task's advisory sensor (if any) also needs to trigger a
    // re-render on its own changes — it's a third-party entity, not one of
    // the pyscript.lawn_* entities above, so it isn't covered by taskSig.
    // Collapsed tasks never show advisory data, so only the expanded one
    // needs to be watched here.
    const expandedTask = this._expandedId && this._config.tasks.find((t) => t.id === this._expandedId);
    const advisoryEntity = expandedTask && expandedTask.advisory && expandedTask.advisory.entity;
    const advisorySt = advisoryEntity ? this._hass.states[advisoryEntity] : null;
    const advisorySig = advisoryEntity ? `${advisoryEntity}:${advisorySt ? advisorySt.last_updated : "none"}` : "";
    return `${this._activeCategory}::${taskSig}::${advisorySig}`;
  }

  getCardSize() {
    return 2 + (this._config?.tasks?.length || 0);
  }

  static getStubConfig() {
    return {
      title: "LAWN MAINTENANCE",
      tasks: [
        { id: "fungicide", name: "Fungicide", type: "recurring", icon: "mdi:spray", active_months: [5, 6, 7, 8, 9], interval_days: 21 },
        { id: "tenacity", name: "Tenacity", type: "seasonal", icon: "mdi:flower-pollen", window: { start: "02-15", end: "03-15" } },
      ],
    };
  }

  // Configured tasks, each immediately followed by its synthesized follow-up
  // task (if it configures one). Everything that walks "all tasks" — the
  // render signature, action dispatch, the task list, year history — uses
  // this, so a follow-up behaves like a first-class task without ever being
  // written into the user's YAML. Follow-ups are always present here even
  // when nothing is pending; _renderTasks decides visibility, while history
  // and re-render signatures need them unconditionally.
  _allTasks() {
    return withFollowUps(this._config.tasks);
  }

  // The effective task list for everything the user can see: _allTasks()
  // narrowed to the selected category. Every view renders from this, so
  // switching category only ever changes *which* tasks participate — the
  // status engine, section routing, counts, details, history and overview all
  // keep running the identical code on a smaller list. Follow-ups filter
  // correctly for free, since they carry their parent's category.
  //
  // Action dispatch deliberately still uses the unfiltered _allTasks(): a
  // click can only come from a row that is on screen anyway, and resolving a
  // task id must never depend on the current selection.
  //
  // The assignee filter is applied HERE, in the same single place as the
  // category one and before any status/section/count work, so a person's rows,
  // their section counts, their Year Overview and their Year History are all
  // derived from one identical list. A follow-up inherits its parent's
  // assignee for the same reason it inherits the category: the pair must never
  // be split across two people's views.
  _categoryTasks() {
    return tasksForAssignee(tasksForCategory(this._allTasks(), this._activeCategory), this._config.assignee);
  }

  // True when this card is a personal view rather than the master one.
  _isPersonView() {
    return !!this._config.assignee && this._config.assignee !== ASSIGNEE_ALL;
  }

  _personName(id) {
    return personName(id, this._config.people || []);
  }

  // Single-select, never multi: one task has at most one assignee, and the
  // control makes that structurally true rather than merely documented.
  _renderAssigneeSelect(task) {
    const current = assigneeForTask(task, "lawn-maintenance-card") || "";
    const options = [`<option value="" ${current ? "" : "selected"}>Unassigned</option>`];
    for (const person of this._config.people || []) {
      options.push(
        `<option value="${escapeHtml(person.id)}" ${person.id === current ? "selected" : ""}>${escapeHtml(person.name)}</option>`
      );
    }
    // An id that is no longer in people[] keeps an option of its own, so simply
    // opening the menu can never silently drop an assignment the user has not
    // chosen to change.
    if (current && !isKnownPerson(current, this._config.people || [])) {
      options.push(`<option value="${escapeHtml(current)}" selected>Unknown: ${escapeHtml(current)}</option>`);
    }
    const pending = this._assigneeSaving === task.id;
    return `<select class="date-input assignee-select" data-role="assignee" data-task-id="${escapeHtml(task.id)}" ${
      pending ? "disabled" : ""
    }>${options.join("")}</select>${pending ? ` <span class="dim">Saving…</span>` : ""}`;
  }

  // Writes the choice back to the task's own configuration — the dashboard
  // config, which is where every other property of a task already lives. No
  // second store is introduced: assignment travels with the task.
  //
  // Read-modify-write, re-fetching immediately before saving so the window in
  // which a concurrent dashboard edit could be overwritten is as small as
  // possible, and touching ONLY this task's `assigned_to` key.
  async _setAssignee(taskId, personId) {
    if (!this._hass || !this._hass.callWS) return;
    this._assigneeSaving = taskId;
    this._error = null;
    this._renderBody();
    const urlPath = (window.location.pathname || "").split("/").filter(Boolean)[0] || null;
    const fetchConfig = (p) => this._hass.callWS(p ? { type: "lovelace/config", url_path: p } : { type: "lovelace/config" });
    try {
      let path = urlPath;
      let config;
      try {
        config = await fetchConfig(path);
      } catch (err) {
        // The url_path taken from the address bar can be wrong (a subview, a
        // moved dashboard); fall back to the default one exactly as the week
        // calendar's discovery does.
        path = null;
        config = await fetchConfig(null);
      }
      let found = 0;
      (function walk(node) {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        if (node.type === "custom:lawn-maintenance-card" && Array.isArray(node.tasks)) {
          for (const t of node.tasks) {
            if (t && t.id === taskId) {
              found++;
              // Unassigned is stored by ABSENCE, matching how every other
              // optional task property behaves, so an unassigned task is
              // byte-identical to one written before this feature existed.
              if (personId) t.assigned_to = personId;
              else delete t.assigned_to;
            }
          }
          return;
        }
        Object.values(node).forEach(walk);
      })(config);
      if (!found) throw new Error(`task "${taskId}" was not found in this dashboard's configuration`);
      await this._hass.callWS(
        path ? { type: "lovelace/config/save", url_path: path, config } : { type: "lovelace/config/save", config }
      );
      // Saving fires lovelace_updated; HA hands every card its new config, so
      // this card (and any other instance, on any tablet) re-runs setConfig and
      // picks the change up on its own. Nothing to patch by hand.
    } catch (err) {
      this._showError(`Could not save the assignee: ${err.message || err}`);
    } finally {
      this._assigneeSaving = null;
      this._renderBody();
    }
  }

  // The subtle "who is this for" marker on a row. Only ever rendered on the
  // master card: on a card already narrowed to one person it would repeat the
  // same name on every line, which is exactly what makes a personal tablet
  // feel like a list of somebody else's chores. Unassigned tasks show nothing
  // at all — absence is the quieter, and more common, signal.
  _assigneeChip(task) {
    // No people configured means the feature is not in use here: show nothing,
    // so a config written before assignees existed looks exactly as it did.
    if (!(this._config.people || []).length || this._isPersonView()) return "";
    const id = assigneeForTask(task, "lawn-maintenance-card");
    if (!id) return "";
    const known = isKnownPerson(id, this._config.people || []);
    return `<span class="assignee-chip ${known ? "" : "unknown"}" title="${escapeHtml(
      known ? `Assigned to ${this._personName(id)}` : `Assigned to "${id}", who is not in people[]`
    )}"><ha-icon icon="mdi:account${known ? "" : "-alert"}-outline"></ha-icon>${escapeHtml(this._personName(id))}</span>`;
  }

  // Recomputed per render rather than cached, so editing the dashboard's task
  // list is picked up without a special case.
  _categoryOrder() {
    return categoryOrder(this._config, this._config.tasks, this._activeCategory);
  }

  _categoryLabel(id) {
    return categoryLabel(id, this._config.categoryLabels);
  }

  // Runtime-only category selection. Nothing outside this method and
  // setConfig ever assigns _activeCategory, which is what keeps the choice
  // stable across live state pushes, completions, edits and re-renders.
  _setCategory(category) {
    if (!category || category === this._activeCategory) return;
    this._activeCategory = category;
    // Everything open belonged to the category being left — an expanded panel
    // or a half-filled form from the old category must not survive the switch.
    this._expandedId = null;
    this._addAppOpen = null;
    this._addAppSelectedProduct = null;
    this._addAppPhotoFile = null;
    this._overrideOpen = null;
    this._editingEntry = null;
    // Force the next hass push through _renderBody: the signature is
    // category-scoped, so entity changes that arrived while another category
    // was selected were legitimately never rendered.
    this._lastSignature = null;
    this._renderBody();
  }

  _taskState(taskId) {
    const liveSt = this._hass.states[`pyscript.lawn_${taskId}`];
    // Prefer an explicit post-write override (see _refreshTaskState) over
    // whatever the reactive hass state currently holds, until the reactive
    // state itself catches up to (or supersedes) the override — this is
    // what guarantees the UI reflects a save immediately even if HA's
    // websocket push for that state_changed event is delayed.
    const override = this._stateOverrides[taskId];
    let st = liveSt;
    if (override) {
      // Compare actual parsed instants, not the raw last_updated strings --
      // hass.callApi (REST) returns microsecond precision with a "+00:00"
      // suffix (e.g. "...904131+00:00") while the websocket-pushed state
      // uses millisecond precision with "Z" (e.g. "...904Z"). Those two
      // strings can represent the exact same instant yet compare unequal
      // as plain strings (a digit sorts before "Z"), which was silently
      // discarding a just-fetched, correct override whenever the write
      // landed fast enough for both timestamps to fall in the same
      // millisecond -- exactly the case that should always win.
      const overrideTime = Date.parse(override.last_updated);
      const liveTime = liveSt ? Date.parse(liveSt.last_updated) : -Infinity;
      if (!liveSt || overrideTime >= liveTime) {
        st = override;
      } else {
        delete this._stateOverrides[taskId];
      }
    }
    return normalizeTaskState(st);
  }

  _showError(msg) {
    this._error = msg;
    this._renderBody();
    clearTimeout(this._errorTimer);
    this._errorTimer = setTimeout(() => {
      this._error = null;
      this._renderBody();
    }, 7000);
  }

  // Same error banner as _showError, but never calls _renderBody() — used
  // only for a failed photo upload, where the log/add form (date, condition,
  // and the browser-only <input type="file"> selection, which can never be
  // restored programmatically once cleared) must stay exactly as the user
  // left it so they can just press Save again.
  _showFormError(msg) {
    this._error = msg;
    this._el.errorBanner.hidden = false;
    this._el.errorBanner.textContent = msg;
    clearTimeout(this._errorTimer);
    this._errorTimer = setTimeout(() => {
      this._error = null;
      this._el.errorBanner.hidden = true;
    }, 7000);
  }

  // Resizes the picked file client-side then POSTs it to HA's native
  // image_upload REST API, same endpoint/auth mechanism confirmed in the
  // proof-of-concept: multipart "file" field, Authorization: Bearer <token>
  // pulled from the frontend's own hass.auth (never hard-coded, logged, or
  // stored). Resolves with just the returned image id — image bytes never
  // touch pyscript or lawn history, only this id does.
  async _uploadPhoto(file) {
    const blob = await resizeImageForUpload(file, 1800, 0.82);
    const token = this._hass.auth && this._hass.auth.data && this._hass.auth.data.access_token;
    if (!token) throw new Error("not authenticated");
    const formData = new FormData();
    formData.append("file", blob, (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg");
    const res = await fetch("/api/image/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    const json = await res.json().catch(() => null);
    if (!json || !json.id) throw new Error("upload response had no image id");
    return json.id;
  }

  // Best-effort cleanup of an image_upload file — used when a history write
  // fails right after a successful upload (avoids an orphaned file) and when
  // a history entry with a photo is deleted. The proof-of-concept confirmed
  // deletion is a WebSocket command, not a REST call, so it goes through the
  // same authenticated hass.connection every other card interaction uses.
  // Never throws: a failed cleanup just leaves an orphaned file behind,
  // which is preferable to breaking the action the user actually asked for.
  _deleteImage(imageId) {
    return this._hass
      .callWS({ type: "image/delete", image_id: imageId })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`lawn-maintenance-card: could not remove image ${imageId} (it may now be orphaned)`, err);
      });
  }

  _showUndo(task, date) {
    this._undo = { taskId: task.id, taskName: task.name, date };
    this._renderBody();
    clearTimeout(this._undoTimer);
    this._undoTimer = setTimeout(() => {
      this._undo = null;
      this._renderBody();
    }, 8000);
  }

  // Returns the underlying promise (rejected on failure, after showing the
  // error banner) so callers can decide what to do on success vs failure —
  // e.g. only close an inline form and refresh once the write is confirmed,
  // never optimistically before that.
  _callService(domain, service, data, taskName) {
    return this._hass.callService(domain, service, data).catch((err) => {
      this._showError(
        `Could not save "${taskName}" — is the pyscript integration + lawn_maintenance.py installed? (${err.message || err})`
      );
      throw err;
    });
  }

  // Explicitly re-reads a pyscript.lawn_<id> entity right after a
  // successful write and stores it as a short-lived override (see
  // _taskState) so the card reflects the save immediately regardless of
  // whether/when HA's own reactive state_changed push for that entity
  // arrives. Best-effort: on failure this just no-ops and leaves the normal
  // reactive path to catch up whenever it next fires.
  //
  // `verify`, when given, is `(fetchedState) => boolean` checking for the
  // specific outcome this write should produce (e.g. "skipped_years now
  // includes this year") — retries until it's true. Prefer this over the
  // fallback "did last_updated move" heuristic whenever the caller can
  // state one: rapid repeated writes to the same pyscript entity can have
  // their state_changed events coalesced/dropped after the first one, so a
  // fresh GET can keep echoing an already-stale last_updated even though
  // the underlying write did land — "did the timestamp move" then never
  // fires again, which is exactly what made skip/unskip look like it
  // "worked once, then stopped." Checking the actual expected content
  // sidesteps that entirely.
  async _refreshTaskState(taskId, verify) {
    if (!this._hass) return;
    const entityId = `pyscript.lawn_${taskId}`;
    const before = this._stateOverrides[taskId] || this._hass.states[entityId];
    const beforeUpdated = before ? before.last_updated : null;
    let st = null;
    // Up to ~9s total (250+500+...+2000ms) — a manual click can afford a
    // few extra seconds of retry for reliability, and the observed lag
    // here has been longer than a couple seconds under load.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        st = await this._hass.callApi("GET", `states/${encodeURIComponent(entityId)}`);
      } catch (err) {
        return;
      }
      const success = verify ? verify(st) : !beforeUpdated || st.last_updated !== beforeUpdated;
      if (success) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (st) this._stateOverrides[taskId] = st;
    this._renderBody();
  }

  // Checks whether an advisory's condition has held continuously for
  // advisory.duration_hours, using HA's own recorder history for the
  // sensor — the "cleanest HA-native solution" for duration tracking
  // instead of reconstructing it client-side or faking it in localStorage.
  // include_start_time_state defaults to true on this endpoint, so the
  // returned points already cover the full window (seeded with whatever
  // state was active exactly at the window start).
  async _refreshAdvisoryDuration(task) {
    const advisory = task.advisory;
    const cond = advisoryOperator(advisory);
    if (!advisory || !advisory.duration_hours || !cond || !this._hass) return;
    const existing = this._advisoryCache[task.id];
    if (existing && existing.fetching) return;
    this._advisoryCache[task.id] = { ...existing, fetching: true };
    let durationMet = false;
    let error = null;
    try {
      const end = new Date();
      const start = new Date(end.getTime() - advisory.duration_hours * 3600 * 1000);
      const path = `history/period/${start.toISOString()}?filter_entity_id=${encodeURIComponent(advisory.entity)}&minimal_response&no_attributes`;
      const result = await this._hass.callApi("GET", path);
      const points = (result && result[0]) || [];
      // Conservative: no history at all (new entity, recorder disabled/short
      // retention) means we can't confirm the full window, so treat as not
      // met rather than optimistically active.
      //
      // Checking the VALUES is not enough on its own — the window also has to
      // actually be covered. include_start_time_state seeds a point at the
      // window start only for an entity that already existed then; a sensor
      // added recently, or one whose rows have been purged, simply returns
      // fewer points, and every() over those would happily report that a
      // 5-day condition had held after two days of data. Require the first
      // point to sit at (or before) the window start, with a small tolerance
      // for the gap between a recorder write and the exact boundary.
      const COVERAGE_TOLERANCE_MS = 10 * 60 * 1000;
      // No `|| 0` fallback: epoch 0 sits far before the window start and
      // would read as perfect coverage. A point we cannot date is a point we
      // cannot verify, so it leaves firstTs NaN and the window uncovered.
      const firstStamp = points.length ? points[0].last_changed || points[0].last_updated : null;
      const firstTs = firstStamp ? new Date(firstStamp).getTime() : NaN;
      const windowCovered = Number.isFinite(firstTs) && firstTs <= start.getTime() + COVERAGE_TOLERANCE_MS;
      durationMet =
        points.length > 0 &&
        windowCovered &&
        points.every((p) => advisoryConditionMet(Number(p.state), advisory));
    } catch (err) {
      error = err;
    }
    this._advisoryCache[task.id] = { fetching: false, fetchedAt: Date.now(), durationMet, error };
    if (this._expandedId === task.id) this._renderBody();
  }

  // Synchronous snapshot used by _renderDetails: current sensor reading +
  // whether the advisory is active right now. For duration-based advisories
  // this reads the last cached duration check (refreshing it in the
  // background if stale) rather than blocking the render on a fetch.
  _advisoryView(task) {
    const advisory = task.advisory;
    if (!advisory || !advisory.entity || !advisoryOperator(advisory)) return null;
    const reading = readAdvisorySensor(this._hass, advisory.entity);
    const conditionNow = reading.available && advisoryConditionMet(reading.value, advisory);
    let active = conditionNow;
    if (advisory.duration_hours) {
      const cache = this._advisoryCache[task.id] || null;
      const stale = !cache || Date.now() - (cache.fetchedAt || 0) > 5 * 60 * 1000;
      if (stale && !(cache && cache.fetching)) this._refreshAdvisoryDuration(task);
      active = conditionNow && !!(cache && cache.durationMet);
    }
    return { advisory, reading, active };
  }

  _setExpanded(id) {
    this._expandedId = id;
    this._addAppOpen = null;
    this._addAppSelectedProduct = null;
    this._addAppPhotoFile = null;
    this._overrideOpen = null;
    this._editingEntry = null;
    this._renderBody();
  }

  _handleAction(action, el) {
    const taskId = el.dataset.taskId;
    // _allTasks so a follow-up's own action button ("WASHED TODAY") resolves
    // to its synthesized task and goes through the identical write path.
    const task = this._allTasks().find((t) => t.id === taskId);
    const body = this._el.body;
    // save-add-app / save-override / save-edit look up their date input by
    // [data-role] alone (not scoped to `taskId`) — safe only because at most
    // one task is expanded at a time, so at most one such input ever exists.

    switch (action) {
      case "toggle-history-sort": {
        this._historySortDesc = !this._historySortDesc;
        this._renderBody();
        break;
      }
      case "view-photo": {
        const url = el.dataset.original;
        if (url) {
          this._lightboxUrl = url;
          this._renderBody();
        }
        break;
      }
      case "done": {
        // prompt_on_done: the task wants its entry_fields CHOSEN rather than
        // silently defaulted (an inspection result is the outcome of the
        // action, not a constant), so route the one-tap action through the
        // same log form products/photos already use. Opt-in, so every existing
        // task keeps its instant "record the YAML default" behaviour.
        if ((task.products && task.products.length) || task.allow_photo || task.prompt_on_done) {
          // A product must be chosen, or a photo may be attached — either
          // way logging needs user interaction, so open the log-application
          // form (pre-filled with today) instead of instant-logging. Handles
          // both the full DONE TODAY/LOG CONDITION button and the collapsed
          // row's quick-done checkmark/button.
          this._expandedId = taskId;
          this._addAppOpen = taskId;
          this._addAppSelectedProduct = null;
          this._addAppPhotoFile = null;
          this._overrideOpen = null;
          this._editingEntry = null;
          this._renderBody();
          break;
        }
        const today = formatISODate(todayLocal());
        // Silently attach each entry_fields' configured default (e.g.
        // mowing height) — the quick action never prompts for it, per the
        // "record the value that's in yaml" requirement; changing a
        // specific entry's value afterward is what the edit dropdown is for.
        const doneData = { task_id: taskId, date: today };
        const doneFields = defaultEntryFieldValues(task);
        if (Object.keys(doneFields).length) doneData.fields = doneFields;
        // snapshot_entities: capture each configured entity's live state
        // right now and freeze it into this entry — no prompt, same as
        // entry_fields defaults, since a quick action never pauses for
        // input. captured_at records the actual capture instant separately
        // from `date` (the application date), which for DONE TODAY are the
        // same day but won't be for a backdated ADD APPLICATION.
        const doneSnapshots = captureSnapshotEntities(this._hass, task);
        if (doneSnapshots) {
          doneData.snapshots = doneSnapshots;
          doneData.captured_at = new Date().toISOString();
        }
        // Wait for confirmation before showing the undo banner — no
        // optimistic "saved" feedback ahead of the actual write succeeding.
        this._callService("pyscript", "lawn_log_task", doneData, task.name)
          .then(() => {
            this._refreshTaskState(taskId);
            this._showUndo(task, today);
          })
          .catch(() => {});
        break;
      }
      case "toggle-add-app":
        this._addAppOpen = this._addAppOpen === taskId ? null : taskId;
        this._addAppSelectedProduct = null;
        this._addAppPhotoFile = null;
        this._overrideOpen = null;
        this._editingEntry = null;
        this._renderBody();
        break;
      case "save-add-app": {
        const input = body.querySelector('[data-role="add-app-date"]');
        const date = input && input.value;
        if (!date) return;
        const productSelect = body.querySelector('[data-role="add-app-product"]');
        const data = { task_id: taskId, date };
        if (productSelect && productSelect.value) data.product_id = productSelect.value;
        const addAppFieldEls = [...body.querySelectorAll('[data-role="add-app-field"]')];
        const addAppFields = addAppFieldEls.length
          ? Object.fromEntries(addAppFieldEls.map((el) => [el.dataset.fieldId, el.dataset.fieldType === "number" ? Number(el.value) : el.value]))
          : defaultEntryFieldValues(task);
        if (Object.keys(addAppFields).length) data.fields = addAppFields;
        // snapshot_entities: same live capture as DONE TODAY. `date` here
        // may be backdated, but the sensor reading is always "now" — there
        // is no historical sensor lookup (see snapshot_entities design
        // notes) — so captured_at (always "now") and date (the selected
        // application date) can legitimately differ.
        const addAppSnapshots = captureSnapshotEntities(this._hass, task);
        if (addAppSnapshots) {
          data.snapshots = addAppSnapshots;
          data.captured_at = new Date().toISOString();
        }
        // The form stays open with whatever the user entered until the save
        // is confirmed — only close it and refresh on success; on failure
        // _callService has already shown the error banner and the form is
        // left untouched so the user can just retry.
        const logEntry = () =>
          this._callService("pyscript", "lawn_log_task", data, task.name).then(() => {
            this._addAppOpen = null;
            this._addAppSelectedProduct = null;
            this._addAppPhotoFile = null;
            this._refreshTaskState(taskId);
            this._renderBody();
          });

        const photoFile = task.allow_photo ? this._addAppPhotoFile : null;
        if (!photoFile) {
          logEntry().catch(() => {});
          break;
        }
        // A photo was picked: upload it first and only ever call the lawn
        // history service once that succeeds — never write an entry that
        // claims a photo exists when the upload actually failed. A failed
        // upload uses _showFormError (not _showError) so the form's date/
        // condition/file selection is left exactly as the user set it,
        // ready to just press Save again.
        this._uploadPhoto(photoFile)
          .then((imageId) => {
            data.media = [{ id: imageId, type: "image" }];
            // If the upload succeeded but the history write then fails,
            // best-effort delete the now-orphaned image rather than leaving
            // it stranded — _callService has already shown the error banner
            // for this failure.
            logEntry().catch(() => this._deleteImage(imageId));
          })
          .catch((err) => {
            this._showFormError(`Could not upload photo — ${err.message || err}`);
          });
        break;
      }
      case "skip-year": {
        const year = Number(el.dataset.year);
        this._callService("pyscript", "lawn_skip_year", { task_id: taskId, year }, task.name)
          .then(() => this._refreshTaskState(taskId, (st) => (st.attributes.skipped_years || []).includes(year)))
          .catch(() => {});
        break;
      }
      case "unskip-year": {
        const year = Number(el.dataset.year);
        this._callService("pyscript", "lawn_unskip_year", { task_id: taskId, year }, task.name)
          .then(() => this._refreshTaskState(taskId, (st) => !(st.attributes.skipped_years || []).includes(year)))
          .catch(() => {});
        break;
      }
      case "toggle-override":
        this._overrideOpen = this._overrideOpen === taskId ? null : taskId;
        this._addAppOpen = null;
        this._addAppPhotoFile = null;
        this._editingEntry = null;
        this._renderBody();
        break;
      case "save-override": {
        const input = body.querySelector('[data-role="override-date"]');
        const date = input && input.value;
        if (!date) return;
        this._callService("pyscript", "lawn_set_next_due_override", { task_id: taskId, date }, task.name)
          .then(() => {
            this._overrideOpen = null;
            this._refreshTaskState(taskId);
            this._renderBody();
          })
          .catch(() => {});
        break;
      }
      case "clear-override":
        this._callService("pyscript", "lawn_clear_next_due_override", { task_id: taskId }, task.name)
          .then(() => this._refreshTaskState(taskId))
          .catch(() => {});
        break;
      case "edit-entry":
        this._editingEntry = { taskId, date: el.dataset.date };
        this._addAppOpen = null;
        this._addAppPhotoFile = null;
        this._overrideOpen = null;
        this._renderBody();
        break;
      case "cancel-edit":
        this._editingEntry = null;
        this._renderBody();
        break;
      case "save-edit": {
        const input = body.querySelector('[data-role="edit-date"]');
        const newDate = input && input.value;
        const oldDate = el.dataset.date;
        if (!newDate) return;
        // One [data-role="edit-field"] control per task.entry_fields entry
        // (see _renderHistoryItem) — collect them all into a generic
        // {field_id: value} map rather than anything mowing-specific.
        // data-field-type says whether to read it back as a number or a
        // string, since number fields are <select>s and text fields are
        // plain <input>s.
        const fieldEls = [...body.querySelectorAll('[data-role="edit-field"]')];
        const editFields = {};
        fieldEls.forEach((el) => {
          editFields[el.dataset.fieldId] = el.dataset.fieldType === "number" ? Number(el.value) : el.value;
        });
        const hasFields = fieldEls.length > 0;
        if (newDate === oldDate && !hasFields) {
          this._editingEntry = null;
          this._renderBody();
          break;
        }
        const editData = { task_id: taskId, old_date: oldDate, new_date: newDate };
        if (hasFields) editData.fields = editFields;
        this._callService("pyscript", "lawn_edit_history_entry", editData, task.name)
          .then(() => {
            this._editingEntry = null;
            this._refreshTaskState(taskId);
            this._renderBody();
          })
          .catch(() => {});
        break;
      }
      case "delete-entry": {
        const date = el.dataset.date;
        if (!confirm(`Delete the ${formatShortYear(parseISODate(date))} entry for ${task.name}?`)) return;
        // Capture this entry's media ids *before* deleting it — once the
        // history entry is gone, there's nothing left to read them from.
        // Only ever delete the underlying images after the history
        // deletion itself has actually succeeded, so a failed delete never
        // strands a still-referenced photo.
        const entryBeingDeleted = this._taskState(taskId).entries.find((e) => e.date === date);
        const mediaIds = entryBeingDeleted ? (entryBeingDeleted.media || []).map((m) => m.id).filter(Boolean) : [];
        this._callService("pyscript", "lawn_delete_history_entry", { task_id: taskId, date }, task.name)
          .then(() => {
            this._refreshTaskState(taskId);
            mediaIds.forEach((id) => this._deleteImage(id));
          })
          .catch(() => {});
        break;
      }
      case "toggle-section": {
        const section = el.dataset.section;
        if (this._collapsedSections.has(section)) this._collapsedSections.delete(section);
        else this._collapsedSections.add(section);
        this._renderBody();
        break;
      }
      default:
        break;
    }
  }

  _handleUndo() {
    if (!this._undo) return;
    const { taskId, taskName, date } = this._undo;
    clearTimeout(this._undoTimer);
    this._undo = null;
    this._callService("pyscript", "lawn_delete_history_entry", { task_id: taskId, date }, taskName)
      .then(() => this._refreshTaskState(taskId))
      .catch(() => {});
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._built) {
      this._buildShell();
      this._built = true;
    }
    this._renderBody();
  }

  _buildShell() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>${CSS}</style>
      <ha-card>
        <div class="header">
          <div class="title"></div>
          <div class="view-toggle">
            <button class="tab tab-tasks">Tasks</button>
            <button class="tab tab-overview">Year Overview</button>
            <button class="tab tab-history">Year History</button>
          </div>
        </div>
        <div class="category-bar" hidden></div>
        <div class="error-banner" hidden></div>
        <div class="undo-banner" hidden></div>
        <div class="body"></div>
        <div class="lightbox" hidden>
          <div class="lightbox-backdrop" data-action="close-lightbox"></div>
          <ha-icon class="lightbox-close" data-action="close-lightbox" icon="mdi:close"></ha-icon>
          <img class="lightbox-img" alt="Photo">
        </div>
      </ha-card>
    `;
    this._el = {
      title: root.querySelector(".title"),
      tabTasks: root.querySelector(".tab-tasks"),
      tabOverview: root.querySelector(".tab-overview"),
      tabHistory: root.querySelector(".tab-history"),
      categoryBar: root.querySelector(".category-bar"),
      errorBanner: root.querySelector(".error-banner"),
      undoBanner: root.querySelector(".undo-banner"),
      body: root.querySelector(".body"),
      lightbox: root.querySelector(".lightbox"),
      lightboxImg: root.querySelector(".lightbox-img"),
    };
    this._el.lightbox.addEventListener("click", (ev) => {
      if (ev.target.closest('[data-action="close-lightbox"]')) {
        this._lightboxUrl = null;
        this._renderBody();
      }
    });
    this._el.tabTasks.addEventListener("click", () => {
      this._view = "tasks";
      this._render();
    });
    this._el.tabOverview.addEventListener("click", () => {
      this._view = "overview";
      this._render();
    });
    this._el.tabHistory.addEventListener("click", () => {
      this._view = "history";
      this._render();
    });

    this._el.categoryBar.addEventListener("click", (ev) => {
      const chip = ev.target.closest("[data-category]");
      if (chip) this._setCategory(chip.dataset.category);
    });

    this._el.undoBanner.addEventListener("click", (ev) => {
      if (ev.target.closest('[data-action="undo"]')) this._handleUndo();
    });

    this._el.body.addEventListener("click", (ev) => {
      const actionEl = ev.target.closest("[data-action]");
      if (actionEl) {
        ev.stopPropagation();
        this._handleAction(actionEl.dataset.action, actionEl);
        return;
      }
      const header = ev.target.closest(".task-header");
      if (header) {
        const id = header.dataset.taskId;
        this._setExpanded(this._expandedId === id ? null : id);
      }
    });

    // Live-updates the water-in hint under the log-application form as the
    // user changes the selected product, without touching anything else —
    // a full _renderBody() re-render is safe here (unlike on a hass tick)
    // because it's user-initiated and _addAppSelectedProduct makes the
    // reopened <select> keep reflecting their choice instead of resetting
    // to the suggested product.
    this._el.body.addEventListener("change", (ev) => {
      const select = ev.target.closest('[data-role="add-app-product"]');
      if (select) {
        this._addAppSelectedProduct = select.value || null;
        this._renderBody();
        return;
      }
      const assigneeSelect = ev.target.closest('[data-role="assignee"]');
      if (assigneeSelect) {
        this._setAssignee(assigneeSelect.dataset.taskId, assigneeSelect.value);
        return;
      }
      const yearSelect = ev.target.closest('[data-role="history-year"]');
      if (yearSelect) {
        this._historyYear = Number(yearSelect.value);
        this._renderBody();
        return;
      }
      const photoInput = ev.target.closest('[data-role="add-app-photo"]');
      if (photoInput) {
        // Only ever held in memory as a File object, never rendered back
        // into the (unsettable) file input itself -- just tracked so
        // save-add-app can read it and so the small "Selected: name" line
        // below the picker reflects the choice across re-renders.
        this._addAppPhotoFile = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;
        this._renderBody();
      }
    });
  }

  _renderBody() {
    const order = this._categoryOrder();
    // An explicit `title:` still wins outright. Otherwise a card narrowed to
    // one person is titled with that person's configured name — their tablet
    // reads as "their tasks" rather than repeating the label on every row —
    // and the master card keeps the existing category heading unchanged.
    this._el.title.textContent =
      this._config.title ||
      (this._isPersonView()
        ? (this._config.assignee === ASSIGNEE_UNASSIGNED
            ? "UNASSIGNED"
            : this._personName(this._config.assignee).toUpperCase())
        : `${this._categoryLabel(this._activeCategory).toUpperCase()} MAINTENANCE`);
    // A single category is the pre-categories world: no selector at all, so
    // an existing config that never heard of categories looks untouched.
    this._el.categoryBar.hidden = order.length < 2;
    this._el.categoryBar.innerHTML = order
      .map(
        (id) =>
          `<button class="category-chip ${id === this._activeCategory ? "active" : ""}" data-category="${escapeHtml(id)}"${
            id === this._activeCategory ? ' aria-current="true"' : ""
          }>${escapeHtml(this._categoryLabel(id))}</button>`
      )
      .join("");
    this._el.tabTasks.classList.toggle("active", this._view === "tasks");
    this._el.tabOverview.classList.toggle("active", this._view === "overview");
    this._el.tabHistory.classList.toggle("active", this._view === "history");
    this._el.tabOverview.hidden = !this._config.show_overview;

    if (this._error) {
      this._el.errorBanner.hidden = false;
      this._el.errorBanner.textContent = this._error;
    } else {
      this._el.errorBanner.hidden = true;
    }

    if (this._undo) {
      this._el.undoBanner.hidden = false;
      this._el.undoBanner.innerHTML = `<span>Logged ${escapeHtml(this._undo.taskName)} for today.</span><button class="text-btn" data-action="undo">UNDO</button>`;
    } else {
      this._el.undoBanner.hidden = true;
    }

    if (this._lightboxUrl) {
      this._el.lightbox.hidden = false;
      if (this._el.lightboxImg.src !== this._lightboxUrl) this._el.lightboxImg.src = this._lightboxUrl;
    } else {
      this._el.lightbox.hidden = true;
      this._el.lightboxImg.removeAttribute("src");
    }

    const today = todayLocal();
    this._el.body.innerHTML =
      this._view === "overview"
        ? this._renderOverview()
        : this._view === "history"
        ? this._renderYearHistory()
        : this._renderTasks(today);
  }

  _renderTasks(today) {
    const buckets = {};
    for (const s of SECTION_ORDER) buckets[s] = [];
    // Pinned log tasks (type: log, pinned: true) render above every normal
    // section instead of inside "logs" — they're excluded from the bucket
    // loop entirely so they never show up twice. Non-pinned log tasks fall
    // through to the normal "logs" bucket like any other section.
    const pinnedRows = [];

    // Off the FULL configured list, not this._categoryTasks(): a lockout's
    // scope is decided by the source task's own category, so it has to be
    // found even while a different category is on screen. Nothing leaks —
    // lockoutSilences() still refuses to reach outside that scope.
    const lockouts = activeLockouts(this._config.tasks, (id) => this._taskState(id), today);

    for (const task of this._categoryTasks()) {
      const data = this._taskState(task.id);
      const parentData = task.type === "follow_up" ? this._taskState(task.parent_id) : null;
      const status = computeTaskStatus(task, data, today, parentData, lockoutFor(lockouts, task));
      // A follow-up only exists on the list while it is actually outstanding:
      // once logged (or before its parent has ever been done) it drops out of
      // the actionable list entirely, its record living on in history.
      if (task.type === "follow_up" && !status.pending) continue;
      const row = { task, data, status, sec: secondaryTime(task, status) };
      if (task.type === "log" && task.pinned) {
        pinnedRows.push(row);
      } else {
        buckets[status.section].push(row);
      }
    }

    let html = "";
    if (pinnedRows.length) {
      html += `<div class="pinned-section">${pinnedRows.map((r) => this._renderTaskRow(r.task, r.data, r.status)).join("")}</div>`;
    }
    for (const section of SECTION_ORDER) {
      const rows = buckets[section];
      if (!rows.length) continue;
      rows.sort((a, b) => (a.status.rank - b.status.rank) || (a.sec - b.sec));

      const collapsible = COLLAPSIBLE_SECTIONS.has(section);
      const collapsed = collapsible && this._collapsedSections.has(section);
      const labelAttrs = collapsible
        ? `data-action="toggle-section" data-section="${section}" role="button" tabindex="0"`
        : "";

      html += `
        <div class="section">
          <div class="section-label ${collapsible ? "collapsible" : ""}" ${labelAttrs}>
            <span class="section-name">${SECTION_LABELS[section]}</span>
            <span class="section-count">${rows.length}</span>
            ${collapsible ? `<ha-icon class="section-chevron ${collapsed ? "" : "open"}" icon="mdi:chevron-right"></ha-icon>` : ""}
          </div>
          ${collapsed ? "" : rows.map((r) => this._renderTaskRow(r.task, r.data, r.status)).join("")}
        </div>
      `;
    }
    return html || this._emptyCategoryState();
  }

  // A declared category with nothing in it yet is a normal, expected state:
  // say so plainly instead of falling back to another category's tasks. A
  // person with nothing assigned to them reads the same way, naming the person
  // rather than the category so an empty tablet explains itself.
  _emptyCategoryState() {
    if (this._isPersonView()) {
      const who =
        this._config.assignee === ASSIGNEE_UNASSIGNED ? "unassigned" : this._personName(this._config.assignee);
      return `<div class="empty-state">No ${escapeHtml(this._categoryLabel(this._activeCategory))} maintenance tasks ${
        this._config.assignee === ASSIGNEE_UNASSIGNED ? "are unassigned." : `assigned to ${escapeHtml(who)}.`
      }</div>`;
    }
    return `<div class="empty-state">No ${escapeHtml(this._categoryLabel(this._activeCategory))} maintenance tasks configured.</div>`;
  }

  // Log tasks get their own compact row: a prominent quick-action button
  // instead of the small circular checkmark, and a single "<value_label>:
  // <date> · <relative>" line instead of Last:/Next:. Reuses data-action
  // ="done" so it goes through the exact same write/refresh path as every
  // other task (see _handleAction) — the delegated click listener already
  // stops propagation for anything with [data-action], so clicking it can
  // never also toggle the row's expanded state.
  _renderLogTaskRow(task, data, status) {
    return this._renderQuickActionRow(task, data, status, logRowText(task, status), "mdi:notebook-outline");
  }

  // Pending follow-ups use the same compact quick-action row as log tasks —
  // same markup, same CSS, same responsive behaviour — differing only in the
  // information line (countdown + the application it follows).
  _renderFollowUpRow(task, data, status) {
    return this._renderQuickActionRow(task, data, status, followUpRowText(task, status), "mdi:check-circle-outline");
  }

  _renderQuickActionRow(task, data, status, lineHtml, defaultIcon) {
    const expanded = this._expandedId === task.id;
    const actionLabel = task.action_label || "DONE TODAY";
    return `
      <div class="task log-task ${expanded ? "expanded" : ""}" style="--status-color:${status.color}">
        <div class="task-header" data-task-id="${task.id}">
          <ha-icon class="task-icon" icon="${task.icon || defaultIcon}"></ha-icon>
          <div class="task-main">
            <div class="task-top-row">
              <span class="task-name-group">
                <span class="task-name">${escapeHtml(task.name)}</span>${this._assigneeChip(task)}
              </span>
            </div>
            <div class="task-lines">
              <span class="line-item">${lineHtml}</span>
            </div>
          </div>
          <button class="log-quick-btn" data-action="done" data-task-id="${task.id}">${escapeHtml(actionLabel)}</button>
          <ha-icon class="chevron ${expanded ? "open" : ""}" icon="mdi:chevron-right"></ha-icon>
        </div>
        ${expanded ? this._renderDetails(task, data, status) : ""}
      </div>
    `;
  }

  _renderTaskRow(task, data, status) {
    if (task.type === "log") return this._renderLogTaskRow(task, data, status);
    if (task.type === "follow_up") return this._renderFollowUpRow(task, data, status);
    if (task.type === "treatment") {
      return this._renderQuickActionRow(task, data, status, treatmentRowText(task, status), "mdi:beaker-outline");
    }
    const expanded = this._expandedId === task.id;
    const lastText = status.last ? formatShortYear(status.last) : "Never";
    // No "Next:" line when there's nothing actionable to show it for: never
    // completed with no due date yet, or a date that's currently suspended
    // (out of season) or intentionally hidden by the optional-task remap.
    let nextText = null;
    if (task.type === "seasonal") {
      nextText = `${formatShort(status.windowStart)} – ${formatShort(status.windowEnd)}`;
    } else if (status.nextDue && !HIDE_NEXT_DUE_STATUS_KEYS.has(status.statusKey)) {
      nextText = formatShortYear(status.nextDue) + (status.overridden ? " (manual)" : "");
    }
    const optionalBadge = task.optional ? `<span class="optional-badge">Optional</span>` : "";
    // Subtle row-level water indicator — only when water_in is explicitly
    // configured (task-level, or on the suggested rotation product for a
    // multi-product task). Nothing shown at all otherwise.
    const rowHasProducts = !!(task.products && task.products.length);
    const rowRotation = rowHasProducts ? computeRotationSuggestion(task, data) : null;
    const rowWaterIn = resolveWaterIn(task, rowHasProducts && rowRotation ? rowRotation.suggested : null);
    const waterRowBadge = rowWaterIn
      ? `<span class="water-badge ${rowWaterIn.waterIn ? "yes" : "no"} row-badge">
          <ha-icon icon="mdi:${rowWaterIn.waterIn ? "water" : "water-off-outline"}"></ha-icon>${rowWaterIn.waterIn ? "Water in" : "No water-in"}
        </span>`
      : "";

    return `
      <div class="task ${expanded ? "expanded" : ""}" style="--status-color:${status.color}">
        <div class="task-header" data-task-id="${task.id}">
          <ha-icon class="task-icon" icon="${task.icon || (task.type === "seasonal" ? "mdi:calendar-star" : "mdi:sprout")}"></ha-icon>
          <div class="task-main">
            <div class="task-top-row">
              <span class="task-name-group">
                <span class="task-name">${escapeHtml(task.name)}</span>${this._assigneeChip(task)}
                ${optionalBadge}
                ${waterRowBadge}
              </span>
              <span class="status-pill"><ha-icon icon="${status.icon}"></ha-icon>${status.label}</span>
            </div>
            <div class="task-lines">
              <span class="line-item"><span class="dim">Last:</span> ${lastText}</span>
              ${nextText ? `<span class="line-item"><span class="dim">${task.type === "seasonal" ? "Window:" : "Next:"}</span> ${nextText}</span>` : ""}
            </div>
          </div>
          <ha-icon class="quick-done-btn" data-action="done" data-task-id="${task.id}" icon="mdi:check-bold" title="Done today"></ha-icon>
          <ha-icon class="chevron ${expanded ? "open" : ""}" icon="mdi:chevron-right"></ha-icon>
        </div>
        ${expanded ? this._renderDetails(task, data, status) : ""}
      </div>
    `;
  }

  // `showSource`, when true, prefixes the row with the owning task's icon and
  // name — used only when a list mixes a parent's entries with its follow-up's
  // (see _renderDetails), so a normal single-task history is untouched.
  _renderHistoryItem(task, entry, showSource) {
    const iso = entry.date;
    const editing = this._editingEntry && this._editingEntry.taskId === task.id && this._editingEntry.date === iso;
    const todayIso = formatISODate(todayLocal());
    const entryFields = task.entry_fields || [];
    if (editing) {
      // One control per entry_fields entry (bounded <select> for type:
      // number, free <input> for type: text), pre-selected to this entry's
      // recorded value (falling back to the field's configured default for
      // legacy entries logged before the field existed) — this is the only
      // place a per-entry value can be changed.
      const fieldSelects = entryFields
        .map((f) => renderEntryFieldInput(f, "edit-field", entry.fields && entry.fields[f.id] !== undefined ? entry.fields[f.id] : f.default))
        .join("");
      return `
        <li class="history-edit">
          <input type="date" class="date-input" lang="en-GB" data-role="edit-date" value="${iso}" max="${todayIso}">
          ${fieldSelects}
          <button class="text-btn" data-action="save-edit" data-task-id="${task.id}" data-date="${iso}">Save</button>
          <button class="text-btn" data-action="cancel-edit">Cancel</button>
        </li>`;
    }
    const product = resolveProduct(task, entry);
    const productText = product ? ` <span class="dim">— ${escapeHtml(product.name)}</span>` : "";
    const fieldsTextRaw = entryFieldsText(entryFields, entry);
    const fieldsText = fieldsTextRaw ? ` <span class="dim">— ${fieldsTextRaw}</span>` : "";
    // snapshot_entities values stored on this specific entry — compact,
    // one line, comma-separated regardless of how many entities a task
    // configures, and always the STORED value (never re-read live) so old
    // entries keep showing exactly what was true when logged. Absent for
    // legacy entries and for entries where every configured entity was
    // unavailable at log time.
    const snapshotsText = entrySnapshotsText(entry);
    const mediaThumb = renderMediaThumb(entry.media, "history-thumb");
    const sourceChip = showSource
      ? `<span class="history-source"><ha-icon icon="${task.icon || "mdi:calendar-check"}"></ha-icon>${escapeHtml(task.name)}</span>`
      : "";
    return `
      <li>
        <div class="history-main">
          <span class="history-date">${formatShortYear(parseISODate(iso))}${sourceChip}${productText}${fieldsText}</span>
          ${snapshotsText ? `<span class="history-snapshot dim">${snapshotsText}</span>` : ""}
          ${mediaThumb}
        </div>
        <span class="history-actions">
          <ha-icon class="icon-btn" data-action="edit-entry" data-task-id="${task.id}" data-date="${iso}" icon="mdi:pencil-outline"></ha-icon>
          <ha-icon class="icon-btn" data-action="delete-entry" data-task-id="${task.id}" data-date="${iso}" icon="mdi:trash-can-outline"></ha-icon>
        </span>
      </li>`;
  }

  _renderDetails(task, data, status) {
    const infoRows = [];
    if (task.type === "log") {
      // Log tasks have no season/interval concept — just the last event,
      // how long ago that was, and (optionally) a target-interval nudge.
      const valueLabel = task.value_label || "Last logged";
      infoRows.push([valueLabel, status.last ? formatShortYear(status.last) : "Never"]);
      infoRows.push(["Days since", status.last ? String(status.daysSince) : "—"]);
      if (task.target_interval_days) {
        const due = status.last !== null && status.daysSince >= task.target_interval_days;
        infoRows.push([
          "Target interval",
          due
            ? `About every ${task.target_interval_days} days — ${escapeHtml(task.name)} may be due`
            : `About every ${task.target_interval_days} days`,
        ]);
      }
    } else if (task.type === "program") {
      infoRows.push(["Last applied", status.last ? formatShortYear(status.last) : "Never"]);
      if (status.nextDue) infoRows.push(["Next target", formatShortYear(status.nextDue)]);
      infoRows.push([
        `Applications ${status.occurrenceYear}`,
        `${status.appliedCount} of ${status.targets.length}` + (status.missedCount ? ` · ${status.missedCount} missed` : ""),
      ]);
      // The full schedule, with each target marked done / missed / still to
      // come, so the whole year's plan is visible at a glance.
      infoRows.push([
        "Schedule",
        status.targets
          .map((t, i) => {
            const state = status.satisfiedIdx.includes(i)
              ? "applied"
              : i === status.currentIdx
              ? "next"
              : status.remainingIdx.includes(i)
              ? "to come"
              : "missed";
            return `${formatShort(t)} <span class="dim">— ${state}</span>`;
          })
          .join("<br>"),
      ]);
    } else if (task.type === "treatment") {
      // No schedule rows at all — stating a next date, even as "—", would
      // imply a recurrence this task deliberately doesn't have.
      infoRows.push(["Last applied", status.last ? formatShortYear(status.last) : "Never"]);
      if (status.last) infoRows.push(["Days since", String(status.daysSince)]);
      infoRows.push(["Schedule", "On demand — no automatic next date"]);
    } else if (task.type === "follow_up") {
      // A follow-up has no season, interval or window of its own — it is
      // entirely defined by the application it trails.
      infoRows.push(["Due", status.dueDate ? formatShortYear(status.dueDate) : "—"]);
      infoRows.push([
        `${task.parent_name} applied`,
        status.parentDate ? formatShortYear(status.parentDate) : "Never",
      ]);
      infoRows.push(["Follows", `${task.after_days} day${task.after_days === 1 ? "" : "s"} after each application`]);
      infoRows.push(["Last completed", status.last ? formatShortYear(status.last) : "Never"]);
    } else {
      infoRows.push(["Last completed", status.last ? formatShortYear(status.last) : "Never"]);
      if (task.type === "recurring") {
        // Omit "Next due" entirely rather than showing a placeholder — there's
        // either no calculated date yet (never completed), the date is
        // currently suspended outside the active season, or it's intentionally
        // hidden by the optional-task remap (see the Override section below,
        // which always shows the raw value regardless).
        if (status.nextDue && !HIDE_NEXT_DUE_STATUS_KEYS.has(status.statusKey)) {
          infoRows.push(["Next due", formatShortYear(status.nextDue) + (status.overridden ? " — manually set" : "")]);
        }
        infoRows.push(["Interval", `Every ${task.interval_days} days`]);
        infoRows.push(["Active months", (task.active_months || []).map((m) => MONTH_ABBR[m - 1]).join(", ")]);
      } else {
        infoRows.push(["Application window", `${task.window.start} → ${task.window.end} (${formatShort(status.windowStart)} – ${formatShort(status.windowEnd)})`]);
      }
    }
    if (task.product) infoRows.push(["Product", escapeHtml(task.product)]);
    if (task.application_rate) infoRows.push(["Application rate", escapeHtml(task.application_rate)]);
    // Generic custom detail fields (item 10) — not tied to type: log, so any
    // task can use them, but this is what lets mowing_height-style fields
    // stay out of hard-coded per-field logic entirely.
    if (Array.isArray(task.details)) {
      for (const d of task.details) {
        if (d && d.label !== undefined && d.value !== undefined) {
          infoRows.push([escapeHtml(String(d.label)), escapeHtml(String(d.value))]);
        }
      }
    }
    // entry_fields are deliberately NOT rendered here as a static row —
    // they're per-entry historical data (see _renderHistoryItem), not a
    // task-level detail. Showing them here as well as in history duplicated
    // static fields like application_rate that describe the same thing at
    // the task level (e.g. Tenacity's `application_rate` vs its
    // `entry_fields: [{id: rate, ...}]`), and it also misrepresented actual
    // per-entry data as if it were a fixed task property.

    const hasProducts = !!(task.products && task.products.length);
    const rotation = hasProducts ? computeRotationSuggestion(task, data) : null;
    if (hasProducts) {
      // Each product gets its own compact block (name + active
      // ingredient/group + optional application_rate) instead of one long
      // semicolon-joined line. application_rate here is the per-product
      // reference dose from YAML — how much of THIS product to use — not
      // tied to any history entry; what was actually applied on a given
      // date still only ever comes from that entry's own recorded data
      // (product_id / entry_fields), never from this static rate.
      const productRateHtml = (p) =>
        p.application_rate ? `<div class="product-sub dim">Application rate: ${escapeHtml(p.application_rate)}</div>` : "";
      const productListHtml = `<div class="product-list">${task.products
        .map(
          (p) => `<div class="product-item">
              <div class="product-name">${escapeHtml(p.name)}</div>
              <div class="product-sub dim">${escapeHtml(p.active_ingredient || "")} · Group ${escapeHtml(String(p.group))}</div>
              ${productRateHtml(p)}
            </div>`
        )
        .join("")}</div>`;
      infoRows.push(["Products", productListHtml]);
      if (rotation.lastProduct) {
        infoRows.push(["Last product used", `${escapeHtml(rotation.lastProduct.name)} · Group ${escapeHtml(String(rotation.lastProduct.group))}`]);
      }
      if (rotation.suggested) {
        // Same block markup/typography as the Products list above — just one
        // item — rather than a single squeezed line.
        const s = rotation.suggested;
        infoRows.push([
          "Suggested next",
          `<div class="product-list"><div class="product-item">
            <div class="product-name">${escapeHtml(s.name)}</div>
            <div class="product-sub dim">${escapeHtml(s.active_ingredient || "")} · Group ${escapeHtml(String(s.group))}</div>
            ${productRateHtml(s)}
          </div></div>`,
        ]);
      }
    }

    // Water-in row: uses whichever product is "currently relevant" for this
    // always-visible summary — the suggested rotation product for a
    // multi-product task, otherwise just the task-level value. The
    // log-application form below has its own resolution against whichever
    // product is actually selected there (see formWaterIn).
    const summaryWaterIn = resolveWaterIn(task, hasProducts && rotation ? rotation.suggested : null);
    if (summaryWaterIn) {
      infoRows.push([
        "Water in",
        `<div class="product-list"><div class="product-item">
          <span class="water-badge ${summaryWaterIn.waterIn ? "yes" : "no"}">${summaryWaterIn.waterIn ? "Yes" : "No"}</span>
          ${summaryWaterIn.note ? `<div class="product-sub dim">${escapeHtml(summaryWaterIn.note)}</div>` : ""}
        </div></div>`,
      ]);
    }

    // Sensor advisory — a purely informational recommendation, never an
    // automatic command and never something that changes status/section
    // (an optional task with an active advisory stays in the Optional
    // section, never Needs Attention). Omitted entirely unless active, or
    // inactive with a configured clear_message.
    const advisoryView = this._advisoryView(task);
    if (advisoryView) {
      const { advisory, reading, active } = advisoryView;
      if (active || advisory.clear_message) {
        let valueText;
        if (!reading.exists) valueText = "Entity not found";
        else if (reading.available) valueText = `${reading.value}${reading.unit ? " " + reading.unit : ""}`;
        else if (reading.rawState === "unavailable") valueText = "Unavailable";
        else if (reading.rawState === "unknown") valueText = "Unknown";
        else valueText = `Non-numeric (${reading.rawState})`;
        infoRows.push([
          "Advisory",
          `<div class="advisory-block">
            ${active ? `<span class="advisory-pill">Advisory</span>` : ""}
            <div class="advisory-sensor dim">${escapeHtml(reading.friendlyName)}: ${escapeHtml(valueText)}</div>
            <div class="advisory-sensor dim">${escapeHtml(advisoryTriggerText(advisory))}</div>
            <div class="advisory-message">${escapeHtml(active ? advisory.message : advisory.clear_message)}</div>
          </div>`,
        ]);
      }
    }

    if (task.active_ingredient) infoRows.push(["Active ingredient", escapeHtml(task.active_ingredient)]);
    // Generic summary of whatever follow-ups this task declares — reads the
    // same normalised list the rest of the card uses, so it covers the
    // singular and list spellings and any number of them.
    const detailFollowUps = followUpTasksFor(task);
    if (detailFollowUps.length) {
      infoRows.push([
        detailFollowUps.length === 1 ? "Follow-up" : "Follow-ups",
        detailFollowUps.map((f) => `${escapeHtml(f.name)} — ${f.after_days} day${f.after_days === 1 ? "" : "s"} after`).join("<br>"),
      ]);
    }
    // Only offered once people are configured — with no `people:` the feature
    // is invisible and every existing config looks exactly as it did.
    if ((this._config.people || []).length) {
      if (task.type === "follow_up") {
        // A follow-up inherits its parent's assignee (see followUpTasksFor), so
        // it is shown but not editable here: the parent's row is the one place
        // that decides, and offering a second control would imply they could
        // diverge.
        infoRows.push([
          "Assigned to",
          `${escapeHtml(this._personName(assigneeForTask(task, "lawn-maintenance-card")))} <span class="dim">— follows ${escapeHtml(task.parent_name)}</span>`,
        ]);
      } else {
        infoRows.push(["Assigned to", this._renderAssigneeSelect(task)]);
      }
    }
    if (task.description) infoRows.push(["Description", escapeHtml(task.description)]);
    if (task.notes) infoRows.push(["Notes", escapeHtml(task.notes)]);
    if (status.detail) infoRows.push(["Status detail", escapeHtml(status.detail)]);
    if (data.sy.length) infoRows.push(["Skipped years", data.sy.join(", ")]);

    // A task that has a follow-up shows BOTH histories here, merged newest
    // first: the pending follow-up row only exists while it's outstanding, so
    // the parent is the one place its record stays reachable afterwards —
    // which is also what makes an accidental completion inspectable and
    // undoable. Each entry is rendered against the task that actually owns it,
    // so the existing edit/delete actions already address the right entity and
    // no second deletion path exists. Nothing is copied: both sides are read
    // straight from their own persisted history.
    const historyFollowUps = followUpTasksFor(task);
    const mergedHistory = [
      ...data.entries.map((entry) => ({ owner: task, entry })),
      ...historyFollowUps.flatMap((followUp) =>
        this._taskState(followUp.id).entries.map((entry) => ({ owner: followUp, entry }))
      ),
    ].sort((a, b) => (a.entry.date < b.entry.date ? 1 : a.entry.date > b.entry.date ? -1 : 0));
    const historyHtml = mergedHistory.length
      ? mergedHistory.map((row) => this._renderHistoryItem(row.owner, row.entry, !!historyFollowUps.length)).join("")
      : `<li class="dim no-history">No completions logged yet</li>`;

    const addAppOpen = this._addAppOpen === task.id;
    const overrideOpen = this._overrideOpen === task.id;
    const todayIso = formatISODate(todayLocal());

    // action_label/add_action_label (item 5) let a task rename its main/
    // secondary buttons ("MOWED TODAY" / "ADD MOWING") — absent, these fall
    // back to the exact existing text for non-log tasks (zero visual change)
    // and to a generic "ADD ENTRY" for log tasks.
    const doneLabel = task.action_label || "DONE TODAY";
    const addLabel = task.add_action_label || (task.type === "log" ? "ADD ENTRY" : "ADD APPLICATION");

    return `
      <div class="details">
        <table class="details-table">
          ${infoRows.map(([k, v]) => `<tr><td class="dim">${k}</td><td>${v}</td></tr>`).join("")}
        </table>

        <div class="actions-row">
          ${hasProducts
            ? `<button class="done-btn" data-action="toggle-add-app" data-task-id="${task.id}">${escapeHtml(task.action_label || "LOG APPLICATION")}</button>`
            : task.allow_photo
            ? `<button class="done-btn" data-action="toggle-add-app" data-task-id="${task.id}">${escapeHtml(doneLabel)}</button>
               <button class="secondary-btn" data-action="toggle-add-app" data-task-id="${task.id}">${escapeHtml(addLabel)}</button>`
            : `<button class="done-btn" data-action="done" data-task-id="${task.id}">${escapeHtml(doneLabel)}</button>
               <button class="secondary-btn" data-action="toggle-add-app" data-task-id="${task.id}">${escapeHtml(addLabel)}</button>`}
          ${task.type === "seasonal" && status.statusKey !== "completed" ? `
            <button class="secondary-btn" data-action="${status.statusKey === "skipped" ? "unskip-year" : "skip-year"}" data-task-id="${task.id}" data-year="${status.occurrenceYear}">
              ${status.statusKey === "skipped" ? "SKIPPED ✓ (tap to undo)" : "SKIP THIS YEAR"}
            </button>` : ""}
        </div>

        ${(() => {
          if (!addAppOpen) return "";
          // The dropdown defaults to the suggested rotation product, but once
          // the user picks a different one (tracked via the "change" listener
          // in _buildShell), that choice sticks across re-renders instead of
          // snapping back — that's what makes the water-in hint below update
          // live as the selection changes.
          const currentProductId = hasProducts
            ? this._addAppSelectedProduct || (rotation.suggested ? rotation.suggested.id : "")
            : null;
          const selectedProduct = hasProducts ? task.products.find((p) => p.id === currentProductId) || null : null;
          const formWaterIn = resolveWaterIn(task, selectedProduct);
          // Unlike the quick action (which silently uses each field's
          // default — no prompt, that's the point of a one-tap action),
          // a backdated entry is deliberate, so it gets a control per
          // entry_field too, same as the history edit form.
          const addAppFieldSelects = (task.entry_fields || [])
            .map((f) => renderEntryFieldInput(f, "add-app-field", f.default))
            .join("");
          return `
          <div class="inline-form">
            <input type="date" class="date-input" lang="en-GB" data-role="add-app-date" value="${todayIso}" max="${todayIso}">
            ${hasProducts ? `
              <select class="date-input" data-role="add-app-product">
                <option value="">No product recorded</option>
                ${task.products.map((p) => `<option value="${p.id}" ${p.id === currentProductId ? "selected" : ""}>${escapeHtml(p.name)} (Group ${escapeHtml(String(p.group))})</option>`).join("")}
              </select>` : ""}
            ${addAppFieldSelects}
            ${task.allow_photo ? `
              <div class="photo-picker">
                <label class="photo-picker-label" for="photo-input-${task.id}">Photo (optional)</label>
                <input type="file" id="photo-input-${task.id}" class="photo-picker-input" data-role="add-app-photo" accept="image/*" capture="environment">
                ${this._addAppPhotoFile ? `<span class="photo-picker-selected dim">Selected: ${escapeHtml(this._addAppPhotoFile.name)}</span>` : ""}
              </div>` : ""}
            <button class="secondary-btn" data-action="save-add-app" data-task-id="${task.id}">Save</button>
            <button class="text-btn" data-action="toggle-add-app" data-task-id="${task.id}">Cancel</button>
          </div>
          ${hasProducts && rotation.suggested ? `
            <div class="rotation-hint">
              <ha-icon icon="mdi:swap-horizontal"></ha-icon>
              Suggested: ${escapeHtml(rotation.suggested.name)} (Group ${escapeHtml(String(rotation.suggested.group))})${rotation.lastProduct && rotation.lastProduct.group !== rotation.suggested.group ? ` — rotates away from Group ${escapeHtml(String(rotation.lastProduct.group))} used last time` : ""}
            </div>` : ""}
          ${formWaterIn ? `
            <div class="water-in-hint">
              <ha-icon icon="mdi:${formWaterIn.waterIn ? "water" : "water-off-outline"}"></ha-icon>
              <span>Water in: <span class="water-badge ${formWaterIn.waterIn ? "yes" : "no"}">${formWaterIn.waterIn ? "Yes" : "No"}</span>${formWaterIn.note ? ` — ${escapeHtml(formWaterIn.note)}` : ""}</span>
            </div>` : ""}
          `;
        })()}

        ${task.type === "recurring" ? `
          <div class="override-row">
            ${status.overridden
              ? `<span class="override-note">Next due manually set${status.autoNextDue ? ` — auto would be ${formatShortYear(status.autoNextDue)}` : ""}</span>
                 <button class="text-btn" data-action="clear-override" data-task-id="${task.id}">Return to automatic schedule</button>`
              : `<button class="text-btn" data-action="toggle-override" data-task-id="${task.id}">Override next due date</button>`}
          </div>
          ${overrideOpen ? `
            <div class="inline-form">
              <input type="date" class="date-input" lang="en-GB" data-role="override-date" value="${status.nextDue ? formatISODate(status.nextDue) : todayIso}">
              <button class="secondary-btn" data-action="save-override" data-task-id="${task.id}">Set</button>
              <button class="text-btn" data-action="toggle-override" data-task-id="${task.id}">Cancel</button>
            </div>` : ""}
        ` : ""}

        <div class="history-label">${escapeHtml(task.history_label || "History")} (${mergedHistory.length})</div>
        <ul class="history-list">${historyHtml}</ul>
      </div>
    `;
  }

  _renderOverview() {
    const byMonth = Array.from({ length: 12 }, () => []);
    const todayMonthIdx = todayLocal().getMonth();
    // Configured tasks only (follow-ups have no annual window of their own),
    // narrowed by the same category AND assignee rules as every other view.
    for (const task of tasksForAssignee(
      tasksForCategory(this._config.tasks, this._activeCategory),
      this._config.assignee
    )) {
      const optionalBadge = task.optional ? ` <span class="optional-badge">Optional</span>` : "";
      if (task.type === "log") {
        // Log tasks are continuous activity, not an annual scheduled
        // window, so they're excluded from Year Overview by default (item
        // 12). Explicitly opting in only shows them in the current month —
        // there's no natural "window" to place them in otherwise.
        if (task.show_in_overview === true) {
          const freq = task.target_interval_days ? ` <span class="dim">(about every ${task.target_interval_days}d)</span>` : "";
          byMonth[todayMonthIdx].push(`${escapeHtml(task.name)}${freq}`);
        }
      } else if (task.type === "recurring") {
        for (const m of task.active_months || []) {
          byMonth[m - 1].push(`${escapeHtml(task.name)}${optionalBadge} <span class="dim">(every ${task.interval_days}d)</span>`);
        }
      } else if (task.type === "program") {
        // One entry per scheduled application, in the month it falls in —
        // whether the dates were listed explicitly or generated from an anchor.
        for (const target of programTargetsFor(task, todayLocal().getFullYear())) {
          byMonth[target.getMonth()].push(`${escapeHtml(task.name)}${optionalBadge} <span class="dim">(${formatShort(target)})</span>`);
        }
      } else if (task.window) {
        for (const m of monthsOverlappingWindow(task.window)) {
          byMonth[m - 1].push(`${escapeHtml(task.name)}${optionalBadge} <span class="dim">(${task.window.start} – ${task.window.end})</span>`);
        }
      }
    }
    if (byMonth.every((entries) => !entries.length)) return this._emptyCategoryState();
    return `
      <div class="overview">
        ${byMonth
          .map((entries, i) =>
            entries.length
              ? `<div class="overview-month">
                  <div class="overview-month-name">${MONTH_NAMES[i]}</div>
                  <ul>${entries.map((e) => `<li>${e}</li>`).join("")}</ul>
                </div>`
              : ""
          )
          .join("")}
      </div>
    `;
  }

  // Year History is a read-only journal of what actually happened, in
  // contrast to Year Overview's planning view of what's scheduled — built
  // from the exact same _taskState().entries every other view already
  // reads (no new storage, no reconstruction from current YAML), grouped by
  // month within a selected year. Skipped years never produce history
  // entries in the first place (skip is tracked separately in `sy`, not a
  // history row), so there's nothing to exclude here for that.
  _renderYearHistory() {
    const events = [];
    // _categoryTasks so completed follow-ups appear in the journal alongside
    // the applications that created them — "13 Aug Tree fungicide / 17 Aug
    // Wash trees" is exactly the relationship this view should make visible —
    // and so the journal only ever covers the selected category (a follow-up
    // inherits its parent's, so the pair can never be split across two).
    for (const task of this._categoryTasks()) {
      const data = this._taskState(task.id);
      for (const entry of data.entries) {
        events.push({
          date: entry.date,
          dateObj: parseISODate(entry.date),
          taskName: task.name,
          icon: task.icon || "mdi:calendar-check",
          color: taskIdentityColor(task),
          product: resolveProduct(task, entry),
          fieldsText: entryFieldsText(task.entry_fields, entry),
          fieldCount: populatedEntryFields(task.entry_fields, entry).length,
          snapshotsText: entrySnapshotsText(entry),
          media: entry.media,
        });
      }
    }

    const years = new Set(events.map((e) => e.dateObj.getFullYear()));
    years.add(todayLocal().getFullYear());
    const yearList = Array.from(years).sort((a, b) => b - a);

    // Only ever defaulted once (see the field's own comment in the
    // constructor) — never overwritten here on a later re-render.
    if (this._historyYear === null) this._historyYear = yearList[0];
    const selectedYear = this._historyYear;

    const yearEvents = events.filter((e) => e.dateObj.getFullYear() === selectedYear);

    const byMonth = Array.from({ length: 12 }, () => []);
    for (const e of yearEvents) byMonth[e.dateObj.getMonth()].push(e);
    // Sort each month by date in the selected direction. Array.sort is
    // stable, so same-date entries always keep the same relative order
    // (task config order) regardless of direction — toggling sort flips
    // which date comes first, it never reorders events within a single day.
    const dateComparator = this._historySortDesc ? (a, b) => b.dateObj - a.dateObj : (a, b) => a.dateObj - b.dateObj;
    for (const bucket of byMonth) bucket.sort(dateComparator);
    // Newest-first also walks the months themselves Dec -> Jan instead of
    // Jan -> Dec.
    const monthOrder = this._historySortDesc
      ? Array.from({ length: 12 }, (_, i) => 11 - i)
      : Array.from({ length: 12 }, (_, i) => i);

    const yearSelect = `
      <select class="date-input year-select" data-role="history-year">
        ${yearList.map((y) => `<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}</option>`).join("")}
      </select>`;
    const sortLabel = this._historySortDesc ? "Newest first" : "Oldest first";
    const sortIcon = this._historySortDesc ? "mdi:sort-calendar-descending" : "mdi:sort-calendar-ascending";
    const sortToggle = `
      <button class="sort-toggle-btn" data-action="toggle-history-sort">
        <ha-icon icon="${sortIcon}"></ha-icon>${sortLabel}
      </button>`;
    const summary = yearEvents.length ? `${yearEvents.length} event${yearEvents.length === 1 ? "" : "s"}` : "";

    const monthsHtml = monthOrder
      .map((i) => {
        const bucket = byMonth[i];
        return bucket.length
          ? `<div class="history-month-group">
              <div class="history-month-name">${MONTH_NAMES[i]} <span class="history-month-count dim">${bucket.length}</span></div>
              <ul class="year-history-list">${bucket.map((e) => this._renderYearHistoryItem(e)).join("")}</ul>
            </div>`
          : "";
      })
      .join("");

    return `
      <div class="year-history">
        <div class="year-history-header">
          ${yearSelect}
          ${sortToggle}
          <span class="dim">${summary}</span>
        </div>
        ${
          yearEvents.length
            ? monthsHtml
            : `<div class="empty-state">No ${escapeHtml(this._categoryLabel(this._activeCategory))} activity recorded for ${selectedYear}.</div>`
        }
      </div>
    `;
  }

  _renderYearHistoryItem(e) {
    const hasProduct = !!e.product;
    const hasFields = !!e.fieldsText;
    const hasSnapshots = !!e.snapshotsText;
    // Exactly one populated entry_fields value, with no product and no
    // snapshot, stays inline with the task name ("Mowing · 6 cm") — the
    // most common case (single-field log tasks) collapses to one dense
    // line. Anything else (a product, a snapshot, or 2+ populated fields
    // like Irrigation's two zones) gets its own detail line(s) below
    // instead: a combined multi-field string is deliberately never treated
    // as "simple" just because it's one piece of text.
    const inlineDetail = hasFields && e.fieldCount === 1 && !hasProduct && !hasSnapshots;

    const detailLines = [];
    if (!inlineDetail) {
      if (hasProduct) {
        detailLines.push(escapeHtml(e.product.name));
        const sub = [e.product.active_ingredient, e.product.group !== undefined ? `Group ${e.product.group}` : null]
          .filter(Boolean)
          .map((s) => escapeHtml(String(s)))
          .join(" · ");
        if (sub) detailLines.push(sub);
      }
      if (hasFields) detailLines.push(e.fieldsText);
      if (hasSnapshots) detailLines.push(e.snapshotsText);
    }
    const mediaThumb = renderMediaThumb(e.media, "year-history-thumb");

    return `
      <li class="year-history-item" style="--history-color:${e.color}">
        <ha-icon class="year-history-icon" icon="${e.icon}"></ha-icon>
        <div class="year-history-main">
          <div class="year-history-title-row">
            <span class="history-date">${formatShort(e.dateObj)}</span>
            <span class="year-history-task">${escapeHtml(e.taskName)}</span>${inlineDetail ? ` <span class="dim">· ${e.fieldsText}</span>` : ""}
          </div>
          ${detailLines.map((line) => `<div class="year-history-detail dim">${line}</div>`).join("")}
          ${mediaThumb}
        </div>
      </li>`;
  }
}

const CSS = `
  :host { display: block; }
  ha-card {
    padding: 10px 4px 14px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 12px 8px;
    flex-wrap: wrap;
  }
  .title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--primary-text-color);
  }
  .view-toggle { display: flex; gap: 4px; }
  .tab {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    border: none;
    background: var(--secondary-background-color, rgba(127,127,127,0.15));
    color: var(--secondary-text-color);
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .tab.active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  /* Deliberately quieter than the Tasks / Year Overview / Year History tabs
     above: outlined instead of filled, smaller type. It scopes what the tabs
     show rather than switching between them, and should read that way. */
  .category-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 0 12px 8px;
  }
  .category-chip {
    font: inherit;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.3));
    background: transparent;
    color: var(--secondary-text-color);
    border-radius: 999px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .category-chip.active {
    border-color: var(--primary-color);
    color: var(--primary-color);
    background: rgba(127,127,127,0.10);
  }
  .error-banner {
    margin: 0 12px 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(239,68,68,0.12);
    color: #ef4444;
    font-size: 12px;
    line-height: 1.4;
  }
  .undo-banner {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0 12px 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--secondary-background-color, rgba(127,127,127,0.15));
    color: var(--primary-text-color);
    font-size: 12.5px;
  }
  /* Same [hidden]-vs-display conflict as .lightbox below — a class rule
     setting display always beats the [hidden] UA rule regardless of
     specificity (author origin beats user-agent origin), so without this
     the banner keeps its old innerHTML laid out and visible on screen
     (just empty-looking most of the time) even after _undo goes back to
     null. Found live: a throttled background-tab setTimeout meant the
     banner's stale "Logged ... UNDO" text stayed on screen and visible
     long after it should have auto-hidden. */
  .undo-banner:not([hidden]) { display: flex; }
  .body { display: flex; flex-direction: column; }
  .section-label {
    padding: 10px 12px 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--secondary-text-color);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .section-label.collapsible {
    cursor: pointer;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .section-count {
    background: var(--secondary-background-color, rgba(127,127,127,0.2));
    border-radius: 999px;
    padding: 1px 6px;
    font-size: 10px;
  }
  .section-chevron {
    --mdc-icon-size: 16px;
    margin-left: auto;
    transition: transform 0.15s ease;
  }
  .section-chevron.open { transform: rotate(90deg); }
  .empty-state { padding: 20px 12px; color: var(--secondary-text-color); font-size: 13px; text-align: center; }
  /* Pinned log tasks (e.g. Mowing) sit above every normal section with no
     section label/count chrome — just a divider to set them apart. */
  .pinned-section { border-bottom: 1px solid var(--divider-color, rgba(127,127,127,0.15)); padding-bottom: 2px; }
  .pinned-section .task { border-top: none; }
  .task { border-top: 1px solid var(--divider-color, rgba(127,127,127,0.15)); }
  .section .task:first-of-type { border-top: none; }
  .task-header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    border-left: 3px solid var(--status-color);
  }
  .task-icon { --mdc-icon-size: 20px; color: var(--status-color); margin-top: 2px; flex-shrink: 0; }
  .task-main { flex: 1; min-width: 0; }
  .task-top-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .task-name-group { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .task-name { font-size: 14px; font-weight: 700; color: var(--primary-text-color); }
  /* Master-view only. Deliberately quieter than the Optional badge next to it:
     no fill, secondary text colour, so it reads as an annotation rather than
     competing with the task name, its due date or its status pill. */
  .assignee-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--secondary-text-color);
    white-space: nowrap;
    opacity: 0.85;
    /* min-width:0 + shrink lets a long name give way before the task name does
       on a 320px phone, instead of forcing the row to overflow. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .assignee-chip ha-icon { --mdc-icon-size: 12px; flex-shrink: 0; }
  /* An id that is no longer in people[]: still shown, never hidden or
     reassigned, but marked so it is obviously something to fix. */
  .assignee-chip.unknown { color: #b45309; opacity: 1; }
  .optional-badge {
    display: inline-flex;
    align-items: center;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #a78bfa;
    background: rgba(167,139,250,0.15);
    border-radius: 999px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  /* Deliberately calm colors (green/blue), never red/orange — this is an
     instruction, not a warning. */
  .water-badge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    border-radius: 999px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .water-badge.yes { color: #22c55e; background: rgba(34,197,94,0.15); }
  .water-badge.no { color: #3b82f6; background: rgba(59,130,246,0.15); }
  .water-badge.row-badge ha-icon { --mdc-icon-size: 11px; }
  .water-in-hint {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--secondary-text-color);
  }
  .water-in-hint ha-icon { --mdc-icon-size: 15px; flex-shrink: 0; }
  /* Informational, not a warning — deliberately the same calm blue used
     elsewhere for neutral information, never red/orange. */
  .advisory-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(59,130,246,0.08);
    border: 1px solid rgba(59,130,246,0.25);
  }
  .advisory-pill {
    align-self: flex-start;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #3b82f6;
    background: rgba(59,130,246,0.15);
    border-radius: 999px;
    padding: 1px 6px;
    margin-bottom: 2px;
  }
  .advisory-sensor { font-size: 11px; }
  .advisory-message { font-size: 12px; color: var(--primary-text-color); margin-top: 2px; }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11.5px;
    font-weight: 700;
    color: var(--status-color);
    white-space: nowrap;
  }
  .status-pill ha-icon { --mdc-icon-size: 14px; }
  .task-lines {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 12px;
    color: var(--primary-text-color);
    margin-top: 2px;
  }
  .dim { color: var(--secondary-text-color); }
  .quick-done-btn {
    --mdc-icon-size: 16px;
    color: var(--status-color);
    background: var(--secondary-background-color, rgba(127,127,127,0.15));
    border-radius: 50%;
    padding: 6px;
    margin-top: -2px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .quick-done-btn:hover { filter: brightness(1.15); }
  .log-quick-btn {
    font: inherit;
    font-weight: 700;
    font-size: 10.5px;
    letter-spacing: 0.03em;
    border: none;
    border-radius: 8px;
    padding: 7px 10px;
    cursor: pointer;
    background: var(--primary-color);
    color: var(--text-primary-color, #fff);
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: -2px;
  }
  .log-quick-btn:hover { filter: brightness(1.1); }
  .chevron {
    --mdc-icon-size: 20px;
    color: var(--secondary-text-color);
    margin-top: 1px;
    transition: transform 0.15s ease;
    flex-shrink: 0;
  }
  .chevron.open { transform: rotate(90deg); }
  .details { padding: 0 12px 10px 38px; }
  .details-table { border-collapse: collapse; font-size: 12.5px; width: 100%; line-height: 1.25; }
  .details-table td { padding: 1px 10px 1px 0; vertical-align: top; }
  .details-table td:first-child { white-space: nowrap; }
  .product-list { display: flex; flex-direction: column; gap: 4px; padding: 1px 0; }
  .product-item { line-height: 1.25; }
  .product-name { color: var(--primary-text-color); font-weight: 600; }
  .product-sub { font-size: 11px; }
  .actions-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .done-btn {
    font: inherit;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.03em;
    border: none;
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    background: var(--primary-color);
    color: var(--text-primary-color, #fff);
  }
  .secondary-btn {
    font: inherit;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.03em;
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.4));
    background: transparent;
    color: var(--primary-text-color);
  }
  .text-btn {
    font: inherit;
    font-weight: 700;
    font-size: 11.5px;
    border: none;
    background: transparent;
    color: var(--primary-color);
    cursor: pointer;
    padding: 4px 2px;
  }
  .inline-form { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .date-input {
    font: inherit;
    font-size: 12.5px;
    padding: 5px 6px;
    border-radius: 6px;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.4));
    background: var(--card-background-color, transparent);
    color: var(--primary-text-color);
  }
  select.date-input { max-width: 220px; }
  .rotation-hint {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 6px;
    font-size: 11.5px;
    color: #a78bfa;
  }
  .rotation-hint ha-icon { --mdc-icon-size: 15px; flex-shrink: 0; }
  .override-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
  .override-note { color: var(--secondary-text-color); font-style: italic; }
  .history-label {
    margin-top: 8px;
    font-size: 11.5px;
    font-weight: 700;
    color: var(--secondary-text-color);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .history-list {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    max-height: 180px;
    overflow-y: auto;
    font-size: 12.5px;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.2));
    border-radius: 8px;
  }
  .history-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--divider-color, rgba(127,127,127,0.12));
  }
  .history-list li:last-child { border-bottom: none; }
  .history-list li.no-history { justify-content: flex-start; }
  .history-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .history-snapshot { font-size: 11px; }
  /* Which task an entry belongs to — only rendered when a history list mixes
     a parent's entries with its follow-up's. Same muted treatment as the
     other inline history annotations, just with the task's own icon. */
  .history-source {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 6px;
    color: var(--secondary-text-color);
    font-size: 11.5px;
  }
  /* Nudged up so the glyph sits on the text's optical centre — MDI glyphs
     carry enough bottom bearing that align-items:center leaves them low. */
  .history-source ha-icon {
    --mdc-icon-size: 14px;
    width: 14px;
    height: 14px;
    position: relative;
    top: -3px;
  }
  .history-thumb {
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: 6px;
    cursor: pointer;
    margin-top: 2px;
  }
  .history-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .icon-btn { --mdc-icon-size: 16px; color: var(--secondary-text-color); cursor: pointer; }
  .icon-btn:hover { color: var(--primary-text-color); }
  .history-edit { flex-wrap: wrap; }
  .overview {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
    padding: 4px 12px 8px;
  }
  .overview-month {
    background: var(--secondary-background-color, rgba(127,127,127,0.08));
    border-radius: 10px;
    padding: 8px 10px;
  }
  .overview-month-name {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--primary-text-color);
    margin-bottom: 4px;
  }
  .overview-month ul { list-style: none; margin: 0; padding: 0; }
  .overview-month li { font-size: 12px; color: var(--primary-text-color); padding: 2px 0; }
  .year-history { padding: 4px 12px 8px; }
  .year-history-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    padding: 4px 0 8px;
    font-size: 12px;
  }
  .year-select { max-width: 100px; }
  .sort-toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    border: none;
    background: var(--secondary-background-color, rgba(127,127,127,0.15));
    color: var(--secondary-text-color);
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .sort-toggle-btn:hover { color: var(--primary-text-color); }
  .sort-toggle-btn ha-icon { --mdc-icon-size: 14px; }
  /* Denser than the Tasks tab's history list on purpose — Year History is a
     journal meant to stay readable with many mowing/irrigation entries, so
     every gap here is deliberately tighter than the equivalent Tasks-tab
     spacing (.history-list etc., untouched). */
  .history-month-group { margin-bottom: 6px; }
  .history-month-name {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--primary-text-color);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 2px;
  }
  .history-month-count {
    background: var(--secondary-background-color, rgba(127,127,127,0.2));
    border-radius: 999px;
    padding: 1px 6px;
    font-size: 10px;
  }
  .year-history-list {
    list-style: none;
    margin: 2px 0 0;
    padding: 0;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.2));
    border-radius: 8px;
  }
  .year-history-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 10px 4px 8px;
    border-bottom: 1px solid var(--divider-color, rgba(127,127,127,0.12));
    border-left: 3px solid var(--history-color);
    font-size: 12.5px;
  }
  .year-history-item:last-child { border-bottom: none; }
  /* Same stable per-task accent as the row's left border (see
     taskIdentityColor) — deliberately NOT the live status color, since a
     historical event's color must never shift as the task's current
     due/overdue/skipped status changes later. */
  .year-history-icon { --mdc-icon-size: 15px; color: var(--history-color); margin-top: -1px; flex-shrink: 0; }
  .year-history-main { display: flex; flex-direction: column; gap: 0; min-width: 0; flex: 1; }
  .year-history-title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
  .year-history-task { font-weight: 600; color: var(--primary-text-color); }
  .year-history-detail { font-size: 11px; line-height: 1.35; }
  .year-history-thumb {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 6px;
    cursor: pointer;
    margin-top: 3px;
  }
  .photo-picker { display: flex; flex-direction: column; gap: 3px; flex: 1 1 100%; }
  .photo-picker-label { font-size: 11px; color: var(--secondary-text-color); }
  .photo-picker-input { font-size: 12px; color: var(--primary-text-color); max-width: 100%; }
  .photo-picker-selected { font-size: 11px; }
  .lightbox {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 20;
    align-items: center;
    justify-content: center;
  }
  /* [hidden] and this class both set display, so without this explicit
     :not([hidden]) override the class rule (equal specificity, later in
     the cascade) wins and the lightbox stays laid out — invisible-ish but
     still present and intercepting layout/clicks — even while "hidden". */
  .lightbox:not([hidden]) { display: flex; }
  .lightbox-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.85);
  }
  .lightbox-img {
    position: relative;
    max-width: 92vw;
    max-height: 92vh;
    object-fit: contain;
    border-radius: 4px;
  }
  .lightbox-close {
    position: absolute;
    top: 14px;
    right: 14px;
    z-index: 21;
    --mdc-icon-size: 26px;
    color: #fff;
    cursor: pointer;
    padding: 6px;
  }

  @media (max-width: 420px) {
    .details { padding-left: 30px; }
    .actions-row .secondary-btn, .actions-row .done-btn { flex: 1 1 auto; text-align: center; }
    .task-top-row { flex-direction: column; align-items: flex-start; gap: 2px; }
    .quick-done-btn { padding: 5px; }
    .log-quick-btn { padding: 6px 8px; font-size: 9.5px; }
  }
`;

if (!customElements.get("lawn-maintenance-card")) {
  customElements.define("lawn-maintenance-card", LawnMaintenanceCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "lawn-maintenance-card",
  name: "Lawn Maintenance Card",
  description: "Year-round lawn maintenance planner and history tracker: recurring + seasonal-window tasks, DONE TODAY / ADD APPLICATION, editable history, next-due overrides, and a generated year overview — all driven by YAML config.",
});

// ===========================================================================
// lawn-week-calendar — a second, independent card in this same file.
//
// A read-only 7-day (Mon–Sun) strip meant to sit at the top of a dashboard
// for a glance at "what happened this week / what's coming". It is NOT part
// of LawnMaintenanceCard and adds nothing to it: no extra tab, no extra
// button, no shared DOM, no shared instance state. It only reuses this
// file's module-level pure functions (the status engine, the date helpers,
// history normalization, taskIdentityColor) so there is exactly one
// implementation of the recurring/seasonal/log date math in the project.
//
// Data sources, both already existing — nothing new is created:
//   * history + skipped years: the same pyscript.lawn_<task_id> entity
//     attributes the maintenance card reads (via normalizeTaskState).
//   * task configuration: the SAME YAML, read back out of the Lovelace
//     config that already holds the maintenance card (see _discoverTasks).
//     There is deliberately no second copy of the task list to maintain.
// ===========================================================================

const WEEK_DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Monday of the calendar week containing `date`, in local time (every date
// helper in this file is local-midnight based, so no UTC/offset drift).
// NOTE: the calendar's visible window is centred on today (see
// centeredWindowStart), so the render path no longer snaps to Mondays — this
// stays as a general date utility for building week-aligned windows.
function mondayOf(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

// "10–16 August 2026" / "28 Sep – 4 Oct 2026" / "29 Dec 2025 – 4 Jan 2026".
// The year lives here in the header so the day cards never have to repeat it.
function formatWeekRange(start, end) {
  if (start.getFullYear() !== end.getFullYear()) {
    return `${formatShortYear(start)} – ${formatShortYear(end)}`;
  }
  if (start.getMonth() !== end.getMonth()) {
    return `${formatShort(start)} – ${formatShort(end)} ${end.getFullYear()}`;
  }
  return `${start.getDate()}–${end.getDate()} ${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}`;
}

// One short line of recorded detail for a day cell — the compact cousin of
// entryFieldsText. Generic over whatever entry_fields a task declares, with
// no per-task special-casing: one populated field renders as "7 cm", and
// several fields sharing a unit collapse to "25 / 25 min" rather than
// repeating labels the narrow column has no room for. Values only — the
// task name above already says what they are. Snapshots are deliberately
// never included here (they stay in Tasks / Year History).
function compactEntryDetail(task, entry) {
  const fields = populatedEntryFields(task.entry_fields, entry);
  if (!fields.length) return "";
  const values = fields.map((f) => String(entry.fields[f.id]));
  const units = fields.map((f) => f.unit || "");
  if (fields.length === 1) return `${values[0]}${units[0] ? " " + units[0] : ""}`;
  const sharedUnit = units.every((u) => u === units[0]) ? units[0] : null;
  return sharedUnit !== null
    ? `${values.join(" / ")}${sharedUnit ? " " + sharedUnit : ""}`
    : fields.map((f, i) => `${values[i]}${units[i] ? " " + units[i] : ""}`).join(" / ");
}

// The single forward-looking entry a task contributes, derived entirely from
// the status object computeTaskStatus already produced — this is a read of
// the existing scheduler, never a second one. Returns {date, detail} or null.
//
// Deliberately at most ONE upcoming marker per task per week, so a two-week
// seasonal window does not paint the same task across every day of it.
function upcomingEventFor(task, status, today, lockouts) {
  const optional = !!task.optional;

  // A task running a lockout paints one marker per day for the whole period,
  // the single deliberate exception to the "at most one marker per task per
  // week" rule above. Without it the establishment period would read as an
  // absence — an oddly empty calendar — instead of something you can count
  // your way through. buildWeekEvents drops whichever days fall outside the
  // visible window, so emitting the full run here costs nothing.
  const source = (lockouts || []).find((l) => l.sourceId === task.id);
  if (source) {
    const markers = [];
    for (let i = 0; i < source.totalDays; i++) {
      const date = addDays(source.start, i);
      markers.push({
        date,
        detail: `Day ${i + 1} of ${source.totalDays}`,
        statusKey: "lockout_day",
      });
    }
    return markers;
  }

  // Silenced by someone else's lockout: contributes nothing to look forward
  // to. computeTaskStatus already decided this (status.lockedOut), so the
  // calendar and the task list can never disagree about who is held.
  if (status.lockedOut) return null;

  if (task.type === "log") {
    // Purely informational, and only when the task configures a target AND
    // has a real previous entry to count from — a never-logged task never
    // gets an invented target date.
    if (!task.target_interval_days || !status.last) return null;
    const target = addDays(status.last, task.target_interval_days);
    return target > today ? { date: target, detail: "Target", statusKey: status.statusKey } : null;
  }

  // On-demand: nothing is ever scheduled ahead, so it contributes no upcoming
  // marker at all. Its past applications still appear via the history loop.
  if (task.type === "treatment") return null;

  // A programme has several known target dates, so it's the one task type
  // that returns MORE than one marker — each still-outstanding application
  // lands on its own date. Satisfied targets simply drop out and are shown by
  // the history loop on the day they were actually applied instead.
  if (task.type === "program") {
    const targets = status.targets || [];
    return (status.remainingIdx || []).map((i) => {
      const target = targets[i];
      // Only the CURRENT occurrence carries the programme's computed status;
      // the later ones are plain future targets however urgent this one is, so
      // one overdue occurrence never reddens the rest of the season.
      const statusKey = i === status.currentIdx ? status.statusKey : "upcoming";
      if (target > today) return { date: target, detail: "Due", statusKey };
      // Already passed: only the current one is folded onto today, matching
      // how an overdue recurring task is handled below.
      if (i !== status.currentIdx) return null;
      return { date: today, detail: daysBetween(today, target) === 0 ? "Due today" : "Overdue", statusKey };
    }).filter(Boolean);
  }

  if (task.type === "follow_up") {
    // Only an OUTSTANDING follow-up is a future obligation. Once logged it
    // stops being an upcoming marker and is represented by its own history
    // entry on the day it was done, exactly like any other completion.
    if (!status.pending || !status.dueDate) return null;
    if (status.dueDate > today) return { date: status.dueDate, detail: "Due", statusKey: status.statusKey };
    // Already due/overdue: one marker on today, matching how a recurring
    // task's overdue date is folded onto today below.
    return { date: today, detail: daysBetween(today, status.dueDate) === 0 ? "Due today" : "Overdue", statusKey: status.statusKey };
  }

  if (task.type === "seasonal") {
    // Already handled for this occurrence, or the window closed unused —
    // nothing to look forward to either way.
    if (["completed", "skipped", "missed_window", "optional_finished"].includes(status.statusKey)) return null;
    if (today < status.windowStart) {
      return { date: status.windowStart, detail: optional ? "Optional · window starts" : "Window starts", statusKey: status.statusKey };
    }
    // Inside the window: one marker on TODAY only, never repeated per day.
    if (today <= status.windowEnd) {
      return { date: today, detail: optional ? "Optional · available" : "Available now", statusKey: status.statusKey };
    }
    return null;
  }

  // Recurring. Out of season contributes nothing at all (an optional task
  // that is merely inactive must not show up just to fill a cell).
  if (
    status.statusKey === "inactive" ||
    status.statusKey === "optional_finished" ||
    // Same "contributes nothing" reasoning — these are just the optional
    // recurring spellings of out-of-season (see applyOptionalRemap).
    status.statusKey === "optional_inactive" ||
    status.statusKey === "optional_season_over"
  ) return null;
  if (!status.nextDue) return { date: today, detail: optional ? "Optional · available" : "Recommended", statusKey: status.statusKey };
  if (status.nextDue > today) return { date: status.nextDue, detail: optional ? "Optional" : "Due", statusKey: status.statusKey };
  if (optional) return { date: today, detail: "Optional · available", statusKey: status.statusKey };
  return { date: today, detail: daysBetween(today, status.nextDue) === 0 ? "Due today" : "Overdue", statusKey: status.statusKey };
}

// The visible window is centred on today rather than snapped to a calendar
// week: with 7 cells that puts today in the exact middle, three days of
// context either side. Navigation still moves in whole weeks (offset * 7), so
// prev/next feel unchanged while the centre stays the anchor.
const WEEK_SPAN_DAYS = 7;

function centeredWindowStart(today, weekOffset) {
  return addDays(today, weekOffset * WEEK_SPAN_DAYS - Math.floor(WEEK_SPAN_DAYS / 2));
}

// Builds the 7 day cells. Pure: tasks in, a state-lookup callback in, plain
// data out — no DOM, no hass, so it can be exercised directly in tests.
//
// Past/today content is ONLY ever real stored history: an event exists in a
// cell because an entry with that exact date exists in that task's entity,
// never because a schedule says something should have happened.
function buildWeekEvents(tasks, dataFor, weekStart, today) {
  const days = [];
  for (let i = 0; i < WEEK_SPAN_DAYS; i++) {
    const date = addDays(weekStart, i);
    days.push({
      date,
      iso: formatISODate(date),
      // From the DATE, never from the cell index: the window is centred on
      // today, so cell 0 is whatever weekday falls three days back — it is
      // only a Monday one day in seven.
      dow: WEEK_DAY_ABBR[(date.getDay() + 6) % 7],
      isToday: formatISODate(date) === formatISODate(today),
      events: [],
    });
  }
  const byIso = new Map(days.map((d) => [d.iso, d]));

  // Resolved once for the whole strip, off the CONFIGURED tasks: a follow-up
  // never declares a lockout of its own, and computing this per task would
  // rescan every task's history for each task drawn.
  const lockouts = activeLockouts(tasks, dataFor, today);

  // Same expansion the planner card uses, so a pending follow-up shows up
  // here too — synthesis lives in withFollowUps(), never duplicated.
  for (const task of withFollowUps(tasks)) {
    const data = dataFor(task.id);
    const parentData = task.type === "follow_up" ? dataFor(task.parent_id) : null;
    const base = {
      taskId: task.id,
      taskName: task.name,
      icon: task.icon || "mdi:calendar-check",
      // The task's own stable identity color (see taskIdentityColor), used
      // as-is for recorded history and as the base for upcoming markers — a
      // marker whose status carries meaning overrides it (eventDisplayColor).
      // Kept stable for history so a past entry's color never shifts
      // as a task later becomes due or overdue.
      color: taskIdentityColor(task),
      // Carried on every event so the unrestricted calendar can label rows
      // without re-deriving which task they came from.
      category: categoryForTask(task),
    };

    for (const entry of data.entries) {
      const day = byIso.get(entry.date);
      if (!day) continue;
      // A recorded product identifies the application better than its raw
      // field values do; otherwise fall back to the recorded fields. Both
      // come from the entry itself. Current YAML (task.product, application
      // rates, ...) is never used to describe a past event.
      const product = resolveProduct(task, entry);
      day.events.push({ ...base, kind: "history", detail: product ? product.name : compactEntryDetail(task, entry) });
    }

    // Most task types contribute at most one upcoming marker; a programme
    // returns one per outstanding target, so normalise to a list here rather
    // than making every other branch return an array.
    const lockout = lockoutFor(lockouts, task);
    const upcoming = upcomingEventFor(task, computeTaskStatus(task, data, today, parentData, lockout), today, lockouts);
    for (const event of Array.isArray(upcoming) ? upcoming : upcoming ? [upcoming] : []) {
      const day = byIso.get(formatISODate(event.date));
      if (!day) continue;
      // Per EVENT, never per day: one overdue marker in a cell must not
      // recolor the other tasks sharing that day.
      const style = eventDisplayColor(task, event.statusKey);
      day.events.push({
        ...base,
        kind: "upcoming",
        detail: event.detail,
        statusKey: event.statusKey,
        color: style.color,
        attention: style.attention,
      });
    }
  }

  return days;
}

// Depth-first search for EVERY custom:lawn-maintenance-card config in a
// Lovelace dashboard config, in document order. Walks generically (views /
// sections / cards / stacks / grids / anything nesting) so it keeps working
// regardless of how the dashboard is laid out around the cards.
//
// All of them, not just the first, because one card per category is a
// supported (and intended) layout: an unrestricted week calendar has to see
// every category's tasks, and it can only do that by reading every card.
function findLawnMaintenanceConfigs(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) findLawnMaintenanceConfigs(child, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  if (node.type === "custom:lawn-maintenance-card" && Array.isArray(node.tasks)) {
    out.push(node);
    return out;
  }
  for (const value of Object.values(node)) findLawnMaintenanceConfigs(value, out);
  return out;
}

class LawnWeekCalendar extends HTMLElement {
  setConfig(config) {
    const cfg = config || {};
    if (cfg.tasks !== undefined && !Array.isArray(cfg.tasks)) {
      throw new Error("lawn-week-calendar: `tasks` must be a list when you set it explicitly — omit it entirely to read the tasks from your lawn-maintenance-card");
    }
    this._config = {
      title: typeof cfg.title === "string" ? cfg.title : null,
      // Explicit tasks are supported (a standalone install with no
      // maintenance card on the dashboard), but the normal, documented setup
      // omits them so there is only ever one copy of the task YAML.
      tasks: Array.isArray(cfg.tasks) ? normalizeTaskConfig(cfg.tasks, "lawn-week-calendar") : null,
      // Only needed when the maintenance card lives on a *different*
      // dashboard than this card.
      sourceDashboard: typeof cfg.source_dashboard === "string" ? cfg.source_dashboard : null,
      // Unlike the maintenance card, the calendar has no selector and omitting
      // `category:` is meaningful: no category = the master calendar across
      // every category. Set it and the calendar is filtered to that one, with
      // no way to change it at runtime.
      category: typeof cfg.category === "string" && cfg.category.trim() ? cfg.category.trim() : null,
      categoryLabels: buildCategoryLabels(cfg),
      // Same option, same meaning, same shared filter as the planner card, so a
      // person's week matches their task list exactly. Absent = all.
      assignee: typeof cfg.assignee === "string" && cfg.assignee.trim() ? cfg.assignee.trim() : ASSIGNEE_ALL,
    };
    // Labels found on the maintenance card(s) this calendar reads its tasks
    // from, so category names do not have to be repeated in the calendar's own
    // YAML. Its own `category_labels:` still wins — see _categoryLabel.
    this._discoveredCategoryLabels = {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._built = false;
    // Weeks away from the week containing today. Only ever changed by the
    // nav buttons — never reset by a re-render or an incoming hass update,
    // so a live state change can't yank the user back to the current week.
    this._weekOffset = 0;
    this._discovered = null;
    this._discoveryError = null;
    this._discovering = false;
    this._lastSignature = null;
    this._scrolledWeekKey = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config.tasks && !this._discovered && !this._discovering && !this._discoveryError) {
      this._discoverTasks();
    }
    this._scheduleRender();
  }

  connectedCallback() {
    // Keeps "today" correct across midnight without polling any backend —
    // same one-minute tick the maintenance card uses.
    if (!this._tick) this._tick = setInterval(() => this._scheduleRender(), 60000);
    this._subscribeLovelace();
  }

  disconnectedCallback() {
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
    if (this._unsubLovelace) {
      this._unsubLovelace();
      this._unsubLovelace = null;
    }
  }

  getCardSize() {
    return 3;
  }

  static getStubConfig() {
    return {};
  }

  _tasks() {
    return this._config.tasks || this._discovered;
  }

  // The tasks this calendar is built from: every category when none is
  // configured, otherwise just the configured one. Filtering the configured
  // list (rather than the follow-up-expanded one) is equivalent and keeps
  // buildWeekEvents unchanged — a follow-up always carries its parent's
  // category, so a parent that is filtered out takes its follow-ups with it.
  // Used by BOTH _renderBody and _computeSignature, so what is drawn and what
  // triggers a redraw can never disagree.
  _effectiveTasks() {
    const tasks = this._tasks();
    if (!tasks) return null;
    // Category first, then assignee — the identical pair the planner card
    // applies in _categoryTasks, through the identical helpers, so the two
    // views can never disagree about whose week this is. Filtering the
    // configured list is enough: a follow-up inherits both properties from its
    // parent, so a parent that is filtered out takes its follow-ups with it.
    return tasksForAssignee(tasksForCategory(tasks, this._config.category), this._config.assignee);
  }

  _categoryLabel(id) {
    return categoryLabel(id, { ...this._discoveredCategoryLabels, ...this._config.categoryLabels });
  }

  // Which dashboard to read the task config from: an explicit
  // source_dashboard, else the dashboard this card is currently displayed on
  // (the first path segment, e.g. /my-dashboard/schedule -> my-dashboard).
  _dashboardUrlPath() {
    if (this._config.sourceDashboard) return this._config.sourceDashboard;
    return (window.location.pathname || "").split("/").filter(Boolean)[0] || null;
  }

  async _discoverTasks() {
    if (!this._hass || !this._hass.callWS) return;
    this._discovering = true;
    const fetchConfig = (urlPath) =>
      this._hass.callWS(urlPath ? { type: "lovelace/config", url_path: urlPath } : { type: "lovelace/config" });

    const urlPath = this._dashboardUrlPath();
    let lovelaceConfig = null;
    try {
      lovelaceConfig = await fetchConfig(urlPath);
    } catch (err) {
      // A url_path derived from the address bar can be wrong (a non-Lovelace
      // panel, a moved dashboard, ...) — fall back to the default dashboard
      // before giving up.
      if (urlPath) {
        try {
          lovelaceConfig = await fetchConfig(null);
        } catch (fallbackErr) {
          this._discoveryError = `Could not read the dashboard configuration (${fallbackErr.code || fallbackErr.message || fallbackErr}).`;
        }
      } else {
        this._discoveryError = `Could not read the dashboard configuration (${err.code || err.message || err}).`;
      }
    }

    if (lovelaceConfig) {
      const found = findLawnMaintenanceConfigs(lovelaceConfig);
      if (!found.length) {
        this._discoveryError =
          "No lawn-maintenance-card found on this dashboard. Add one, set `source_dashboard:` to the dashboard that has it, or give this card its own `tasks:` list.";
      } else {
        try {
          // Every maintenance card on the dashboard, merged in document order.
          // Each card's list is normalized on its own (so its own duplicate ids
          // still error), then merged by id: the same task listed on two cards
          // is one task, not two rows on the same day.
          const merged = [];
          const seen = new Set();
          const labels = {};
          for (const cardConfig of found) {
            Object.assign(labels, buildCategoryLabels(cardConfig));
            for (const task of normalizeTaskConfig(cardConfig.tasks, "lawn-week-calendar")) {
              if (seen.has(task.id)) continue;
              seen.add(task.id);
              merged.push(task);
            }
          }
          this._discovered = merged;
          this._discoveredCategoryLabels = labels;
          this._discoveryError = null;
        } catch (err) {
          this._discoveryError = err.message;
        }
      }
    }

    this._discovering = false;
    this._lastSignature = null;
    this._scheduleRender();
  }

  // Re-read the task config if the dashboard it came from is edited, so the
  // two cards can't drift apart while the page stays open. One event
  // subscription, not a poll.
  _subscribeLovelace() {
    if (this._unsubLovelace || this._config.tasks) return;
    if (!this._hass || !this._hass.connection) return;
    const pending = this._hass.connection.subscribeEvents(() => {
      this._discovered = null;
      this._discoveryError = null;
      this._discovering = false;
      this._discoverTasks();
    }, "lovelace_updated");
    // subscribeEvents resolves to the unsubscribe function; store a wrapper
    // so disconnectedCallback can call it even if it's still in flight.
    let unsub = null;
    let cancelled = false;
    pending.then(
      (fn) => {
        unsub = fn;
        if (cancelled) fn();
      },
      () => {}
    );
    this._unsubLovelace = () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }

  _scheduleRender() {
    if (!this._hass || !this._config) return;
    if (!this._built) {
      this._buildShell();
      this._built = true;
      this._lastSignature = null;
    }
    const sig = this._computeSignature();
    if (sig === this._lastSignature) return;
    this._lastSignature = sig;
    this._renderBody();
  }

  // Watches every task's own entity, so anything that writes lawn history —
  // this dashboard, the maintenance card, or an external automation logging
  // irrigation or rainfall — repaints the strip with no page reload and no
  // polling. The date and the selected week are part of the signature so a
  // midnight rollover and the nav buttons also repaint.
  _computeSignature() {
    // The category-effective collection, so a filtered calendar is not woken
    // by writes in a category it does not show — and an unrestricted one still
    // reacts to every category, because nothing is filtered out of it.
    const tasks = this._effectiveTasks();
    if (!tasks) return `unresolved:${this._discovering}:${this._discoveryError || ""}`;
    // MUST be the same effective collection buildWeekEvents() renders from —
    // withFollowUps(), not the raw configured list. A follow-up's completions
    // live in their own pyscript.lawn_<parent>_fu_<id> entity, so a wash being
    // logged, deleted or re-dated only ever moves THAT entity's last_updated.
    // Signing just the configured tasks left the signature unchanged for those
    // writes, _scheduleRender() short-circuited, and the calendar kept showing
    // a pending row it had already been told was gone. Going through the same
    // helper means any future synthesized task type is picked up automatically.
    const taskSig = withFollowUps(tasks)
      .map((t) => {
        const st = this._hass.states[`pyscript.lawn_${t.id}`];
        return st ? `${t.id}:${st.last_updated}` : `${t.id}:none`;
      })
      .join("|");
    return `${formatISODate(todayLocal())}|${this._weekOffset}|${taskSig}`;
  }

  _buildShell() {
    this.shadowRoot.innerHTML = `<style>${WEEK_CALENDAR_CSS}</style><ha-card><div class="lwc-root"></div></ha-card>`;
    this.shadowRoot.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-action]");
      if (!el) return;
      const action = el.dataset.action;
      if (action === "prev-week") this._weekOffset -= 1;
      else if (action === "next-week") this._weekOffset += 1;
      else if (action === "today-week") {
        this._weekOffset = 0;
        // Re-centre even when the window is already today's: the user may have
        // scrolled the strip by hand, and Today must undo that too. Clearing
        // both keys forces _renderBody past its "same week, keep the scroll"
        // shortcut and past the signature short-circuit.
        this._scrolledWeekKey = null;
        this._lastSignature = null;
      } else return;
      this._scheduleRender();
    });
  }

  _render() {
    if (!this._hass) return;
    this._built = false;
    this._scheduleRender();
  }

  _renderBody() {
    const root = this.shadowRoot.querySelector(".lwc-root");
    if (!root) return;
    const tasks = this._effectiveTasks();
    const titleHtml = this._config.title ? `<div class="lwc-title">${escapeHtml(this._config.title)}</div>` : "";

    if (!tasks) {
      root.innerHTML = `${titleHtml}<div class="lwc-message">${
        this._discoveryError ? escapeHtml(this._discoveryError) : "Loading lawn tasks…"
      }</div>`;
      return;
    }

    const today = todayLocal();
    const weekStart = centeredWindowStart(today, this._weekOffset);
    const weekEnd = addDays(weekStart, WEEK_SPAN_DAYS - 1);
    const days = buildWeekEvents(
      tasks,
      (taskId) => normalizeTaskState(this._hass.states[`pyscript.lawn_${taskId}`]),
      weekStart,
      today
    );

    // A filtered calendar never repeats its one category on every row. An
    // unrestricted one only labels rows once there is actually something to
    // tell apart — with every task in a single category the marker would be
    // noise on every line, and it starts appearing by itself the moment a
    // second category has tasks.
    const showCategories = !this._config.category && distinctCategories(tasks).length > 1;

    // Preserve wherever the user had scrolled to when a live state update
    // repaints the same week; only a week change re-positions the strip.
    const weekKey = formatISODate(weekStart);
    const previousStrip = root.querySelector(".week-strip");
    const previousScroll = previousStrip ? previousStrip.scrollLeft : 0;

    root.innerHTML = `
      ${titleHtml}
      <div class="lwc-header">
        <button class="lwc-nav" data-action="prev-week" aria-label="Previous week" title="Previous week">
          <ha-icon icon="mdi:chevron-left"></ha-icon>
        </button>
        <div class="lwc-range">${escapeHtml(formatWeekRange(weekStart, weekEnd))}</div>
        <button class="lwc-today-btn" data-action="today-week" aria-label="Go to the week containing today">Today</button>
        <button class="lwc-nav" data-action="next-week" aria-label="Next week" title="Next week">
          <ha-icon icon="mdi:chevron-right"></ha-icon>
        </button>
      </div>
      <div class="week-strip" role="list">
        ${days.map((day) => this._renderDay(day, showCategories)).join("")}
      </div>`;

    const strip = root.querySelector(".week-strip");
    if (weekKey === this._scrolledWeekKey) {
      strip.scrollLeft = previousScroll;
    } else {
      this._scrolledWeekKey = weekKey;
      this._positionStrip(strip);
    }
  }

  // On a narrow (scrolling) strip showing the current week, start with today
  // in view instead of always at Monday. Set synchronously right after the
  // innerHTML assignment, before the browser paints, so there is no visible
  // jump — and never animated.
  _positionStrip(strip, attempt = 0) {
    // Bail on a strip that a later re-render already replaced, and cap the
    // retries: a card sitting in a container that is never laid out (a hidden
    // view, a collapsed panel) reports clientWidth 0 forever, and an
    // unbounded retry there would re-arm itself every single frame.
    if (!strip || !strip.isConnected) return;
    if (!strip.clientWidth) {
      if (attempt >= 3) return;
      // Not laid out yet (e.g. the card is still being attached) — retry on a
      // later frame rather than measuring zeros. Note this stays pending
      // while the tab is in the background, since frames are suspended there;
      // it resolves on its own once the tab is visible again.
      requestAnimationFrame(() => this._positionStrip(strip, attempt + 1));
      return;
    }
    const scrollable = strip.scrollWidth - strip.clientWidth > 1;
    const todayEl = this._weekOffset === 0 ? strip.querySelector(".lwc-day.is-today") : null;
    if (!scrollable || !todayEl) {
      // Everything fits (or we're on another week): the window is already
      // centred on today by construction, so start at the left edge.
      strip.scrollLeft = 0;
      return;
    }
    // Narrow enough to scroll: put today's MIDDLE at the viewport's middle
    // rather than flush left, so the same "today in the centre" reading holds
    // when only two or three cells fit. Clamped to the real scroll range, so
    // the first/last few days still land as close to centre as they can.
    const target = todayEl.offsetLeft + todayEl.offsetWidth / 2 - strip.clientWidth / 2;
    strip.scrollLeft = Math.max(0, Math.min(target, strip.scrollWidth - strip.clientWidth));
  }

  _renderDay(day, showCategories) {
    const eventsHtml = day.events
      .map(
        (e) => `
        <div class="lwc-event ${e.kind === "upcoming" ? "is-upcoming" : "is-history"}${e.attention ? " is-attention" : ""}" style="--lwc-event-color:${e.color}">
          <ha-icon class="lwc-event-icon" icon="${e.icon}"></ha-icon>
          <div class="lwc-event-text">
            ${showCategories ? `<div class="lwc-event-cat">${escapeHtml(this._categoryLabel(e.category))}</div>` : ""}
            <div class="lwc-event-name">${escapeHtml(e.taskName)}</div>
            ${e.detail ? `<div class="lwc-event-detail">${escapeHtml(e.detail)}</div>` : ""}
          </div>
        </div>`
      )
      .join("");

    return `
      <div class="lwc-day${day.isToday ? " is-today" : ""}" role="listitem"${day.isToday ? ' aria-current="date"' : ""}>
        <div class="lwc-day-head">
          <span class="lwc-dow">${day.dow}</span>
          <span class="lwc-dom">${day.date.getDate()}</span>
          ${day.isToday ? `<span class="lwc-today-badge">Today</span>` : ""}
        </div>
        <div class="lwc-day-events">${eventsHtml}</div>
      </div>`;
  }
}

const WEEK_CALENDAR_CSS = `
  :host { display: block; }
  ha-card { padding: 8px 10px 10px; }
  /* Everything responsive below sizes against the CARD's width, not the
     viewport's — a Lovelace card can be narrow on a wide screen. The
     @container rules are a progressive enhancement: browsers without
     container query support simply fall back to the base grid-auto-columns
     rule (plus the @media twin), which still scrolls correctly. */
  .lwc-root { container-type: inline-size; }
  .lwc-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--primary-text-color);
    padding: 0 2px 6px;
  }
  .lwc-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 0 8px;
  }
  .lwc-range {
    flex: 1 1 auto;
    min-width: 0;
    text-align: center;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--primary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lwc-nav, .lwc-today-btn {
    font: inherit;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.25));
    background: var(--secondary-background-color, rgba(127,127,127,0.12));
    color: var(--secondary-text-color);
    border-radius: 8px;
    cursor: pointer;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .lwc-nav { padding: 2px 4px; --mdc-icon-size: 18px; }
  .lwc-today-btn {
    padding: 3px 9px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .lwc-nav:hover, .lwc-today-btn:hover { color: var(--primary-text-color); }
  .lwc-nav:focus-visible, .lwc-today-btn:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
  .lwc-message {
    padding: 10px 2px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--secondary-text-color);
  }

  .week-strip {
    position: relative;
    display: grid;
    grid-auto-flow: column;
    /* 7 x 112px = 784px, so a normal ~900px desktop card lays all seven days
       out as equal 1fr columns with nothing to scroll. Narrower cards keep
       the 112px readable minimum and scroll instead of shrinking. */
    grid-auto-columns: minmax(112px, 1fr);
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    /* Keeps a swipe that runs past the end of the strip from scrolling the
       page/dashboard sideways. */
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    /* Native touch/trackpad scrolling stays fully functional; only the
       scrollbar furniture is hidden. */
    scrollbar-width: none;
  }
  .week-strip::-webkit-scrollbar { display: none; }

  .lwc-day {
    /* Centre, not start: the window is built around today (see
       centeredWindowStart), and a start-aligned mandatory snap would drag any
       centred scroll position back to a cell's left edge — making "today in the
       middle" impossible on a strip narrow enough to scroll. Snapping to the
       centre keeps both the programmatic positioning and the user's own swipes
       agreeing on where a day belongs. */
    scroll-snap-align: center;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 6px 7px 8px;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.2));
    border-radius: 10px;
    background: var(--card-background-color, transparent);
  }
  /* Today is marked three ways — accent border, subtle tint, and the literal
     word "Today" — so it never depends on color alone. */
  .lwc-day.is-today {
    border-color: var(--primary-color);
    background: rgba(127,127,127,0.07);
  }
  .lwc-day-head {
    display: flex;
    align-items: baseline;
    gap: 5px;
    flex-wrap: wrap;
  }
  .lwc-dow {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--secondary-text-color);
  }
  .lwc-dom {
    font-size: 15px;
    font-weight: 700;
    line-height: 1;
    color: var(--primary-text-color);
  }
  .lwc-today-badge {
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-primary-color, #fff);
    background: var(--primary-color);
    border-radius: 5px;
    padding: 1px 4px;
  }
  .lwc-day-events {
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* One unusually busy day scrolls inside its own cell rather than
       stretching the whole card — task names still wrap in full, never
       truncated. */
    max-height: 220px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .lwc-event {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    padding: 1px 0 1px 5px;
    border-left: 3px solid var(--lwc-event-color);
  }
  /* Planned, not recorded — a dashed accent tells the two apart without
     reusing the status colors. */
  .lwc-event.is-upcoming { border-left-style: dashed; }
  .lwc-event-icon {
    --mdc-icon-size: 13px;
    color: var(--lwc-event-color);
    flex-shrink: 0;
    margin-top: 1px;
  }
  .lwc-event-text { min-width: 0; }
  /* Only ever rendered by the unrestricted calendar, and only once more than
     one category is present — a quiet overline, not a badge competing with
     the task name. */
  .lwc-event-cat {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    line-height: 1.2;
    color: var(--secondary-text-color);
    opacity: 0.75;
    overflow-wrap: anywhere;
  }
  .lwc-event-name {
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--primary-text-color);
    overflow-wrap: anywhere;
  }
  .lwc-event-detail {
    font-size: 10.5px;
    line-height: 1.25;
    color: var(--secondary-text-color);
    overflow-wrap: anywhere;
  }
  /* A marker whose status needs attention (see eventDisplayColor): the accent
     and icon already follow --lwc-event-color, which now holds the STATUS
     color rather than the task's identity color, so only the status text needs
     saying explicitly. Deliberately scoped to the event — the day cell keeps
     its normal background and its orange Today border, and the task NAME keeps
     the normal text color, exactly as on the planner card's rows. */
  .lwc-event.is-attention .lwc-event-detail {
    color: var(--lwc-event-color);
    font-weight: 600;
  }

  /* Roughly two day cards in view on a phone, the rest a swipe away. */
  @container (max-width: 560px) {
    .week-strip { grid-auto-columns: 46%; }
  }
  @media (max-width: 560px) {
    .week-strip { grid-auto-columns: 46%; }
  }
`;

if (!customElements.get("lawn-week-calendar")) {
  customElements.define("lawn-week-calendar", LawnWeekCalendar);
}

window.customCards.push({
  type: "lawn-week-calendar",
  name: "Lawn Week Calendar",
  description: "Read-only 7-day (Mon–Sun) lawn strip: recorded history up to today, upcoming due dates and seasonal windows ahead. Reads the same tasks and history as your lawn-maintenance-card — no second task list to maintain.",
});
