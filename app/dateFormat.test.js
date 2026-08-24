import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatDateRange } from './dateFormat.js';

test('formatDate: day-month is the default, spells out the month, includes the year', () => {
  assert.equal(formatDate('2026-08-10'), '10 Aug 2026');
});

test('formatDate: month-day puts the month first and separates the year with a comma', () => {
  assert.equal(formatDate('2026-08-10', 'month-day'), 'Aug 10, 2026');
});

test('formatDate: includeYear:false drops the year in either preference', () => {
  assert.equal(formatDate('2026-08-10', 'day-month', { includeYear: false }), '10 Aug');
  assert.equal(formatDate('2026-08-10', 'month-day', { includeYear: false }), 'Aug 10');
});

test('formatDate: single-digit days and months are not zero-padded', () => {
  assert.equal(formatDate('2026-01-05'), '5 Jan 2026');
});

test('formatDateRange: day-month shows the year once, at the end, with the weekday on both ends by default', () => {
  assert.equal(formatDateRange('2026-08-10', '2026-08-16'), 'Mon 10 Aug – Sun 16 Aug 2026');
});

test('formatDateRange: month-day shows the year once, at the end, with the US comma', () => {
  assert.equal(formatDateRange('2026-08-10', '2026-08-16', 'month-day'), 'Mon Aug 10 – Sun Aug 16, 2026');
});

test('formatDateRange: handles a range spanning two different months correctly', () => {
  assert.equal(formatDateRange('2026-07-27', '2026-08-02'), 'Mon 27 Jul – Sun 2 Aug 2026');
});

test('formatDateRange: includeWeekday:false drops the weekday from both ends', () => {
  assert.equal(formatDateRange('2026-08-10', '2026-08-16', 'day-month', { includeWeekday: false }), '10 Aug – 16 Aug 2026');
});

test('formatDate: includeWeekday:true prefixes the abbreviated weekday', () => {
  assert.equal(formatDate('2026-08-17', 'day-month', { includeWeekday: true }), 'Mon 17 Aug 2026');
  assert.equal(formatDate('2026-08-17', 'day-month', { includeYear: false, includeWeekday: true }), 'Mon 17 Aug');
  assert.equal(formatDate('2026-08-17', 'month-day', { includeWeekday: true }), 'Mon Aug 17, 2026');
});

test('formatDate: weekday abbreviations are correct across the week', () => {
  assert.equal(formatDate('2026-01-05', 'day-month', { includeYear: false, includeWeekday: true }), 'Mon 5 Jan');
});
