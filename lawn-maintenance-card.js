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

const CARD_VERSION = "32";
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

const SECTION_ORDER = ["needs_attention", "upcoming", "logs", "optional", "season_finished", "inactive"];
const SECTION_LABELS = {
  needs_attention: "Needs attention",
  upcoming: "Upcoming",
  logs: "Activity",
  optional: "Optional",
  season_finished: "Season finished",
  inactive: "Inactive",
};
// Sections collapsed by default when a task list first renders — low-priority
// sections stay out of the way until the user asks to see them.
const DEFAULT_COLLAPSED_SECTIONS = ["optional", "season_finished", "inactive"];
const COLLAPSIBLE_SECTIONS = new Set(["optional", "season_finished", "inactive"]);

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
  // Optional tasks (task.optional: true) never compute overdue/missed —
  // computeRecurringStatus/computeSeasonalStatus run normally for the date
  // math, then applyOptionalRemap() maps their result onto these calm,
  // non-urgency statuses instead. completed/skipped pass through unchanged
  // (already calm colors) and just get moved into the optional section.
  optional_available: { color: "#a78bfa", icon: "mdi:leaf-circle-outline", section: "optional", rank: 0 },
  optional_upcoming: { color: "#a78bfa", icon: "mdi:calendar-clock-outline", section: "optional", rank: 1 },
  optional_finished: { color: "#a78bfa", icon: "mdi:calendar-blank-outline", section: "optional", rank: 2 },
  // type: log tasks (see computeLogStatus) — a single calm status regardless
  // of how long ago the last entry was. Never overdue/alarming by design;
  // any "may be due" nudge from target_interval_days is conveyed in the
  // row/detail text, not through color.
  log: { color: "#3b82f6", icon: "mdi:calendar-check-outline", section: "logs", rank: 0 },
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
const HIDE_NEXT_DUE_STATUS_KEYS = new Set(["inactive", "optional_available", "optional_finished"]);

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
  const inSeasonNow = activeMonths.includes(today.getMonth() + 1);
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
  const seasonSuspended = !!nextDue && !activeMonths.includes(nextDue.getMonth() + 1);

  if (!inSeasonNow || seasonSuspended) {
    // If today itself is inactive, resume-search from today. If today is
    // active but the calculated date fell in a later inactive gap, resume-
    // search from that date instead (it's the more relevant reference).
    const resumeFrom = inSeasonNow && seasonSuspended ? nextDue : today;
    const label = inactiveLabel(activeMonths, resumeFrom, today);
    return { ...base, statusKey: "inactive", label, detail: "" };
  }

  if (!nextDue) {
    return { ...base, statusKey: "recommended_now", label: "Recommended now", detail: "Never completed" };
  }

  const diff = daysBetween(today, nextDue);
  const dueSoonDays = task.due_soon_days ?? 3;

  if (diff < 0) {
    const n = -diff;
    return { ...base, statusKey: "overdue", label: `Overdue by ${n} day${n === 1 ? "" : "s"}${suffix}`, detail: "" };
  }
  if (diff === 0) return { ...base, statusKey: "due_today", label: `Due today${suffix}`, detail: "" };
  if (diff === 1) {
    return { ...base, statusKey: dueSoonDays >= 1 ? "due_soon" : "upcoming", label: `Due tomorrow${suffix}`, detail: "" };
  }
  if (diff <= dueSoonDays) return { ...base, statusKey: "due_soon", label: `Due in ${diff} days${suffix}`, detail: "" };
  return { ...base, statusKey: "upcoming", label: `Due in ${diff} days${suffix}`, detail: "" };
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
    if (daysUntil <= upcomingDays) {
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
  if (task.target_interval_days) {
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
  return "";
}

// Resolves a history entry's stored product_id against the task's current
// `products:` list. Shared by the Tasks tab's history list and Year History
// so both resolve products the exact same way.
function resolveProduct(task, entry) {
  return entry.productId && task.products ? task.products.find((p) => p.id === entry.productId) || null : null;
}

// A small fixed palette of calm, mutually distinguishable accent colors
// (no red/orange, same "informational, never alarming" convention as the
// rest of this file's badges/hints) cycled deterministically by task id.
// Unlike the Tasks tab's --status-color (which reflects a task's CURRENT
// due/overdue/skipped state and is deliberately never used here), this is
// keyed only by the task's own id, so a given task's Year History accent
// never changes as its live status changes over time — completed history
// is stable, only today's status isn't.
const HISTORY_TASK_COLORS = ["#3b82f6", "#22c55e", "#a78bfa", "#06b6d4", "#eab308", "#ec4899", "#84cc16", "#14b8a6"];

function taskHistoryColor(task) {
  const key = task.id || task.name || "";
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return HISTORY_TASK_COLORS[Math.abs(hash) % HISTORY_TASK_COLORS.length];
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

// Fills in derived task/product ids and the boolean flags the rest of this
// file relies on. Module-level and card-name-parameterized so both cards
// normalize the same YAML into the same shape — LawnWeekCalendar reads the
// maintenance card's raw config straight out of the Lovelace config, which
// has not been through anyone's setConfig, so it has to run the exact same
// normalization or a task without an explicit `id` would resolve to a
// different entity in each card.
function normalizeTaskConfig(tasks, cardName) {
  const seen = new Set();
  return tasks.map((t, i) => {
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
    return { ...t, id, optional: !!t.optional, allow_photo: !!t.allow_photo, ...(products ? { products } : {}) };
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

  // Recurring: inactive (out of season, or interval math suspended by the
  // season gap check) always maps to "Optional · inactive" — the original,
  // more detailed label ("Inactive · resumes September") is kept as the
  // status detail so it's still visible when the row is expanded.
  if (status.statusKey === "inactive") {
    return { ...status, statusKey: "optional_finished", label: "Optional · inactive", detail: status.label };
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

function computeTaskStatus(task, data, today) {
  let status;
  if (task.type === "seasonal") status = computeSeasonalStatus(task, data, today);
  else if (task.type === "log") status = computeLogStatus(task, data, today);
  else status = computeRecurringStatus(task, data, today);
  status = applyOptionalRemap(task, status, today);
  const meta = STATUS_META[status.statusKey] || STATUS_META.inactive;
  // Belt-and-suspenders: even if a future statusKey slipped through the
  // remap above without being reassigned, an optional task must never be
  // sorted into needs_attention. Within that constraint, an optional
  // seasonal task whose window has closed for the year (finished unused,
  // completed, or skipped) moves to Season finished alongside its
  // mandatory counterparts instead of sitting in Optional forever — its
  // label/color stay whatever the remap already set (calm purple, never
  // the red/orange "missed" styling), only the section changes. Optional
  // recurring tasks always stay in Optional regardless of state. Log tasks
  // always use their own "logs" section regardless of `optional` — that
  // flag has no meaning for them (see applyOptionalRemap).
  let section;
  if (task.type === "log") {
    section = meta.section;
  } else if (!task.optional) {
    section = meta.section;
  } else if (task.type === "seasonal" && OPTIONAL_SEASON_ENDED_KEYS.has(status.statusKey)) {
    section = "season_finished";
  } else {
    section = "optional";
  }
  return { ...status, section, rank: meta.rank, color: meta.color, icon: meta.icon };
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
      title: config.title || "LAWN MAINTENANCE",
      tasks: normalizeTaskConfig(config.tasks, "lawn-maintenance-card"),
      show_overview: config.show_overview !== false,
    };
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
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
    const taskSig = this._config.tasks
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
    return `${taskSig}::${advisorySig}`;
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
      durationMet = points.length > 0 && points.every((p) => advisoryConditionMet(Number(p.state), advisory));
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
    const task = this._config.tasks.find((t) => t.id === taskId);
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
        if ((task.products && task.products.length) || task.allow_photo) {
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
    this._el.title.textContent = this._config.title;
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

    for (const task of this._config.tasks) {
      const data = this._taskState(task.id);
      const status = computeTaskStatus(task, data, today);
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
    return html || `<div class="empty-state">No tasks configured.</div>`;
  }

  // Log tasks get their own compact row: a prominent quick-action button
  // instead of the small circular checkmark, and a single "<value_label>:
  // <date> · <relative>" line instead of Last:/Next:. Reuses data-action
  // ="done" so it goes through the exact same write/refresh path as every
  // other task (see _handleAction) — the delegated click listener already
  // stops propagation for anything with [data-action], so clicking it can
  // never also toggle the row's expanded state.
  _renderLogTaskRow(task, data, status) {
    const expanded = this._expandedId === task.id;
    const actionLabel = task.action_label || "DONE TODAY";
    return `
      <div class="task log-task ${expanded ? "expanded" : ""}" style="--status-color:${status.color}">
        <div class="task-header" data-task-id="${task.id}">
          <ha-icon class="task-icon" icon="${task.icon || "mdi:notebook-outline"}"></ha-icon>
          <div class="task-main">
            <div class="task-top-row">
              <span class="task-name-group">
                <span class="task-name">${escapeHtml(task.name)}</span>
              </span>
            </div>
            <div class="task-lines">
              <span class="line-item">${logRowText(task, status)}</span>
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
                <span class="task-name">${escapeHtml(task.name)}</span>
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

  _renderHistoryItem(task, entry) {
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
    return `
      <li>
        <div class="history-main">
          <span class="history-date">${formatShortYear(parseISODate(iso))}${productText}${fieldsText}</span>
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

    if (task.description) infoRows.push(["Description", escapeHtml(task.description)]);
    if (task.notes) infoRows.push(["Notes", escapeHtml(task.notes)]);
    if (status.detail) infoRows.push(["Status detail", escapeHtml(status.detail)]);
    if (data.sy.length) infoRows.push(["Skipped years", data.sy.join(", ")]);

    const historyHtml = data.entries.length
      ? data.entries.map((entry) => this._renderHistoryItem(task, entry)).join("")
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
            ? `<button class="done-btn" data-action="toggle-add-app" data-task-id="${task.id}">LOG APPLICATION</button>`
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

        <div class="history-label">${escapeHtml(task.history_label || "History")} (${data.h.length})</div>
        <ul class="history-list">${historyHtml}</ul>
      </div>
    `;
  }

  _renderOverview() {
    const byMonth = Array.from({ length: 12 }, () => []);
    const todayMonthIdx = todayLocal().getMonth();
    for (const task of this._config.tasks) {
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
      } else if (task.window) {
        for (const m of monthsOverlappingWindow(task.window)) {
          byMonth[m - 1].push(`${escapeHtml(task.name)}${optionalBadge} <span class="dim">(${task.window.start} – ${task.window.end})</span>`);
        }
      }
    }
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
    for (const task of this._config.tasks) {
      const data = this._taskState(task.id);
      for (const entry of data.entries) {
        events.push({
          date: entry.date,
          dateObj: parseISODate(entry.date),
          taskName: task.name,
          icon: task.icon || "mdi:calendar-check",
          color: taskHistoryColor(task),
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
        ${yearEvents.length ? monthsHtml : `<div class="empty-state">No lawn activity recorded for ${selectedYear}.</div>`}
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
     taskHistoryColor) — deliberately NOT --status-color, since a
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
// history normalization, taskHistoryColor) so there is exactly one
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
function upcomingEventFor(task, status, today) {
  const optional = !!task.optional;

  if (task.type === "log") {
    // Purely informational, and only when the task configures a target AND
    // has a real previous entry to count from — a never-logged task never
    // gets an invented target date.
    if (!task.target_interval_days || !status.last) return null;
    const target = addDays(status.last, task.target_interval_days);
    return target > today ? { date: target, detail: "Target" } : null;
  }

  if (task.type === "seasonal") {
    // Already handled for this occurrence, or the window closed unused —
    // nothing to look forward to either way.
    if (["completed", "skipped", "missed_window", "optional_finished"].includes(status.statusKey)) return null;
    if (today < status.windowStart) {
      return { date: status.windowStart, detail: optional ? "Optional · window starts" : "Window starts" };
    }
    // Inside the window: one marker on TODAY only, never repeated per day.
    if (today <= status.windowEnd) {
      return { date: today, detail: optional ? "Optional · available" : "Available now" };
    }
    return null;
  }

  // Recurring. Out of season contributes nothing at all (an optional task
  // that is merely inactive must not show up just to fill a cell).
  if (status.statusKey === "inactive" || status.statusKey === "optional_finished") return null;
  if (!status.nextDue) return { date: today, detail: optional ? "Optional · available" : "Recommended" };
  if (status.nextDue > today) return { date: status.nextDue, detail: optional ? "Optional" : "Due" };
  if (optional) return { date: today, detail: "Optional · available" };
  return { date: today, detail: daysBetween(today, status.nextDue) === 0 ? "Due today" : "Overdue" };
}

// Builds the 7 day cells. Pure: tasks in, a state-lookup callback in, plain
// data out — no DOM, no hass, so it can be exercised directly in tests.
//
// Past/today content is ONLY ever real stored history: an event exists in a
// cell because an entry with that exact date exists in that task's entity,
// never because a schedule says something should have happened.
function buildWeekEvents(tasks, dataFor, weekStart, today) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    days.push({
      date,
      iso: formatISODate(date),
      dow: WEEK_DAY_ABBR[i],
      isToday: formatISODate(date) === formatISODate(today),
      events: [],
    });
  }
  const byIso = new Map(days.map((d) => [d.iso, d]));

  for (const task of tasks) {
    const data = dataFor(task.id);
    const base = {
      taskId: task.id,
      taskName: task.name,
      icon: task.icon || "mdi:calendar-check",
      // Stable identity color from the task itself (see taskHistoryColor) —
      // never from today's computed status, so a cell's colors never shift
      // as a task later becomes due or overdue.
      color: taskHistoryColor(task),
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

    const upcoming = upcomingEventFor(task, computeTaskStatus(task, data, today), today);
    if (upcoming) {
      const day = byIso.get(formatISODate(upcoming.date));
      if (day) day.events.push({ ...base, kind: "upcoming", detail: upcoming.detail });
    }
  }

  return days;
}

// Depth-first search for the first custom:lawn-maintenance-card config in a
// Lovelace dashboard config. Walks generically (views / sections / cards /
// stacks / grids / anything nesting) so it keeps working regardless of how
// the dashboard is laid out around the card.
function findLawnMaintenanceConfig(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findLawnMaintenanceConfig(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.type === "custom:lawn-maintenance-card" && Array.isArray(node.tasks)) return node;
  for (const value of Object.values(node)) {
    const hit = findLawnMaintenanceConfig(value);
    if (hit) return hit;
  }
  return null;
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
    };
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
      const found = findLawnMaintenanceConfig(lovelaceConfig);
      if (!found) {
        this._discoveryError =
          "No lawn-maintenance-card found on this dashboard. Add one, set `source_dashboard:` to the dashboard that has it, or give this card its own `tasks:` list.";
      } else {
        try {
          this._discovered = normalizeTaskConfig(found.tasks, "lawn-week-calendar");
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
    const tasks = this._tasks();
    if (!tasks) return `unresolved:${this._discovering}:${this._discoveryError || ""}`;
    const taskSig = tasks
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
      else if (action === "today-week") this._weekOffset = 0;
      else return;
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
    const tasks = this._tasks();
    const titleHtml = this._config.title ? `<div class="lwc-title">${escapeHtml(this._config.title)}</div>` : "";

    if (!tasks) {
      root.innerHTML = `${titleHtml}<div class="lwc-message">${
        this._discoveryError ? escapeHtml(this._discoveryError) : "Loading lawn tasks…"
      }</div>`;
      return;
    }

    const today = todayLocal();
    const weekStart = addDays(mondayOf(today), this._weekOffset * 7);
    const weekEnd = addDays(weekStart, 6);
    const days = buildWeekEvents(
      tasks,
      (taskId) => normalizeTaskState(this._hass.states[`pyscript.lawn_${taskId}`]),
      weekStart,
      today
    );

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
        ${days.map((day) => this._renderDay(day)).join("")}
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
    strip.scrollLeft = scrollable && todayEl ? todayEl.offsetLeft : 0;
  }

  _renderDay(day) {
    const eventsHtml = day.events
      .map(
        (e) => `
        <div class="lwc-event ${e.kind === "upcoming" ? "is-upcoming" : "is-history"}" style="--lwc-event-color:${e.color}">
          <ha-icon class="lwc-event-icon" icon="${e.icon}"></ha-icon>
          <div class="lwc-event-text">
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
    scroll-snap-align: start;
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
