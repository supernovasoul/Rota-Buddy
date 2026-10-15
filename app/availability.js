// Pure logic for the Phase 5 availability grid - no DOM here, unit
// tested the same way staff.js/scheduleSettings.js are.

import { isoWeekday } from './engine/eligibility.js';

export function datesInMonth(year, month /* 1-12 */) {
  const dates = [];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day++) {
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return dates;
}

// The previous calendar month, same length rules - used to resolve
// "copy last month" regardless of which month is currently selected.
export function previousMonth(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

// Every day-of-week (0=Mon..6=Sun, matching isoWeekday) this person is
// marked available in their recurring pattern. hasPattern distinguishes
// "never configured" (unconstrained - available every day by default,
// matching app/engine/eligibility.js's buildEligibility) from
// "configured, but every box is currently unchecked" (constrained to
// nothing) - the Settings UI always writes all 7 days once a person's
// been through the pattern editor, so this only stays true for someone
// who's never touched it at all.
export function patternDaysOfWeek(availabilityPatterns, staffId) {
  const days = new Set();
  let hasPattern = false;
  for (const p of availabilityPatterns) {
    if (p.staffId !== staffId || p.shiftSlot) continue; // slotted rows are reception's - see receptionPatternSlots
    hasPattern = true;
    if (p.available) days.add(p.dayOfWeek);
  }
  return { hasPattern, days };
}

// Reception's recurring pattern is shift-slot-aware, not just day-level:
// weekdays (dayOfWeek 0-4) get three independently-checkable slots since
// receptionists split days ('early'/'later'/'full'); weekends (5-6) are
// full-day-only shifts, so there's only ever one slot to check. This
// mirrors whichever of that day's shiftTypeSet.receptionShiftTypes has a
// matching .slot, but is deliberately a fixed, small vocabulary here
// rather than derived from the (editable, renameable) shift type list -
// so the pattern editor stays stable even if shift type names/times change.
export const RECEPTION_WEEKDAY_SLOTS = ['early', 'later', 'full'];
export const RECEPTION_WEEKEND_SLOTS = ['full'];
export function receptionSlotsForDay(dayOfWeek) {
  return dayOfWeek <= 4 ? RECEPTION_WEEKDAY_SLOTS : RECEPTION_WEEKEND_SLOTS;
}

// Every (dayOfWeek, shiftSlot) pair this receptionist is marked available
// in their recurring pattern - the slotted sibling of patternDaysOfWeek.
// hasPattern distinguishes "never configured" (unconstrained - available
// every slot by default) from "configured, everything unchecked".
export function receptionPatternSlots(availabilityPatterns, staffId) {
  const slots = new Set(); // `${dayOfWeek}:${shiftSlot}`
  let hasPattern = false;
  for (const p of availabilityPatterns) {
    if (p.staffId !== staffId || !p.shiftSlot) continue;
    hasPattern = true;
    if (p.available) slots.add(`${p.dayOfWeek}:${p.shiftSlot}`);
  }
  return { hasPattern, slots };
}

// Replaces this receptionist's entire recurring pattern in one go, the
// slotted sibling of setWeeklyPattern - always writes every (dayOfWeek,
// shiftSlot) row explicitly (5 weekdays x 3 slots + 2 weekend days x 1
// slot = 17 rows), same all-or-nothing write as the day-level editor, so
// "never configured" vs "configured, nothing checked" stays unambiguous.
// selections is a Set of `${dayOfWeek}:${shiftSlot}` keys to mark available.
export function setReceptionWeeklyPattern(availabilityPatterns, staffId, selections) {
  const withoutThisPerson = availabilityPatterns.filter((p) => p.staffId !== staffId);
  const fresh = [];
  for (let dow = 0; dow <= 6; dow++) {
    for (const slot of receptionSlotsForDay(dow)) {
      fresh.push({ staffId, dayOfWeek: dow, shiftSlot: slot, available: selections.has(`${dow}:${slot}`) });
    }
  }
  return [...withoutThisPerson, ...fresh];
}

// Replaces this person's entire recurring pattern in one go - the editor
// always sets all 7 days explicitly (see patternDaysOfWeek's note on why
// a partial write would be ambiguous).
export function setWeeklyPattern(availabilityPatterns, staffId, availableDaysOfWeek) {
  const withoutThisPerson = availabilityPatterns.filter((p) => p.staffId !== staffId);
  const fresh = [];
  for (let dow = 0; dow <= 6; dow++) {
    fresh.push({ staffId, dayOfWeek: dow, available: availableDaysOfWeek.has(dow) });
  }
  return [...withoutThisPerson, ...fresh];
}

// Mirrors app/engine/eligibility.js's isAvailable exactly, so what the
// grid shows always matches what the solver will actually see: an
// explicit override for this exact date always wins (either direction),
// otherwise fall back to the recurring pattern.
export function effectiveAvailability(staffId, dateIso, availability, availabilityPatterns) {
  const override = availability.find((a) => a.staffId === staffId && a.dateFrom <= dateIso && dateIso <= a.dateTo);
  if (override) return override.type === 'available';

  const { hasPattern, days } = patternDaysOfWeek(availabilityPatterns, staffId);
  if (hasPattern) return days.has(isoWeekday(dateIso));

  // Reception's slotted pattern has no single day-level flag - the month
  // grid (and anything else asking "available at all today") rolls it up
  // to "available in at least one shift slot that day".
  const { hasPattern: hasSlotPattern, slots } = receptionPatternSlots(availabilityPatterns, staffId);
  if (hasSlotPattern) {
    const dow = isoWeekday(dateIso);
    return receptionSlotsForDay(dow).some((slot) => slots.has(`${dow}:${slot}`));
  }

  return true;
}

// true only if there's a one-off entry covering this exact single date -
// used by the grid to show an explicit-override marker distinct from a
// day that's merely inheriting the pattern's default.
export function hasExplicitOverride(staffId, dateIso, availability) {
  return availability.some((a) => a.staffId === staffId && a.dateFrom <= dateIso && dateIso <= a.dateTo);
}

// Sets (or clears, when type is null) a single-day override, replacing
// any existing single-day override for that exact date. Deliberately
// only ever writes/removes single-day (dateFrom === dateTo) entries -
// the grid paints one day at a time, so multi-day range splitting/
// merging is never needed here.
export function setDayOverride(availability, staffId, dateIso, type, newId) {
  const withoutThisDay = availability.filter((a) => !(a.staffId === staffId && a.dateFrom === dateIso && a.dateTo === dateIso));
  if (type === null) return withoutThisDay;
  return [...withoutThisDay, { id: newId(), staffId, dateFrom: dateIso, dateTo: dateIso, type, note: '' }];
}

// Copies each single-day override from fromDates[i] to toDates[i] for
// every given staff member - a genuine starting point for the new month,
// so any existing override already in the target range is replaced
// outright, not merged. Both date lists must be the same length (same
// number of days) since they're copied index-for-index, day-of-month for
// day-of-month, regardless of what weekday each one falls on.
export function copyOverridesToMonth(availability, staffIds, fromDates, toDates, newId) {
  if (fromDates.length !== toDates.length) {
    throw new Error('copyOverridesToMonth: source and target months must have the same number of days');
  }

  let result = availability;
  for (let i = 0; i < fromDates.length; i++) {
    for (const staffId of staffIds) {
      // sourced from the ORIGINAL availability, never the in-progress
      // result, so an overlapping source/target range (not expected in
      // practice, but not assumed away either) can never read back a
      // value this same loop just wrote.
      const source = availability.find((a) => a.staffId === staffId && a.dateFrom === fromDates[i] && a.dateTo === fromDates[i]);
      result = setDayOverride(result, staffId, toDates[i], source ? source.type : null, newId);
    }
  }
  return result;
}
