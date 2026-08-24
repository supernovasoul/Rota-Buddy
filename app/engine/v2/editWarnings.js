// Advisory-only checks for Phase 7 manual edits - mirrors restWeekNudge.js's
// stance exactly: nothing here ever blocks or excludes anyone, it only
// surfaces something a manager might want to know before confirming a
// swap or shadow assignment. The genuine hard rules (11h rest, the weekly
// cap) still live in restRule.js/weeklyCap.js and are enforced by the
// solver at generation time; a manual override is a deliberate exception
// to that, so it's warned about, never refused.

import { isoWeekday } from '../eligibility.js';
import { effectiveAvailability } from '../../availability.js';
import { restViolations } from './restRule.js';
import { weeklyCapHours, weeklyPaidHours } from './weeklyCap.js';

function addDays(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOnOrBefore(dateIso) {
  return addDays(dateIso, -isoWeekday(dateIso));
}

function inWeek(weekStart, dateIso) {
  return weekStart <= dateIso && dateIso <= addDays(weekStart, 6);
}

// otherShiftsForStaff: [{date, shiftType}] - this person's OTHER currently
// worked shifts (excluding the one being swapped/shadowed onto), already
// resolved to their shiftType config. Kept as a plain input rather than
// this module reaching into shifts[]/assignments[] itself, so it stays a
// pure function the caller assembles from whatever state shape it has.
export function swapWarnings({
  staffId, targetDate, targetShiftType, staffMember,
  otherShiftsForStaff, weeklyHourCapSetting, availability, availabilityPatterns, plannedRestWeeks,
}) {
  const warnings = [];

  if (!effectiveAvailability(staffId, targetDate, availability, availabilityPatterns)) {
    warnings.push(`${staffMember.name} isn't marked available on ${targetDate}.`);
  }

  const weekStart = mondayOnOrBefore(targetDate);
  const onRestWeek = plannedRestWeeks.some((r) => r.staffId === staffId && r.weekStart === weekStart && r.status !== 'cancelled');
  if (onRestWeek) {
    warnings.push(`${staffMember.name} is scheduled for a rest week starting ${weekStart}.`);
  }

  const personShifts = [
    ...otherShiftsForStaff.map((s) => ({ date: s.date, start: s.shiftType.start, end: s.shiftType.end })),
    { date: targetDate, start: targetShiftType.start, end: targetShiftType.end },
  ];
  const violations = restViolations(personShifts).filter((v) => v.before.date === targetDate || v.after.date === targetDate);
  if (violations.length > 0) {
    const gap = Math.min(...violations.map((v) => v.gapHours));
    warnings.push(`Leaves only ${gap.toFixed(1)}h rest around this shift (11h minimum).`);
  }

  const weekShiftTypes = [
    ...otherShiftsForStaff.filter((s) => inWeek(weekStart, s.date)).map((s) => s.shiftType),
    targetShiftType,
  ];
  const capHours = weeklyCapHours(staffMember, weeklyHourCapSetting);
  const projectedHours = weeklyPaidHours(weekShiftTypes);
  if (projectedHours > capHours) {
    warnings.push(`Would bring ${staffMember.name} to ${projectedHours.toFixed(1)}h this week, over their ${capHours}h cap.`);
  }

  return warnings;
}

// Warnings a manager has already acknowledged for this assignment don't
// count again on their own - if swapWarnings would say something
// DIFFERENT now (a warning string that was never dismissed), that's new
// information and surfaces normally, so nothing is silently suppressed
// forever, only the specific thing that was actually checked.
export function undismissedWarnings(warnings, dismissedWarnings = []) {
  return warnings.filter((w) => !dismissedWarnings.includes(w));
}
