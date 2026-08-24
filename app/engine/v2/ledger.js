// Reads the append-only ledgerEvents[] history (see app/data-model.md)
// and produces the existingBalance(staffId, dimensionCode) lookup that
// receptionFairness.js and therapistFairness.js both take as an external
// input - the running total of (actual - entitled) banked at every past
// period close (or manual adjustment), carried forward into this week's
// fairness scoring. A positive balance means someone's been given MORE
// than their fair share historically (ahead); negative means behind.
//
// This is a genuine running total, not a bounded rolling window - unlike
// the separate WTR 48h/17-week average (a different, not-yet-built
// calculation - see the working-time-warning project memory), an
// unresolved fairness imbalance doesn't expire; it keeps nudging future
// entitlement until it's actually worked off.
//
// Cold-start (see the ledger-coldstart project memory) needs no special
// case here: a brand-new user, or a new starter joining mid-history, has
// no matching events, and summing zero events is exactly zero - never
// "owed" catch-up for time before they existed.
//
// `dimensionId` on a ledger event is the fairness dimension's own `code`
// (e.g. 'REC_HOURS', 'THER_HOURS') - fairnessDimensions[] has no separate
// numeric id in the data model, just a code, so this file treats the two
// as the same string throughout.
export function buildExistingBalanceLookup(ledgerEvents) {
  const totals = new Map();
  for (const event of ledgerEvents) {
    const key = `${event.staffId}:${event.dimensionId}`;
    const delta = event.actual - event.entitled;
    totals.set(key, (totals.get(key) ?? 0) + delta);
  }

  return function existingBalance(staffId, dimensionCode) {
    return totals.get(`${staffId}:${dimensionCode}`) ?? 0;
  };
}

// Ordered (oldest -> newest) actual hours per PAST closed period for one
// staff/dimension pair - the raw material the WTR 48h/17-week rolling
// average (wtrWarning.js) needs. Deliberately period_close events only:
// an adjustment entry corrects the fairness ledger's running total (see
// buildExistingBalanceLookup above) but isn't itself a distinct week's
// worth of actually-worked hours, so counting it here could double-count
// or misattribute a period's real hours - period_close is the single,
// unambiguous record of what was actually worked in a given period.
export function closedPeriodHours(ledgerEvents, staffId, dimensionCode) {
  return ledgerEvents
    .filter((e) => e.staffId === staffId && e.dimensionId === dimensionCode && e.eventType === 'period_close')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((e) => e.actual);
}
