// Generic hard-rule feasibility and combinatorial assignment - role
// agnostic (used for both reception and therapist scheduling). "combo"
// here just means "a list of shift-type instances that need DISTINCT
// people today" - for reception that's a coverage combination, for
// therapists it's however many copies of one shift type are needed to
// approach that day's demand. Neither concept is baked in here.

import { shiftTypePaidHours } from './shiftTypes.js';
import { restViolations } from './restRule.js';
import { weeklyCapHours } from './weeklyCap.js';

// personWeekState: { assignedShifts: [{date, start, end}], paidHoursSoFar }
// - this person's shifts already placed earlier in the same week's solve,
// used to check the NEW shift against their existing rest gaps and cap.
export function canAssign(person, shiftType, dateIso, personWeekState, eligibility, weeklyHourCapSetting) {
  if (!eligibility.isEligible(person.id, dateIso)) return false;

  const wouldBeShifts = [
    ...personWeekState.assignedShifts,
    { date: dateIso, start: shiftType.start, end: shiftType.end },
  ];
  if (restViolations(wouldBeShifts).length > 0) return false;

  const cap = weeklyCapHours(person, weeklyHourCapSetting);
  const paidHours = shiftTypePaidHours(shiftType);
  if (personWeekState.paidHoursSoFar + paidHours > cap) return false;

  return true;
}

// Every way to staff a combo with DISTINCT, hard-rule-compliant people -
// one person per shift-type instance. Combos are small and candidate
// pools are small, so this enumerates every valid full assignment rather
// than picking one - the caller scores and picks among them. An empty
// result means this combo genuinely can't be staffed today given who's
// eligible, rested, and under-cap - a real gap to report, not an error.
export function feasibleAssignmentsForCombo(combo, dateIso, staff, weekStateByStaffId, eligibility, weeklyHourCapSetting) {
  function assign(remaining, usedIds, current) {
    if (remaining.length === 0) return [current];
    const [shiftType, ...rest] = remaining;
    const results = [];
    for (const person of staff) {
      if (usedIds.has(person.id)) continue;
      const state = weekStateByStaffId[person.id] ?? { assignedShifts: [], paidHoursSoFar: 0 };
      if (!canAssign(person, shiftType, dateIso, state, eligibility, weeklyHourCapSetting)) continue;
      const nextUsed = new Set(usedIds);
      nextUsed.add(person.id);
      results.push(...assign(rest, nextUsed, [...current, { shiftType, staffId: person.id }]));
    }
    return results;
  }
  return assign(combo, new Set(), []);
}
