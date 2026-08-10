# Lawn Maintenance Card backend — persists task completion history,
# skipped-year flags, and manual next-due overrides in pyscript entity
# *attributes* (no 255-char state limit applies to attributes, so history
# is effectively unlimited).
#
# Each task gets one dynamic entity: pyscript.lawn_<task_id>
#   state:      most recent completion date (YYYY-MM-DD), or "never"
#   attributes: history (list, newest first, deduped by day — see below),
#               skipped_years (list of int),
#               next_due_override (YYYY-MM-DD or None)
#
# A history entry is EITHER a plain "YYYY-MM-DD" string (no product/fields/
# snapshots/media recorded — this is also the original, pre-products format,
# so old stored data keeps working untouched) OR a dict with "date" plus any
# of "product_id" (a task's `products:` list), "fields" (a task's
# `entry_fields:` list), "snapshots" + "captured_at" (a task's
# `snapshot_entities:` list — each entity's live state frozen at log time,
# never re-read live afterward), and "media" (a task's `allow_photo: true` —
# a list of {"id", "type"} references into HA's own image_upload storage;
# image bytes never pass through here, only the id image_upload returns).
# Every function below that touches history goes through _entry_date() so
# it doesn't care which shape a given entry is.
#
# A registry entity (pyscript.lawn_registry) remembers every task_id seen,
# so the startup trigger can re-persist() each one after a restart —
# without this, only entities persist() has already been called for in the
# *current* run would survive a restart at all.

REGISTRY = "pyscript.lawn_registry"

# state.persist() registers an entity for HA's restore-on-restart behavior
# and (re-)applies whatever HA's restore_state storage last checkpointed for
# it — that checkpoint is written periodically, not on every single write,
# so it can lag behind a write that only just landed. _load() used to call
# state.persist() unconditionally on EVERY service call (every skip, log,
# edit, delete...), not just once — which meant a fast follow-up call could
# re-trigger a restore from a stale checkpoint and silently clobber a write
# that had just succeeded moments earlier (this is what made "skip this
# year" / "unskip" look broken: the write always landed correctly, but a
# subsequent call — even the very next unrelated one — could revert it).
# Persisting is only ever meaningful once per entity per run, so this set
# guards it down to that: the real restore-on-restart registration still
# happens exactly once at startup via lawn_restore_all() below, and this
# only covers a brand-new task's very first use before that trigger has
# ever seen it.
_persisted_entities = set()


def _entity(task_id):
    return f"pyscript.lawn_{task_id}"


def _entry_date(entry):
    return entry if isinstance(entry, str) else entry.get("date")


def _known_task_ids():
    if REGISTRY not in _persisted_entities:
        state.persist(REGISTRY, default_attributes={"task_ids": []})
        _persisted_entities.add(REGISTRY)
    attrs = state.getattr(REGISTRY) or {}
    return list(attrs.get("task_ids", []))


def _register_task_id(task_id):
    task_ids = _known_task_ids()
    if task_id not in task_ids:
        task_ids.append(task_id)
        state.set(REGISTRY, "ok", {"task_ids": task_ids})


def _load(task_id):
    entity_id = _entity(task_id)
    if entity_id not in _persisted_entities:
        state.persist(entity_id)
        _persisted_entities.add(entity_id)
    _register_task_id(task_id)
    attrs = dict(state.getattr(entity_id) or {})
    # Copy the mutable containers, don't just dict() the top level.
    #
    # state.getattr() hands back the attribute values HA is currently holding
    # for this entity, and dict() only copies the outer mapping — so
    # attrs["history"] would be the very same list object that lives inside
    # the entity's current state. Mutating it in place (lawn_log_task's
    # append, lawn_skip_year/lawn_unskip_year's append/remove) edits HA's
    # *old* state as a side effect. HA builds the entity-subscription payload
    # the frontend's state store consumes by diffing old vs new attributes;
    # with both sides pointing at the same mutated list they compare equal, so
    # no attribute change is sent at all. The state value still updates (it's
    # a fresh string), which is why an already-open dashboard would show a new
    # "last done" date while its history list stayed stale until a full page
    # reload re-fetched everything. Copying here means nothing below can ever
    # touch what HA has stored, so every save produces a genuine attribute
    # diff and propagates immediately.
    #
    # Entry dicts inside history are shared, which is fine: no service mutates
    # an existing entry in place (lawn_edit_history_entry rebuilds via
    # dict(old_entry)), they are only ever added, dropped, or replaced.
    attrs["history"] = list(attrs.get("history") or [])
    attrs["skipped_years"] = list(attrs.get("skipped_years") or [])
    attrs.setdefault("next_due_override", None)
    return entity_id, attrs


def _save(entity_id, attrs):
    # One entry per calendar day, newest first — this is what makes
    # edit/delete addressable by date value and keeps ADD APPLICATION (an
    # arbitrary, possibly-past date) sort correctly instead of always
    # landing at the front. Entries can be plain date strings or
    # {date, product_id} dicts (see module docstring); dedupe by date only,
    # keeping whichever entry for that date was appended last.
    by_date = {}
    for entry in attrs.get("history", []):
        by_date[_entry_date(entry)] = entry
    dates_desc = sorted(by_date.keys(), reverse=True)
    history = [by_date[d] for d in dates_desc]
    attrs["history"] = history
    new_value = dates_desc[0] if dates_desc else "never"
    # An attributes-only change (e.g. skip/unskip touching skipped_years,
    # with the completion date unchanged) can silently fail to propagate to
    # anything reading this entity over the network (REST, websocket, a
    # fresh page load) even though the live value is correct right here —
    # confirmed live: a skip alone never showed up even after a hard
    # refresh, but the same skip DID show up once a later call (e.g. DONE
    # TODAY) also changed the value itself. Force a genuine value
    # transition ahead of every save that wouldn't otherwise change the
    # value, so the real write that follows can't be mistaken for a no-op.
    # state.get() raises NameError instead of returning None for an entity
    # that has never been state.set() before (e.g. a brand-new task's very
    # first DONE TODAY) — caught here and treated as "no prior value", same
    # as it would be for any other task that's never logged anything yet.
    try:
        current_value = state.get(entity_id)
    except NameError:
        current_value = None
    if current_value == new_value:
        state.set(entity_id, "unknown", attrs)
    state.set(entity_id, new_value, attrs)


@time_trigger("startup")
def lawn_restore_all():
    for task_id in _known_task_ids():
        entity_id = _entity(task_id)
        state.persist(entity_id)
        _persisted_entities.add(entity_id)


@service
def lawn_log_task(task_id=None, date=None, product_id=None, fields=None, snapshots=None, captured_at=None, media=None):
    """yaml
    name: Lawn - Log task completion
    description: Adds a completion date to a lawn task's history (used by both DONE TODAY and ADD APPLICATION).
    fields:
      task_id:
        description: Task id (matches the id used in the Lovelace card config)
        example: fungicide
      date:
        description: Completion date, YYYY-MM-DD
        example: "2026-08-08"
      product_id:
        description: Optional product id (matches an entry in the task's `products` YAML list)
        example: propiconazole
      fields:
        description: Optional dict of generic per-entry field values, keyed by the task's `entry_fields` ids
        example: {"height": 6}
      snapshots:
        description: Optional dict of entity_id -> {label, value, unit} sensor snapshots, keyed by the task's `snapshot_entities` entity ids, captured live at log time
        example: {"sensor.soil_ec": {"label": "Soil EC", "value": "290", "unit": "µS/cm"}}
      captured_at:
        description: Optional ISO timestamp of when snapshots were captured — distinct from `date`, which is the (possibly backdated) application date
        example: "2026-08-09T21:45:00.000Z"
      media:
        description: Optional list of {id, type} references to images already uploaded via HA's image_upload API (allow_photo tasks only) — never image bytes, just the returned upload id
        example: [{"id": "3f9a2e1c-...-uuid", "type": "image"}]
    """
    if not task_id or not date:
        return
    entity_id, attrs = _load(task_id)
    # _save() dedupes by date and keeps whichever entry was appended last,
    # so logging the same date again (e.g. to attach/change a product or
    # field value) simply supersedes the previous entry for that day.
    # Collapses back to a plain date string when there's nothing extra to
    # carry (keeps storage minimal and matches the original pre-products
    # format).
    entry = {"date": date}
    if product_id:
        entry["product_id"] = product_id
    if fields:
        entry["fields"] = dict(fields)
    if snapshots:
        entry["snapshots"] = dict(snapshots)
    if captured_at:
        entry["captured_at"] = captured_at
    if media:
        entry["media"] = list(media)
    if len(entry) == 1:
        entry = date
    attrs["history"].append(entry)
    _save(entity_id, attrs)


@service
def lawn_edit_history_entry(task_id=None, old_date=None, new_date=None, fields=None, media=None):
    """yaml
    name: Lawn - Edit a history entry
    description: Changes a previously logged completion date (and optionally its per-entry field values) to new ones.
    fields:
      task_id:
        description: Task id
        example: fungicide
      old_date:
        description: Existing date to change, YYYY-MM-DD
        example: "2026-08-08"
      new_date:
        description: New date, YYYY-MM-DD
        example: "2026-08-05"
      fields:
        description: Optional dict of generic per-entry field values to set/override on this entry, keyed by the task's `entry_fields` ids
        example: {"height": 8}
      media:
        description: Optional full replacement list of {id, type} photo references — omit to keep the entry's existing photo(s) untouched (v1's edit form never passes this; it only exists so a future edit UI can add/remove/replace without a schema change)
        example: [{"id": "3f9a2e1c-...-uuid", "type": "image"}]
    """
    if not task_id or not old_date or not new_date:
        return
    entity_id, attrs = _load(task_id)
    history = attrs["history"]
    matches = [e for e in history if _entry_date(e) == old_date]
    old_entry = matches[0] if matches else None
    attrs["history"] = [e for e in history if _entry_date(e) != old_date]
    # Carries over the old entry's product_id/fields/snapshots/captured_at/
    # media (if any) rather than dropping them, then merges in any explicit
    # field overrides (so editing one field doesn't clobber others if a task
    # ever has more than one). There is deliberately no way to pass in new
    # snapshots here — a snapshot is what the sensor read AT LOG TIME, so
    # editing the date (e.g. correcting a backdated entry) must never
    # silently re-capture or discard it. `media` is only touched when
    # explicitly passed (a real replacement list, not a merge/patch like
    # `fields` — matches how product_id already works) — editing date/
    # fields alone always keeps whatever photo(s) the entry already had.
    # Collapses back to a plain date string when nothing extra is attached,
    # same as lawn_log_task.
    new_entry = dict(old_entry) if isinstance(old_entry, dict) else {}
    new_entry["date"] = new_date
    if fields:
        merged_fields = dict(new_entry.get("fields") or {})
        merged_fields.update(fields)
        new_entry["fields"] = merged_fields
    if media is not None:
        new_entry["media"] = list(media)
    if len(new_entry) == 1:
        new_entry = new_date
    attrs["history"].append(new_entry)
    _save(entity_id, attrs)


@service
def lawn_delete_history_entry(task_id=None, date=None):
    """yaml
    name: Lawn - Delete a history entry
    description: Removes a logged completion date from a task's history.
    fields:
      task_id:
        description: Task id
        example: fungicide
      date:
        description: Date to remove, YYYY-MM-DD
        example: "2026-08-08"
    """
    if not task_id or not date:
        return
    entity_id, attrs = _load(task_id)
    attrs["history"] = [e for e in attrs["history"] if _entry_date(e) != date]
    _save(entity_id, attrs)


@service
def lawn_skip_year(task_id=None, year=None):
    """yaml
    name: Lawn - Skip seasonal task for a year
    description: Marks a seasonal lawn task as skipped for a given year.
    fields:
      task_id:
        description: Task id
        example: tenacity
      year:
        description: Calendar year to mark skipped
        example: 2027
    """
    if not task_id or year is None:
        return
    entity_id, attrs = _load(task_id)
    year = int(year)
    if year not in attrs["skipped_years"]:
        attrs["skipped_years"].append(year)
        attrs["skipped_years"].sort()
    _save(entity_id, attrs)


@service
def lawn_unskip_year(task_id=None, year=None):
    """yaml
    name: Lawn - Un-skip seasonal task for a year
    description: Removes a previously set "skip this year" flag from a seasonal lawn task.
    fields:
      task_id:
        description: Task id
        example: tenacity
      year:
        description: Calendar year to un-skip
        example: 2027
    """
    if not task_id or year is None:
        return
    entity_id, attrs = _load(task_id)
    year = int(year)
    if year in attrs["skipped_years"]:
        attrs["skipped_years"].remove(year)
    _save(entity_id, attrs)


@service
def lawn_set_next_due_override(task_id=None, date=None):
    """yaml
    name: Lawn - Override next due date
    description: Manually sets a recurring task's next due date, overriding the automatic last_completed + interval_days calculation.
    fields:
      task_id:
        description: Task id
        example: fungicide
      date:
        description: Next due date, YYYY-MM-DD
        example: "2026-09-01"
    """
    if not task_id or not date:
        return
    entity_id, attrs = _load(task_id)
    attrs["next_due_override"] = date
    _save(entity_id, attrs)


@service
def lawn_clear_next_due_override(task_id=None):
    """yaml
    name: Lawn - Return to automatic schedule
    description: Clears a manual next-due override, returning a task to the automatic last_completed + interval_days calculation.
    fields:
      task_id:
        description: Task id
        example: fungicide
    """
    if not task_id:
        return
    entity_id, attrs = _load(task_id)
    attrs["next_due_override"] = None
    _save(entity_id, attrs)
