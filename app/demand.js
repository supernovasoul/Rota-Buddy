// Pure logic for the Phase 5 therapist demand input (forecastHours per
// date, see app/data-model.md's demand[]) - no DOM here.
//
// Everything this UI writes goes into forecastHours, never
// overrideHours: overrideHours exists in the data model for a manager to
// correct an otherwise-automated forecast, but there's no automated
// forecast source in this app (no booking-system integration) - so
// whatever the manager types here IS the forecast, not a correction to
// one. An existing overrideHours (however it got there) is left alone by
// every function in this file.

export function forecastHoursForDate(demand, dateIso) {
  const entry = demand.find((d) => d.date === dateIso);
  return entry?.forecastHours ?? null;
}

// Setting forecastHours to null removes the entry entirely for that
// date (falls back to zero demand, per therapistFairness.js's
// demandForDay) rather than leaving a stale zero-hours row behind.
export function setForecastHours(demand, dateIso, forecastHours) {
  const existing = demand.find((d) => d.date === dateIso);
  const without = demand.filter((d) => d.date !== dateIso);
  if (forecastHours === null) return without;
  return [...without, { date: dateIso, forecastHours, overrideHours: existing?.overrideHours ?? null }];
}

// Fills every given date with a weekday/weekend default forecast in one
// go - a genuine starting point (like copyOverridesToMonth in
// availability.js), replacing whatever forecastHours those dates
// already had, so re-running it with new numbers doesn't leave a mix of
// old and new values behind.
export function applyWeekdayWeekendDefaults(demand, dates, weekdayHours, weekendHours, isWeekendFn) {
  let result = demand;
  for (const date of dates) {
    const hours = isWeekendFn(date) ? weekendHours : weekdayHours;
    result = setForecastHours(result, date, hours);
  }
  return result;
}
