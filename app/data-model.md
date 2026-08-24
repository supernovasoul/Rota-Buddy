# RotaFable v2 — data model (schema v1)

This is the in-browser data shape the app will store (in `localStorage` and in
backup export files — see the persistence phase). It replaces the Python/SQLite
model in `../schema.sql`, carrying forward the concepts that survive the port
and adding the new ones agreed during planning. Everything here is stored as
one JSON object graph — there's no separate database engine in the browser,
just structured data the app reads and writes directly.

Every top-level list below is an array of plain objects. `id` fields are
strings (a random ID generated when the record is created), not
auto-incrementing numbers — that's safer for offline, import/export-driven
data than sequential integers, since two people editing separate copies won't
collide.

## `meta`
```
{
  schemaVersion: 1,       // bumped whenever this shape changes; drives migration on import
  appVersion: "..."       // shown in the app UI
}
```

## `staff[]`
```
{
  id, name, role: "receptionist" | "therapist",
  startDate, endDate,              // endDate set = archived (hidden from new rotas, history kept)
  employmentType: "fixed_pattern" | "flex",
  proportionalFraction,            // therapists only — contracted share, e.g. 1.0, 0.5
  weeklyHourCapOverride: {         // null unless the person has opted in AND the manager approved
    approved: true, approvedAt, note,
    capHours: 45,                  // the specific higher ceiling for this person - still a real cap, just above the default
  } | null,
  priorityWeight: 1.0,             // neutral = 1.0; >1 favours them in the fairness entitlement calc
  priorityWeightReason: "" | null, // required whenever priorityWeight != 1.0 — the audit/defensibility rule
  hourlyWageRate: number | null,   // optional, management-only, never in staff-facing/shared outputs
  restWeekPolicyOverride: {        // null = inherit restWeekPolicyDefaults for this person's employmentType
    enabled: true|false,
    minWeeks: 9,                   // "approaching" nudge starts once this many consecutive worked weeks is reached
    maxWeeks: 13,                  // nudge escalates to "overdue" past this many
  } | null,
}
```
Dropped from the old `staff` table: `contracted_hours_min/max` (superseded by
the weekly-cap setting + per-person override) and any notion of
qualifications (qualification/treatment matching is deferred — see the
project memory on deferred rules).

A full GDPR delete removes a staff record entirely and scrubs identifying
fields from historic references; archiving (`endDate` set) is the normal
leaver path and keeps everything intact.

## `availabilityPatterns[]`
```
{ staffId, dayOfWeek: 0-6, available: true|false }
```
Recurring weekly pattern, unchanged from the old model.

## `availability[]`
```
{ id, staffId, dateFrom, dateTo, type: "holiday"|"sick"|"unavailable"|"available", note }
```
One-off exceptions to the recurring `availabilityPatterns[]` default — and
genuinely two-way, confirmed 2026-07-22 when building the Phase 5
availability grid: `holiday`/`sick`/`unavailable` take a date away even if
the pattern would otherwise include it; `available` hands a date back even
if the pattern would otherwise exclude it (e.g. a weekends-only person
picking up one extra Wednesday this month). An explicit entry for a date
always wins over the pattern — the pattern is only the starting template a
month's grid is pre-filled from, never a ceiling nothing can override. The
old `preference_off`/`preference_on` types are **dropped** — availability
itself is the preference signal for this user's flex-only staff, so
there's no separate soft-preference layer.

## `openingHours`
```
{
  defaultWeekday: { start: "10:30", end: "21:00" },
  defaultWeekend: { start: "08:30", end: "18:00" },
  overrides: [
    { date, start, end, closed: false, isSpecialDay: true, note }
    // e.g. a bank holiday open 11:00-16:00, or closed: true for a full closure
  ]
}
```
This is what drives the reception coverage hard rule (Phase 2): staff must
cover the *effective* open span for a given date — the override if one
exists for that date, otherwise the default. Editable at any time, including
while entering a specific month's data.

## `shiftTypeSets[]`
```
{
  id, effectiveFrom, effectiveTo,   // which month(s)/period this shape applies to
  receptionShiftTypes: [
    { id, name: "Morning", start: "10:30", end: "15:30", breakMinutes: 0 },
    { id, name: "Late", start: "15:15", end: "21:00", breakMinutes: 30 },
    { id, name: "Whole day", start: "10:30", end: "21:00", breakMinutes: 60 },
    { id, name: "Weekend full day", start: "08:30", end: "18:00", breakMinutes: 60 }
  ],
  therapistShiftTypes: [
    { id, name: "Weekday", start: "11:00", end: "20:00", breakMinutes: 60 },
    { id, name: "Weekend", start: "09:00", end: "17:00", breakMinutes: 30 }
  ]
}
```
`start`/`end` are wall-clock — they drive the reception coverage combination
search and the 11h rest-between-shifts gap, both genuinely about clock time.
`breakMinutes` is a separate, independently editable field per shift type
(0 for a short shift, 60 for a long one, different again on weekends — it's
just a value on whichever type entry it belongs to, no separate
weekday/weekend or role axis needed since those are already distinct type
entries). Paid hours — what the fairness engine and the weekly hour cap
both actually need, never wall-clock span — is derived as
`(end - start) - breakMinutes/60`, computed once in `shiftTypeSpanHours`/
`shiftTypePaidHours` (app/engine/v2/shiftTypes.js) so nothing downstream
recomputes it differently. Deliberately overlapping shift types (e.g. a
15-minute reception handover) are valid and expected — coverage only
rejects gaps, never overlaps — and each person is paid their own shift
type's full paid hours independently, so an overlap is never split or
netted between the two people covering it. Which combination runs on a
given day (a single whole-day type vs a split pair) is a solver choice,
not fixed here — whole-day is used whenever someone's available and it's
fair to give it to them, a split is the fallback when it isn't, and the
handover overlap only exists on days a split is actually used.

Versioned by effective date range so a one-off bank-holiday shift shape, or a
standard pattern that changes over time, doesn't rewrite history — it just
adds a new set effective from a given date. Reception no longer has a fixed
"early/late" pair — the solver picks whichever combination of these shift
types covers the day's opening hours with no gap.

## `weeklyHourCapSetting`
```
{ defaultCapHours: 39 }
```

## `restWeekPolicyDefaults`
```
{
  flex:          { enabled: true,  minWeeks: 9, maxWeeks: 13 },  // ~9-13 weeks = "approx. every 3 months"
  fixed_pattern: { enabled: false, minWeeks: null, maxWeeks: null },
}
```
Keyed by `employmentType`, not `role` — receptionists and therapists on a
flex contract get the same default. This is a **business risk-management
practice, not a legal requirement**: continuous, regular-looking rota
patterns for casual/flex workers can contribute to their being treated as
having employee-like status regardless of contract wording, so managers
may choose to interrupt that pattern with a genuine no-shifts week roughly
every quarter. It is deliberately NOT in the same category as the 11-hour
daily rest rule or the WTR 48h weekly average limit (both hard, apply to
everyone, no per-org configuration) — this is a soft, per-org, per-person
configurable setting, off by default for anyone not flex.

`minWeeks`/`maxWeeks` are a window, not a fixed cadence: the "approaching"
nudge appears once someone has worked `minWeeks` consecutive weeks with no
shift-free week; it escalates to "overdue" past `maxWeeks`. This is
advisory only — see `restWeekNudge` in the Phase 2 engine — a manager acts
on it (or not) by adding a `plannedRestWeeks` entry; nothing auto-forces a
week off. A week is a "rest week" only if it's genuinely shift-free —
reduced hours don't count, since the point is breaking the
looks-like-a-regular-schedule pattern, not just lightening the load.
Any naturally-occurring shift-free week (holiday, low demand, whatever the
reason) resets the streak the same as a deliberately planned one — the
nudge only fires for people who've had NO gap at all in the window, so it
never suggests stacking a rest week on top of one that already happened.

Tracked in **weeks**, not calendar months — the whole rota system is
already organised around weekly periods, and "3 months" only maps to 13
weeks approximately (~13.04), so weeks avoids introducing a second,
inconsistent unit. The default is labelled "13 weeks (approx. every 3
months)" wherever it's shown, so the week-count and the everyday
description stay visibly connected.

## `rotaPeriods[]`
```
{ id, startDate, endDate, status: "draft"|"published"|"closed", closedAt, closedBy }
```
Ledger banking happens only at `closed`, not `published` — see the
ledger-close-rule project memory.

## `shifts[]`
```
{
  id, periodId, date, shiftTypeId, roleRequired: "receptionist"|"therapist",
  isShadowSlot: false, shadowOfShiftId: null   // shadow/training slot, additive, not counted in demand/coverage
}
```
No more `is_early`/`is_late`/`is_bank_holiday` flags — coverage and
special-day status are derived from `openingHours` for that date, not stored
per-shift.

## `assignments[]`
```
{
  id, shiftId, staffId,
  status: "assigned" | "worked" | "cancelled" | "reduced",
  plannedHours, actualHours,      // actualHours is what gets banked to the ledger at close
  changeReason, changedAt         // populated for cancellations/reductions/manual overrides — feeds the audit log
}
```

## `demand[]`
```
{ date, forecastHours, overrideHours }
```
Therapist-only now — reception "demand" is just full coverage of the
effective opening hours, so it doesn't need a separate forecast number.

## `fairnessDimensions[]`
```
{ code, role, description, unit: "hours" }
```
All dimensions become hours-based in v2 (including reception, which used to
be plain shift-count) — necessary now that reception shift lengths vary.
Exactly which hours count toward which reception dimension (e.g. what "early"
means when someone works a whole-day shift) is a Phase 2 solver design
question, not settled at the data-shape level.

## `staffDimensionSettings[]`
```
{ staffId, dimensionId, mode: "participate"|"exempt", note }
```
Unchanged. An exempt person's balance must still be *shown* (per the display
bug fix) — exemption stops accrual, it doesn't hide the number.

## `ledgerEvents[]`
```
{ id, staffId, dimensionId, periodId, entitled, actual, eventType: "period_close"|"adjustment", note, createdAt }
```
Append-only, unchanged shape. Written only when a period is closed, using
final actual hours (including any cancellations/reductions/shadow hours).

## `plannedRestWeeks[]`
```
{ id, staffId, weekStart, status: "planned"|"taken"|"cancelled", note }
```
Unchanged in shape, but its role in the rest-week rule changes: in v1 a
row here was one path (proactive) alongside an automatic reactive
force-off that ran with no manager involvement. In v2 there is no
automatic force-off — `restWeekPolicyDefaults`/`restWeekPolicyOverride`
only ever produce an advisory nudge (see the Phase 2 engine's
`restWeekNudge`), and a row only ever appears here because a manager
acted on one (or scheduled one ahead of time unprompted). This table is
now the *only* mechanism that actually excludes someone from a week's
shifts for rest-week reasons — always a deliberate decision, never
inferred silently.

## `auditLog[]`
```
{ id, timestamp, type: "manual_override"|"cancellation"|"reduction"|"weighting_change", staffId, shiftId, before, after, note }
```
New in v2 — the lightweight audit trail.

## `backupMeta` (written into every export file, not stored in the live app state)
```
{ exportedAt, exportedBy, schemaVersion, includesWageData: true|false }
```
Used for the handover staleness check on import (warn if the incoming file
is older than what's already loaded) and the wage-inclusion toggle for
covering-manager handovers.

## Deliberately dropped from the old schema
- `qualifications` / `staff_qualifications` — qualification/treatment
  matching is a deferred v1 limitation, so there's nothing to track yet.
- `revenue` — unrelated to rota logic; wasn't part of the completion prompt's
  scope, so it's excluded rather than silently carried forward.
- `THER_HIGH_VALUE` fairness dimension — tied to qualification matching,
  deferred with it.
- `availability.type` values `preference_off`/`preference_on` — superseded by
  "availability is the preference," per the decision on unbuilt rules.
