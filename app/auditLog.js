// Pure logic for the Phase 7 audit trail (see app/data-model.md's
// auditLog[] and the audit-trail project memory) - no DOM here, same
// convention as every other state-mutating module in this app.

export function appendAuditLog(auditLog, newId, timestamp, { type, staffId, shiftId, before, after, note }) {
  const entry = {
    id: newId(),
    timestamp,
    type,
    staffId,
    shiftId,
    before: before ?? null,
    after: after ?? null,
    note: note ?? '',
  };
  return [...auditLog, entry];
}

// Newest-first, for display - never mutates the input.
export function sortedAuditLogDesc(auditLog) {
  return [...auditLog].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}
