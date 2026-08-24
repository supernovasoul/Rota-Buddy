// Generates the plain-text availability-request message (see project
// memory on availability UX) - a short, email-friendly block the
// manager sends to ONE staff member at a time, asking them to reply
// privately in their own words. This is the only "collection" mechanism
// v1 has: it's a message to copy and send, not a live form, and never a
// shared document - each person is asked (and replies) separately, since
// availability is management-only data even at the collection step.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function generateAvailabilityRequestMessage(staffMember, year, month) {
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
  return `Hi ${staffMember.name},

Could you let me know your availability for ${monthLabel}? Just reply with whichever days you can't work (or can, if that's easier) - a quick note back is fine, no form to fill in.

Thanks!`;
}
