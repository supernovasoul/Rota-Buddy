// Resolves the real v2 configuration surfaces — openingHours and
// shiftTypeSets — for a given date. Nothing in this file, or anywhere
// downstream of it, hardcodes a shift length or a daily hour cap: every
// duration comes from whatever shift types a given spa has configured,
// so a site with longer (or shorter) days works with zero code changes.

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Wall-clock span of a shift type, in hours — start to end, on site. Used
// for opening-hours coverage and the 11h rest-between-shifts gap check,
// both genuinely about clock time. NOT the same as paid hours whenever
// breakMinutes > 0 — use shiftTypePaidHours for anything hour-cap or
// fairness related.
export function shiftTypeSpanHours(shiftType) {
  return (toMinutes(shiftType.end) - toMinutes(shiftType.start)) / 60;
}

// Paid hours = wall-clock span minus this shift type's own unpaid break,
// per app/data-model.md's shiftTypeSets doc. breakMinutes lives on the
// shift type itself (manager-editable, varies freely by type/day/role
// since each is already a distinct entry) — nothing here assumes a
// default break or a particular shift length. This is the number the
// weekly hour cap and the fairness engine must use; shiftTypeSpanHours is
// for coverage/rest-gap purposes only and should never feed either of
// those.
export function shiftTypePaidHours(shiftType) {
  return shiftTypeSpanHours(shiftType) - (shiftType.breakMinutes ?? 0) / 60;
}

export function resolveOpeningHours(openingHours, dateIso, isWeekend) {
  const override = (openingHours.overrides ?? []).find((o) => o.date === dateIso);
  if (override) {
    return { start: override.start, end: override.end, closed: !!override.closed };
  }
  const base = isWeekend ? openingHours.defaultWeekend : openingHours.defaultWeekday;
  return { start: base.start, end: base.end, closed: false };
}

// Multiple shiftTypeSets can exist (versioned by effective date range);
// the one whose range includes this date, with the latest effectiveFrom,
// wins.
export function resolveShiftTypeSet(shiftTypeSets, dateIso) {
  const candidates = shiftTypeSets.filter(
    (set) => set.effectiveFrom <= dateIso && (!set.effectiveTo || dateIso <= set.effectiveTo)
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.effectiveFrom >= b.effectiveFrom ? a : b));
}
