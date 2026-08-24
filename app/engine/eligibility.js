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
  const patterns = new Map(); // staffId -> Set(dayOfWeek) they're available, only present if constrained
  for (const row of fixture.availabilityPatterns ?? []) {
    if (!patterns.has(row.staffId)) patterns.set(row.staffId, new Set());
    if (row.available) patterns.get(row.staffId).add(row.dayOfWeek);
  }

  const overrides = new Map(); // staffId -> [{from, to, available}]
  for (const row of fixture.availability ?? []) {
    if (!overrides.has(row.staffId)) overrides.set(row.staffId, []);
    overrides.get(row.staffId).push({ from: row.dateFrom, to: row.dateTo, available: row.type === 'available' });
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

  function isAvailable(staffId, dateIso) {
    // an explicit override for this date - either direction - always
    // wins over the recurring pattern; the pattern is only consulted
    // when nothing was explicitly painted for this specific date.
    for (const { from, to, available } of overrides.get(staffId) ?? []) {
      if (from <= dateIso && dateIso <= to) return available;
    }
    const dow = isoWeekday(dateIso);
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

  function isEligible(staffId, dateIso) {
    return hasStarted(staffId, dateIso) && isAvailable(staffId, dateIso) && !isForcedOff(staffId) && !isOnPlannedRestWeek(staffId, dateIso);
  }

  return { isAvailable, hasStarted, isForcedOff, isOnPlannedRestWeek, isEligible };
}
