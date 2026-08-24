import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExistingBalanceLookup, closedPeriodHours } from './ledger.js';

test('buildExistingBalanceLookup: no events at all means everyone starts at exactly zero (brand-new user)', () => {
  const existingBalance = buildExistingBalanceLookup([]);
  assert.equal(existingBalance(1, 'REC_HOURS'), 0);
  assert.equal(existingBalance('anyone', 'THER_HOURS'), 0);
});

test('buildExistingBalanceLookup: a single period_close event contributes actual minus entitled', () => {
  const events = [
    { id: 'e1', staffId: 1, dimensionId: 'REC_HOURS', periodId: 'p1', entitled: 20, actual: 25, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
  ];
  const existingBalance = buildExistingBalanceLookup(events);
  assert.equal(existingBalance(1, 'REC_HOURS'), 5); // ahead by 5h
});

test('buildExistingBalanceLookup: multiple events for the same staff/dimension accumulate', () => {
  const events = [
    { id: 'e1', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p1', entitled: 45, actual: 40, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
    { id: 'e2', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p2', entitled: 45, actual: 48, eventType: 'period_close', note: '', createdAt: '2026-01-08' },
  ];
  const existingBalance = buildExistingBalanceLookup(events);
  // -5 then +3 -> net -2 (still 2h behind overall)
  assert.equal(existingBalance(1, 'THER_HOURS'), -2);
});

test('buildExistingBalanceLookup: different staff and different dimensions never leak into each other', () => {
  const events = [
    { id: 'e1', staffId: 1, dimensionId: 'REC_HOURS', periodId: 'p1', entitled: 20, actual: 30, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
    { id: 'e2', staffId: 1, dimensionId: 'REC_WEEKEND', periodId: 'p1', entitled: 8, actual: 8, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
    { id: 'e3', staffId: 2, dimensionId: 'REC_HOURS', periodId: 'p1', entitled: 20, actual: 10, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
  ];
  const existingBalance = buildExistingBalanceLookup(events);
  assert.equal(existingBalance(1, 'REC_HOURS'), 10);
  assert.equal(existingBalance(1, 'REC_WEEKEND'), 0);
  assert.equal(existingBalance(2, 'REC_HOURS'), -10);
  assert.equal(existingBalance(2, 'REC_WEEKEND'), 0, 'a dimension with no events for this person is zero, not undefined or an error');
});

test('buildExistingBalanceLookup: a manual adjustment event contributes the same way as a period_close event', () => {
  const events = [
    { id: 'e1', staffId: 1, dimensionId: 'THER_HOURS', periodId: null, entitled: 0, actual: 6, eventType: 'adjustment', note: 'manual correction for a missed manual override', createdAt: '2026-01-01' },
  ];
  const existingBalance = buildExistingBalanceLookup(events);
  assert.equal(existingBalance(1, 'THER_HOURS'), 6);
});

test('buildExistingBalanceLookup: a new starter joining mid-history starts at zero regardless of how much history other staff already have', () => {
  const events = [
    { id: 'e1', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p1', entitled: 45, actual: 45, eventType: 'period_close', note: '', createdAt: '2020-01-01' },
    { id: 'e2', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p2', entitled: 45, actual: 45, eventType: 'period_close', note: '', createdAt: '2020-01-08' },
    // staff 99 is a brand-new starter with no ledger events at all yet
  ];
  const existingBalance = buildExistingBalanceLookup(events);
  assert.equal(existingBalance(99, 'THER_HOURS'), 0);
});

test('closedPeriodHours: returns actual hours per closed period, ordered oldest to newest regardless of input order', () => {
  const events = [
    { id: 'e2', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p2', entitled: 45, actual: 50, eventType: 'period_close', note: '', createdAt: '2026-01-08' },
    { id: 'e1', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p1', entitled: 45, actual: 40, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
  ];
  assert.deepEqual(closedPeriodHours(events, 1, 'THER_HOURS'), [40, 50]);
});

test('closedPeriodHours: excludes adjustment events - only a genuine period_close counts as a week actually worked', () => {
  const events = [
    { id: 'e1', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p1', entitled: 45, actual: 40, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
    { id: 'e2', staffId: 1, dimensionId: 'THER_HOURS', periodId: null, entitled: 0, actual: 100, eventType: 'adjustment', note: 'unrelated correction', createdAt: '2026-01-02' },
  ];
  assert.deepEqual(closedPeriodHours(events, 1, 'THER_HOURS'), [40]);
});

test('closedPeriodHours: never mixes a different staff member\'s or dimension\'s hours in', () => {
  const events = [
    { id: 'e1', staffId: 1, dimensionId: 'THER_HOURS', periodId: 'p1', entitled: 45, actual: 40, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
    { id: 'e2', staffId: 2, dimensionId: 'THER_HOURS', periodId: 'p1', entitled: 45, actual: 99, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
    { id: 'e3', staffId: 1, dimensionId: 'REC_HOURS', periodId: 'p1', entitled: 45, actual: 99, eventType: 'period_close', note: '', createdAt: '2026-01-01' },
  ];
  assert.deepEqual(closedPeriodHours(events, 1, 'THER_HOURS'), [40]);
});
