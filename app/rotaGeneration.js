// Pure logic for the Phase 6 rota-generation UI - no DOM here.

import { isoWeekday } from './engine/eligibility.js';

function addDays(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOnOrBefore(dateIso) {
  return addDays(dateIso, -isoWeekday(dateIso));
}

// Every Monday whose week overlaps the given calendar month (1-12) -
// typically 4, occasionally 5, rarely 6. A week straddling the month
// boundary is generated in full rather than split at the exact
// boundary: the weekly hour cap and rest-between-shifts rules are
// inherently Mon-Sun concepts, so a partial week would compute them
// against the wrong window.
export function weekStartsForMonth(year, month) {
  const firstOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  const firstMonday = mondayOnOrBefore(firstOfMonth);
  const lastMonday = mondayOnOrBefore(lastOfMonth);

  const starts = [];
  let current = firstMonday;
  while (current <= lastMonday) {
    starts.push(current);
    current = addDays(current, 7);
  }
  return starts;
}

// A single, honest one-line summary of a generated batch (see project
// memory on the post-generation summary + single easter egg): shift
// count, whether reception coverage is fully complete, and how tightly
// balanced fairness ended up. cleanThresholdHours is how close to zero
// every dimension's final deviation must be, across every staff member,
// for the celebratory flourish - deliberately the ONLY easter egg in the
// app.
export function summarizeGeneration(weeks, staff, finalBalance, cleanThresholdHours = 1) {
  let shiftsAllocated = 0;
  let unfilledDays = 0;
  for (const week of weeks) {
    for (const day of week.reception.days) {
      shiftsAllocated += day.assignment.length;
      if (day.unfilled) unfilledDays++;
    }
    for (const day of week.therapist.days) {
      shiftsAllocated += day.assignment.length;
    }
  }

  const dimensionsByRole = { receptionist: ['REC_HOURS', 'REC_WEEKEND'], therapist: ['THER_HOURS'] };
  let maxAbsDeviation = 0;
  for (const s of staff) {
    for (const dim of dimensionsByRole[s.role] ?? []) {
      maxAbsDeviation = Math.max(maxAbsDeviation, Math.abs(finalBalance(s.id, dim)));
    }
  }

  const coverageComplete = unfilledDays === 0;
  const wellBalanced = maxAbsDeviation <= cleanThresholdHours;

  let line = `${shiftsAllocated} shifts allocated across ${weeks.length} week${weeks.length === 1 ? '' : 's'}. `;
  line += coverageComplete ? 'Reception coverage is complete. ' : `${unfilledDays} day${unfilledDays === 1 ? '' : 's'} could not be covered - see the warnings below. `;
  line += `Fairness spread: ${maxAbsDeviation.toFixed(1)}h at the widest.`;
  if (coverageComplete && wellBalanced) line += ' Nicely balanced! ✨';

  return { line, shiftsAllocated, unfilledDays, coverageComplete, maxAbsDeviation, wellBalanced };
}
