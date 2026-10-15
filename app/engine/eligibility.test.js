import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekday, datesOfWeek, buildEligibility } from './eligibility.js';

test('isoWeekday: converts JS Sunday=0 to the Python Monday=0 scheme', () => {
  assert.equal(isoWeekday('2026-08-03'), 0); // Monday
  assert.equal(isoWeekday('2026-08-09'), 6); // Sunday
});

test('datesOfWeek: returns exactly 7 consecutive ISO dates starting from weekStart', () => {
  const dates = datesOfWeek('2026-08-03');
  assert.deepEqual(dates, ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09']);
});

function baseFixture(overrides = {}) {
  return {
    staff: [{ id: 1, startDate: '2020-01-01' }],
    availabilityPatterns: [],
    availability: [],
    forcedOff: [],
    plannedRestWeeks: [],
    ...overrides,
  };
}

test('buildEligibility: with no constraints at all, a started staff member is eligible every day', () => {
  const eligibility = buildEligibility(baseFixture());
  assert.equal(eligibility.isEligible(1, '2026-08-03'), true);
});

test('buildEligibility: someone who has not started yet is not eligible, regardless of anything else', () => {
  const eligibility = buildEligibility(baseFixture({ staff: [{ id: 1, startDate: '2027-01-01' }] }));
  assert.equal(eligibility.hasStarted(1, '2026-08-03'), false);
  assert.equal(eligibility.isEligible(1, '2026-08-03'), false);
});

test('buildEligibility: a planned rest week makes every date in that week ineligible, but not the days before or after', () => {
  const fixture = baseFixture({
    plannedRestWeeks: [{ id: 'r1', staffId: 1, weekStart: '2026-08-03', status: 'planned', note: '' }],
  });
  const eligibility = buildEligibility(fixture);
  for (const date of datesOfWeek('2026-08-03')) {
    assert.equal(eligibility.isOnPlannedRestWeek(1, date), true, `${date} should be excluded`);
    assert.equal(eligibility.isEligible(1, date), false, `${date} should be ineligible`);
  }
  assert.equal(eligibility.isOnPlannedRestWeek(1, '2026-08-02'), false, 'the day before the rest week should be unaffected');
  assert.equal(eligibility.isOnPlannedRestWeek(1, '2026-08-10'), false, 'the day after the rest week should be unaffected');
});

test('buildEligibility: a cancelled rest week excludes nobody - it was explicitly reversed', () => {
  const fixture = baseFixture({
    plannedRestWeeks: [{ id: 'r1', staffId: 1, weekStart: '2026-08-03', status: 'cancelled', note: 'manager reversed it' }],
  });
  const eligibility = buildEligibility(fixture);
  for (const date of datesOfWeek('2026-08-03')) {
    assert.equal(eligibility.isEligible(1, date), true, `${date} should still be eligible since the rest week was cancelled`);
  }
});

test('buildEligibility: a "taken" rest week (already happened) still excludes those dates, same as "planned"', () => {
  const fixture = baseFixture({
    plannedRestWeeks: [{ id: 'r1', staffId: 1, weekStart: '2026-08-03', status: 'taken', note: '' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isEligible(1, '2026-08-05'), false);
});

test('buildEligibility: a rest week for one person never affects a different person', () => {
  const fixture = baseFixture({
    staff: [{ id: 1, startDate: '2020-01-01' }, { id: 2, startDate: '2020-01-01' }],
    plannedRestWeeks: [{ id: 'r1', staffId: 1, weekStart: '2026-08-03', status: 'planned', note: '' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isEligible(1, '2026-08-04'), false);
  assert.equal(eligibility.isEligible(2, '2026-08-04'), true);
});

test('buildEligibility: rest-week exclusion combines with (does not override) other eligibility rules', () => {
  // forced off for an unrelated reason too - either one alone should already block it
  const fixture = baseFixture({
    forcedOff: [1],
    plannedRestWeeks: [{ id: 'r1', staffId: 1, weekStart: '2026-08-03', status: 'planned', note: '' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isEligible(1, '2026-08-04'), false);
  // and outside the rest week, forcedOff alone still blocks it
  assert.equal(eligibility.isEligible(1, '2026-08-11'), false);
});

test('buildEligibility: a pattern excluding a day of week makes that day unavailable by default', () => {
  const fixture = baseFixture({
    availabilityPatterns: [{ staffId: 1, dayOfWeek: 5, available: true }, { staffId: 1, dayOfWeek: 6, available: true }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-05'), false); // Wednesday - not in the pattern
  assert.equal(eligibility.isAvailable(1, '2026-08-08'), true); // Saturday - in the pattern
});

test('buildEligibility: a one-off "available" override wins over a pattern that would otherwise exclude that date', () => {
  const fixture = baseFixture({
    availabilityPatterns: [{ staffId: 1, dayOfWeek: 5, available: true }, { staffId: 1, dayOfWeek: 6, available: true }], // weekends only
    availability: [{ id: 'a1', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'available', note: 'picking up an extra day this month' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-05'), true, 'the explicit override should beat the weekends-only pattern');
  assert.equal(eligibility.isAvailable(1, '2026-08-06'), false, 'an untouched Thursday should still fall back to the pattern');
});

test('buildEligibility: a one-off "unavailable" override wins over a pattern that would otherwise include that date', () => {
  const fixture = baseFixture({
    availability: [{ id: 'a1', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'unavailable', note: 'dentist appointment' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-05'), false);
  assert.equal(eligibility.isAvailable(1, '2026-08-06'), true, 'an untouched day should be unaffected');
});

test('buildEligibility: a holiday/sick range covers every date in the range, not just the endpoints', () => {
  const fixture = baseFixture({
    availability: [{ id: 'a1', staffId: 1, dateFrom: '2026-08-10', dateTo: '2026-08-14', type: 'holiday', note: '' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-10'), false);
  assert.equal(eligibility.isAvailable(1, '2026-08-12'), false);
  assert.equal(eligibility.isAvailable(1, '2026-08-14'), false);
  assert.equal(eligibility.isAvailable(1, '2026-08-15'), true);
});

test('buildEligibility: overrides for one person never affect a different person\'s availability', () => {
  const fixture = baseFixture({
    staff: [{ id: 1, startDate: '2020-01-01' }, { id: 2, startDate: '2020-01-01' }],
    availability: [{ id: 'a1', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'unavailable', note: '' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-05'), false);
  assert.equal(eligibility.isAvailable(2, '2026-08-05'), true);
});

// --- Reception's slotted pattern (early/later/full) ---

test('buildEligibility: a receptionist with a slotted pattern is only available for the exact slot they ticked', () => {
  const fixture = baseFixture({
    availabilityPatterns: [
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'early', available: true }, // Monday early only
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'later', available: false },
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'full', available: false },
    ],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-03', { slot: 'early' }), true); // Monday
  assert.equal(eligibility.isAvailable(1, '2026-08-03', { slot: 'later' }), false);
  assert.equal(eligibility.isAvailable(1, '2026-08-03', { slot: 'full' }), false);
});

test('buildEligibility: with no shiftType given, a slotted receptionist rolls up to "available in any slot that day"', () => {
  const fixture = baseFixture({
    availabilityPatterns: [
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'early', available: false },
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'later', available: true },
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'full', available: false },
      { staffId: 1, dayOfWeek: 1, shiftSlot: 'early', available: false },
      { staffId: 1, dayOfWeek: 1, shiftSlot: 'later', available: false },
      { staffId: 1, dayOfWeek: 1, shiftSlot: 'full', available: false },
    ],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-03'), true); // Monday - later is ticked
  assert.equal(eligibility.isAvailable(1, '2026-08-04'), false); // Tuesday - nothing ticked
});

test('buildEligibility: a day-level override still wins over a receptionist\'s slotted pattern, for any slot', () => {
  const fixture = baseFixture({
    availabilityPatterns: [{ staffId: 1, dayOfWeek: 0, shiftSlot: 'early', available: false }],
    availability: [{ staffId: 1, dateFrom: '2026-08-03', dateTo: '2026-08-03', type: 'available' }],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-03', { slot: 'early' }), true, 'the override beats the unticked slot');
});

test('buildEligibility: a therapist\'s day-level pattern is unaffected by a shiftType with no .slot', () => {
  const fixture = baseFixture({
    availabilityPatterns: [{ staffId: 1, dayOfWeek: 5, available: true }], // weekends-only therapist
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isAvailable(1, '2026-08-05', { start: '11:00', end: '18:00' }), false); // Wednesday, no .slot on the shiftType
  assert.equal(eligibility.isAvailable(1, '2026-08-08', { start: '11:00', end: '18:00' }), true); // Saturday
});

test('isEligible: threads the shiftType through to the slot-aware availability check', () => {
  const fixture = baseFixture({
    availabilityPatterns: [
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'early', available: false },
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'later', available: true },
    ],
  });
  const eligibility = buildEligibility(fixture);
  assert.equal(eligibility.isEligible(1, '2026-08-03', { slot: 'early' }), false);
  assert.equal(eligibility.isEligible(1, '2026-08-03'), true, 'without a shiftType it rolls up, and later is ticked');
});

test('buildEligibility: a one-off override with shiftSlots only allows those slots that day', () => {
  const eligibility = buildEligibility({
    staff: [{ id: 1, startDate: '2020-01-01' }],
    availability: [{ id: 'a', staffId: 1, dateFrom: '2026-08-07', dateTo: '2026-08-07', type: 'available', shiftSlots: ['early'] }],
  });
  assert.equal(eligibility.isAvailable(1, '2026-08-07', { slot: 'early' }), true);
  assert.equal(eligibility.isAvailable(1, '2026-08-07', { slot: 'later' }), false);
  assert.equal(eligibility.isAvailable(1, '2026-08-07', { slot: 'full' }), false);
  assert.equal(eligibility.isAvailable(1, '2026-08-07'), true, 'no shiftType - day-level rollup is still "available"');
  assert.equal(eligibility.isAvailable(1, '2026-08-07', { name: 'Therapist 11-6' }), true, 'shift type with no slot is unaffected');
});
