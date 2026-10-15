// Eligibility helpers - WHO could possibly work a given shift (a
// structural fact, independent of which engine then chooses among the
// eligible pool).
//
// availability[] (see app/data-model.md) is a genuine two-way override
// on a specific date range, not just a way to take days away from the
// recurring weekly pattern: type 'available' marks someone available
// even on a date their pattern would otherwise exclude (e.g. a
// weekends-only person picking up an extra Wednesday this month);
// 'holiday'/'sick'/'unavailable' mark them unavailable even on a date
// the pattern would otherwise include. Confirmed 2026-07-22 while
// building the Phase 5 availability grid - the grid needs to be the
// real source of truth for whatever month a manager has painted, with
// the recurring pattern only as the starting template, not a ceiling
// nothing can override.

export function isoWeekday(dateIso) {
  // JS Date.getUTCDay(): 0=Sunday..6=Saturday.
  // Python date.weekday(): 0=Monday..6=Sunday. Convert to the Python scheme
  // so day-of-week comparisons against availabilityPatterns line up exactly.
  const jsDay = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return (jsDay + 6) % 7;
}

export function datesOfWeek(weekStartIso) {
  const start = new Date(`${weekStartIso}T00:00:00Z`);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export function buildEligibility(fixture) {
  // Two parallel pattern shapes share availabilityPatterns[] (see
  // app/data-model.md): day-level rows (no shiftSlot - therapists, and
  // any receptionist not yet re-saved through the slotted pattern
  // editor) and reception's slotted rows (shiftSlot: 'early'|'later'|
  // 'full'). Each staffId is configured in at most one shape at a time -
  // whichever pattern editor last wrote their rows - so a plain
  // "which map has an entry for this person" check is enough to tell
  // them apart, same "only present if constrained" convention as before.
  const patterns = new Map(); // staffId -> Set(dayOfWeek) they're available
  const slotPatterns = new Map(); // staffId -> Set(`${dayOfWeek}:${shiftSlot}`) they're available
  for (const row of fixture.availabilityPatterns ?? []) {
    if (row.shiftSlot) {
      if (!slotPatterns.has(row.staffId)) slotPatterns.set(row.staffId, new Set());
      if (row.available) slotPatterns.get(row.staffId).add(`${row.dayOfWeek}:${row.shiftSlot}`);
    } else {
      if (!patterns.has(row.staffId)) patterns.set(row.staffId, new Set());
      if (row.available) patterns.get(row.staffId).add(row.dayOfWeek);
    }
  }

  const overrides = new Map(); // staffId -> [{from, to, available}]
  for (const row of fixture.availability ?? []) {
    if (!overrides.has(row.staffId)) overrides.set(row.staffId, []);
    // shiftSlots (optional, 'available' rows only) narrows a one-off
    // date to specific reception slots - e.g. "7 Aug early only" from a
    // pasted availability message. Absent/empty means any slot.
    // offeredShiftTypeIds (optional) lists "only if offered" shift types
    // (see app/data-model.md) this person explicitly offered that date.
    overrides.get(row.staffId).push({
      from: row.dateFrom, to: row.dateTo, available: row.type === 'available',
      shiftSlots: row.shiftSlots ?? null, offeredShiftTypeIds: row.offeredShiftTypeIds ?? null,
    });
  }

  const startDates = new Map(fixture.staff.map((s) => [s.id, s.startDate]));
  const forcedOff = new Set(fixture.forcedOff ?? []);

  // plannedRestWeeks (see app/data-model.md) is the ONLY mechanism that
  // actually excludes someone from a week's shifts for rest-week reasons
  // - always a deliberate manager decision, never inferred from the
  // advisory nudge (restWeekNudge.js) automatically. 'cancelled' rows are
  // explicitly reversed and exclude nobody; 'planned' and 'taken' both
  // represent a genuine rest week (forward-looking or already-happened)
  // and exclude every date in that week.
  const restWeekExclusions = new Set(); // `${staffId}:${dateIso}`
  for (const row of fixture.plannedRestWeeks ?? []) {
    if (row.status === 'cancelled') continue;
    for (const dateIso of datesOfWeek(row.weekStart)) {
      restWeekExclusions.add(`${row.staffId}:${dateIso}`);
    }
  }

  // shiftType is optional - pass the actual shift type being considered
  // (e.g. from a coverage combo) so a receptionist's slotted pattern can
  // be checked against its .slot ('early'|'later'|'full'); omit it for a
  // general "available at all today" question. See app/data-model.md's
  // shiftTypeSets doc for where .slot comes from.
  function isAvailable(staffId, dateIso, shiftType) {
    // an explicit override for this date - either direction - always
    // wins over the recurring pattern; the pattern is only consulted
    // when nothing was explicitly painted for this specific date.
    const override = (overrides.get(staffId) ?? []).find(({ from, to }) => from <= dateIso && dateIso <= to);

    // An "only if offered" shift type (e.g. a 10:30-16:15 early, or a
    // Saturday half day) is never inferred from a pattern or a plain
    // "available" - the person must have named it for this exact date.
    if (shiftType?.onlyIfOffered) {
      return !!(override?.available && override.offeredShiftTypeIds?.includes(shiftType.id));
    }

    if (override) {
      if (!override.available || !shiftType) return override.available;
      const offeredSpecial = override.offeredShiftTypeIds?.length > 0;
      if (override.shiftSlots?.length) return shiftType.slot ? override.shiftSlots.includes(shiftType.slot) : true;
      // offered only special shifts that day - no standard ones
      if (offeredSpecial && shiftType.slot) return false;
      return true;
    }
    const dow = isoWeekday(dateIso);

    const slotPat = slotPatterns.get(staffId);
    if (slotPat) {
      if (shiftType?.slot) return slotPat.has(`${dow}:${shiftType.slot}`);
      // no specific shift type given - roll up to "available in at
      // least one slot today" (used by fairness's eligible-pool checks
      // and other day-level-only callers).
      for (const key of slotPat) {
        if (key.startsWith(`${dow}:`)) return true;
      }
      return false;
    }

    const pat = patterns.get(staffId);
    if (pat && !pat.has(dow)) return false;
    return true;
  }

  function hasStarted(staffId, dateIso) {
    return startDates.get(staffId) <= dateIso;
  }

  function isForcedOff(staffId) {
    return forcedOff.has(staffId);
  }

  function isOnPlannedRestWeek(staffId, dateIso) {
    return restWeekExclusions.has(`${staffId}:${dateIso}`);
  }

  function isEligible(staffId, dateIso, shiftType) {
    return hasStarted(staffId, dateIso) && isAvailable(staffId, dateIso, shiftType) && !isForcedOff(staffId) && !isOnPlannedRestWeek(staffId, dateIso);
  }

  return { isAvailable, hasStarted, isForcedOff, isOnPlannedRestWeek, isEligible };
}
