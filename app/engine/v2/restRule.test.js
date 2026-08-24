import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restViolations } from './restRule.js';

test('no violation when consecutive shifts have well over 11h gap', () => {
  const shifts = [
    { date: '2026-08-03', start: '10:30', end: '15:30' },
    { date: '2026-08-04', start: '10:30', end: '15:30' }, // gap = 19h
  ];
  assert.deepEqual(restViolations(shifts), []);
});

test('flags a violation when the gap is under 11h', () => {
  const shifts = [
    { date: '2026-08-03', start: '15:15', end: '21:00' }, // late shift ends 21:00
    { date: '2026-08-04', start: '07:00', end: '15:00' }, // next day starts 07:00 - only 10h gap
  ];
  const violations = restViolations(shifts);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].gapHours, 10);
});

test('exactly 11h gap is compliant (boundary is not itself a violation)', () => {
  const shifts = [
    { date: '2026-08-03', start: '10:30', end: '21:00' },
    { date: '2026-08-04', start: '08:00', end: '15:00' }, // gap = 11h exactly
  ];
  assert.deepEqual(restViolations(shifts), []);
});

test('never flags a same-day pair, no matter how close or overlapping (e.g. a split-shift handover)', () => {
  const shifts = [
    { date: '2026-08-03', start: '08:00', end: '14:00' },
    { date: '2026-08-03', start: '15:00', end: '21:00' }, // only 1h gap, same day - not in scope
  ];
  assert.deepEqual(restViolations(shifts), []);
});

test('never flags a same-day pair even when the shift types genuinely overlap (e.g. Morning/Late handover on one person)', () => {
  const shifts = [
    { date: '2026-08-20', start: '10:30', end: '15:30' }, // Morning
    { date: '2026-08-20', start: '15:15', end: '21:00' }, // Late - overlaps Morning's end by 15min
  ];
  assert.deepEqual(restViolations(shifts), []);
});

test('handles unsorted input by checking gaps in chronological order', () => {
  const shifts = [
    { date: '2026-08-05', start: '10:30', end: '15:30' },
    { date: '2026-08-03', start: '10:30', end: '15:30' },
    { date: '2026-08-04', start: '10:30', end: '15:30' },
  ];
  assert.deepEqual(restViolations(shifts), []); // all 19h+ gaps regardless of input order
});

test('multiple violations across a week are all reported, not just the first', () => {
  const shifts = [
    { date: '2026-08-03', start: '15:15', end: '21:00' },
    { date: '2026-08-04', start: '08:00', end: '15:00' }, // 11h gap - fine
    { date: '2026-08-05', start: '00:00', end: '05:00' }, // 9h gap - violation
  ];
  const violations = restViolations(shifts);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].after.date, '2026-08-05');
});
