// The live app state: what's kept in localStorage between visits (see
// app/data-model.md for the full shape). Phase 8 adds the real backup
// story (file export/import, staleness checks) - for now this is just
// enough to not lose work across a page refresh while building the rest
// of the app out.

const STORAGE_KEY = 'rotabuddy_state';
export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.1.0-dev';

export function emptyState() {
  return {
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION },
    staff: [],
    availabilityPatterns: [],
    availability: [],
    openingHours: {
      defaultWeekday: { start: '10:30', end: '21:00' },
      defaultWeekend: { start: '08:30', end: '18:00' },
      overrides: [],
    },
    shiftTypeSets: [],
    weeklyHourCapSetting: { defaultCapHours: 39 },
    dateFormatPreference: 'day-month', // 'day-month' (10 Aug 2026) or 'month-day' (Aug 10, 2026)
    restWeekPolicyDefaults: {
      flex: { enabled: true, minWeeks: 9, maxWeeks: 13 },
      fixed_pattern: { enabled: false, minWeeks: null, maxWeeks: null },
    },
    rotaPeriods: [],
    shifts: [],
    assignments: [],
    demand: [],
    fairnessDimensions: [],
    staffDimensionSettings: [],
    ledgerEvents: [],
    plannedRestWeeks: [],
    auditLog: [],
  };
}

export function loadState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return emptyState();
  }
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed }; // fills in any keys missing from an older save
  } catch (e) {
    console.error('Saved Rota Buddy data could not be read - starting fresh instead of guessing.', e);
    return emptyState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function newId() {
  return crypto.randomUUID();
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
