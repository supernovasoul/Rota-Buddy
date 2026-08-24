// Coverage-based reception hard rule: given the shift types available on
// a day and that day's effective opening span, find every combination of
// shift types whose union spans the opening hours with no gap. A brief
// overlap between adjacent types (e.g. a 15-minute handover) is fine —
// only a GAP is disallowed. This replaces the old fixed early/late pair:
// which shift types run on a given day, and how many, is entirely a
// function of shiftTypeSets + openingHours, never hardcoded.
//
// Simplification: each shift type is used at most once per combination
// (one desk covered by one person at a time). This doesn't model needing
// two receptionists on the desk simultaneously — there's nothing in the
// current data model calling for that, so it's not built until it's a
// real requirement.

import { shiftTypePaidHours } from './shiftTypes.js';

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function unionCoversWithNoGap(subset, openStartMin, openEndMin) {
  if (subset.length === 0) return false;
  const sorted = [...subset].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  if (toMinutes(sorted[0].start) > openStartMin) return false;
  let coveredUntil = toMinutes(sorted[0].end);
  for (let i = 1; i < sorted.length; i++) {
    const start = toMinutes(sorted[i].start);
    if (start > coveredUntil) return false; // gap - disallowed
    coveredUntil = Math.max(coveredUntil, toMinutes(sorted[i].end));
  }
  return coveredUntil >= openEndMin;
}

function popcount(mask) {
  let count = 0;
  for (let m = mask; m; m >>= 1) count += m & 1;
  return count;
}

// Returns an array of shift-type arrays; each inner array is one valid
// no-gap combination. Only MINIMAL combinations are returned - if some
// shift type in a covering combo is redundant (the rest already cover
// the span without it, e.g. adding Morning on top of an already-complete
// Weekend full day), that combo is dropped. Scheduling someone nobody
// needs isn't a real scheduling option.
export function findCoveringCombinations(shiftTypes, openStart, openEnd) {
  const openStartMin = toMinutes(openStart);
  const openEndMin = toMinutes(openEnd);
  const n = shiftTypes.length;

  const validMasks = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset = shiftTypes.filter((_, i) => mask & (1 << i));
    if (unionCoversWithNoGap(subset, openStartMin, openEndMin)) {
      validMasks.push(mask);
    }
  }

  validMasks.sort((a, b) => popcount(a) - popcount(b));
  const minimalMasks = [];
  for (const mask of validMasks) {
    const isDominated = minimalMasks.some((m) => (m & mask) === m);
    if (!isDominated) minimalMasks.push(mask);
  }

  return minimalMasks.map((mask) => shiftTypes.filter((_, i) => mask & (1 << i)));
}

// Convenience: combinations using the fewest shift-type instances first
// (a reasonable default preference — fewer people on the desk per day —
// but callers are free to pick differently, e.g. for fairness reasons).
export function coveringCombinationsByHeadcount(shiftTypes, openStart, openEnd) {
  return findCoveringCombinations(shiftTypes, openStart, openEnd).sort((a, b) => a.length - b.length);
}

// Total paid hours across a combination — the sum of each shift type's
// OWN paid hours, independently. During an overlap (e.g. a handover),
// both people's shift types contribute their full paid hours here; the
// overlap is never split or netted between them, since paid hours are a
// per-person property, not a shared pool.
export function combinationPaidHours(combination) {
  return combination.reduce((sum, shiftType) => sum + shiftTypePaidHours(shiftType), 0);
}
