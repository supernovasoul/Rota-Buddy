import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastHoursForDate, setForecastHours, applyWeekdayWeekendDefaults } from './demand.js';

test('forecastHoursForDate: null for a date with no entry at all', () => {
  assert.equal(forecastHoursForDate([], '2026-08-05'), null);
});

test('forecastHoursForDate: returns the stored forecast for a date that has one', () => {
  const demand = [{ date: '2026-08-05', forecastHours: 20, overrideHours: null }];
  assert.equal(forecastHoursForDate(demand, '2026-08-05'), 20);
});

test('setForecastHours: adding a forecast for a date with no entry yet', () => {
  const result = setForecastHours([], '2026-08-05', 15);
  assert.equal(result.length, 1);
  assert.equal(result[0].forecastHours, 15);
  assert.equal(result[0].overrideHours, null);
});

test('setForecastHours: updating an existing date replaces the forecast but preserves any existing override', () => {
  const existing = [{ date: '2026-08-05', forecastHours: 15, overrideHours: 25 }];
  const result = setForecastHours(existing, '2026-08-05', 20);
  assert.equal(result.length, 1);
  assert.equal(result[0].forecastHours, 20);
  assert.equal(result[0].overrideHours, 25, 'a pre-existing override should survive a forecast-only edit');
});

test('setForecastHours: passing null removes the entry entirely rather than leaving a stale zero', () => {
  const existing = [{ date: '2026-08-05', forecastHours: 15, overrideHours: null }];
  const result = setForecastHours(existing, '2026-08-05', null);
  assert.deepEqual(result, []);
});

test('setForecastHours: never touches a different date\'s entry', () => {
  const existing = [{ date: '2026-08-06', forecastHours: 10, overrideHours: null }];
  const result = setForecastHours(existing, '2026-08-05', 20);
  assert.equal(result.length, 2);
});

test('applyWeekdayWeekendDefaults: fills each date with the weekday or weekend value as appropriate', () => {
  const dates = ['2026-08-03', '2026-08-08']; // Monday, Saturday
  const isWeekendFn = (d) => d === '2026-08-08';
  const result = applyWeekdayWeekendDefaults([], dates, 20, 30, isWeekendFn);
  assert.equal(result.find((d) => d.date === '2026-08-03').forecastHours, 20);
  assert.equal(result.find((d) => d.date === '2026-08-08').forecastHours, 30);
});

test('applyWeekdayWeekendDefaults: replaces old forecasts for the given dates rather than mixing old and new', () => {
  const dates = ['2026-08-03'];
  const existing = [{ date: '2026-08-03', forecastHours: 99, overrideHours: null }];
  const result = applyWeekdayWeekendDefaults(existing, dates, 20, 30, () => false);
  assert.equal(result.length, 1);
  assert.equal(result[0].forecastHours, 20);
});
