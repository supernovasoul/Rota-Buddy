// 11-hour rest-between-shifts hard rule: the gap between the end of one
// assigned shift and the start of the next calendar day's shift must be
// at least 11 hours. This is an overnight-rest check only — same-day
// shift pairs (a single Whole day shift, or a Morning+Late split with its
// designed handover overlap) are never in scope, no matter how close or
// overlapping their clock times are, since "rest" isn't a meaningful
// concept within one working day. Confirmed with the manager 2026-08-18
// after the split-shift handover overlap was tripping this as a false
// positive.

const REST_HOURS = 11;

function toDateTimeMinutes(dateIso, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const epochDayMinutes = Date.parse(`${dateIso}T00:00:00Z`) / 60000;
  return epochDayMinutes + h * 60 + m;
}

// personShifts: [{date, start, end}] for ONE person, any order.
// Returns a list of violations (empty = compliant).
export function restViolations(personShifts) {
  const sorted = [...personShifts].sort(
    (a, b) => toDateTimeMinutes(a.date, a.start) - toDateTimeMinutes(b.date, b.start)
  );
  const violations = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].date === sorted[i].date) continue; // same-day pairs are out of scope
    const prevEnd = toDateTimeMinutes(sorted[i - 1].date, sorted[i - 1].end);
    const nextStart = toDateTimeMinutes(sorted[i].date, sorted[i].start);
    const gapHours = (nextStart - prevEnd) / 60;
    if (gapHours < REST_HOURS) {
      violations.push({ before: sorted[i - 1], after: sorted[i], gapHours });
    }
  }
  return violations;
}
