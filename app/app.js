import { loadState, saveState, newId, todayIso, APP_VERSION } from './state.js';
import { buildDemoState } from './demoSeed.js';
import { newStaffDraft, validateStaffDraft, isArchived, archiveStaff, reinstateStaff, deleteStaffGdpr } from './staff.js';
import {
  validateOpeningHoursDefaults, newOverrideDraft, validateOverrideDraft, upsertOverride, removeOverride,
  newShiftTypeDraft, validateShiftTypeDraft, upsertShiftType, removeShiftType, validateWeeklyCapSetting,
} from './scheduleSettings.js';
import { shiftTypePaidHours, resolveShiftTypeSet } from './engine/v2/shiftTypes.js';
import { isoWeekday } from './engine/eligibility.js';
import {
  datesInMonth, previousMonth, patternDaysOfWeek, setWeeklyPattern, effectiveAvailability,
  hasExplicitOverride, setDayOverride, copyOverridesToMonth,
} from './availability.js';
import { forecastHoursForDate, setForecastHours, applyWeekdayWeekendDefaults } from './demand.js';
import { generateAvailabilityRequestMessage } from './availabilityMessage.js';
import { buildEligibility } from './engine/eligibility.js';
import { solveChainedWeeks } from './engine/v2/chainedWeeks.js';
import { weekStartsForMonth, summarizeGeneration } from './rotaGeneration.js';
import { saveChainedWeeksAsDraftPeriods } from './rotaPeriods.js';
import { closePeriod } from './rotaClose.js';
import { sortedAuditLogDesc } from './auditLog.js';
import { newSwapDraft, validateSwapDraft, swapAssignmentStaff, dismissAssignmentWarnings } from './manualEdit.js';
import { swapWarnings, undismissedWarnings } from './engine/v2/editWarnings.js';
import { computeRestWeekNudges } from './engine/v2/restWeekNudge.js';
import { pickCurrentPeriod, periodCoverage, buildRecentWeeks } from './weekSummary.js';
import { formatDate, formatDateRange } from './dateFormat.js';

let state = loadState();
// A completely fresh install (nothing saved yet, e.g. the first visit to a
// deployed demo link) starts from a populated example instead of an empty
// shell - see demoSeed.js. Once seeded it's saved like any other edit, so
// it won't be silently regenerated/overwritten on a later visit.
if (state.staff.length === 0 && state.rotaPeriods.length === 0) {
  state = buildDemoState();
  saveState(state);
}
let editingStaffId = null; // null while adding; set while editing an existing person

// This increment keeps exactly one always-active shift-type set rather
// than the full effective-date-versioned history the data model
// eventually supports (see scheduleSettings.js's scope note) - create it
// once, lazily, if a fresh install has none yet.
if (state.shiftTypeSets.length === 0) {
  state.shiftTypeSets.push({ id: newId(), effectiveFrom: '2020-01-01', effectiveTo: null, receptionShiftTypes: [], therapistShiftTypes: [] });
}
const currentShiftTypeSet = state.shiftTypeSets[0];

let editingOverrideDate = null; // null while adding; set while editing an existing override
let editingShiftType = null; // { id, role } while editing; null while adding
let addingShiftTypeRole = 'receptionist';

const versionLabel = document.getElementById('version-label');

const navButtons = document.querySelectorAll('.nav-btn');
const views = { week: document.getElementById('view-week'), staff: document.getElementById('view-staff'), settings: document.getElementById('view-settings') };

const weekDateRange = document.getElementById('week-date-range');
const statCoverageCard = document.getElementById('stat-coverage-card');
const statCoverageNum = document.getElementById('stat-coverage-num');
const statCoverageSub = document.getElementById('stat-coverage-sub');
const statSecondLookCard = document.getElementById('stat-second-look-card');
const statSecondLookNum = document.getElementById('stat-second-look-num');
const statSecondLookSub = document.getElementById('stat-second-look-sub');
const statRestNudgesCard = document.getElementById('stat-rest-nudges-card');
const statRestNudgesNum = document.getElementById('stat-rest-nudges-num');
const statRestNudgesSub = document.getElementById('stat-rest-nudges-sub');

const tableWrap = document.getElementById('staff-table-wrap');
const showArchivedToggle = document.getElementById('show-archived-toggle');
const showSensitiveToggle = document.getElementById('show-sensitive-toggle');
const addStaffBtn = document.getElementById('add-staff-btn');

const overlay = document.getElementById('form-overlay');
const form = document.getElementById('staff-form');
const formTitle = document.getElementById('form-title');
const formErrors = document.getElementById('form-errors');
const cancelBtn = document.getElementById('form-cancel-btn');

const fName = document.getElementById('f-name');
const fRole = document.getElementById('f-role');
const fEmploymentType = document.getElementById('f-employment-type');
const fStartDate = document.getElementById('f-start-date');
const fEndDate = document.getElementById('f-end-date');
const fFractionField = document.getElementById('f-fraction-field');
const fFraction = document.getElementById('f-fraction');
const fWeight = document.getElementById('f-weight');
const fWeightReasonField = document.getElementById('f-weight-reason-field');
const fWeightReason = document.getElementById('f-weight-reason');
const fCapOverrideEnabled = document.getElementById('f-cap-override-enabled');
const fCapOverrideFields = document.getElementById('f-cap-override-fields');
const fCapOverrideHours = document.getElementById('f-cap-override-hours');
const fCapOverrideNote = document.getElementById('f-cap-override-note');
const fWage = document.getElementById('f-wage');

// Opening hours
const ohWeekdayStart = document.getElementById('oh-weekday-start');
const ohWeekdayEnd = document.getElementById('oh-weekday-end');
const ohWeekendStart = document.getElementById('oh-weekend-start');
const ohWeekendEnd = document.getElementById('oh-weekend-end');
const ohDefaultsErrors = document.getElementById('oh-defaults-errors');
const ohDefaultsSaveBtn = document.getElementById('oh-defaults-save-btn');
const overridesTableWrap = document.getElementById('overrides-table-wrap');
const addOverrideBtn = document.getElementById('add-override-btn');

const overrideOverlay = document.getElementById('override-overlay');
const overrideForm = document.getElementById('override-form');
const overrideFormTitle = document.getElementById('override-form-title');
const overrideFormErrors = document.getElementById('override-form-errors');
const overrideCancelBtn = document.getElementById('override-cancel-btn');
const ovDate = document.getElementById('ov-date');
const ovClosed = document.getElementById('ov-closed');
const ovHoursFields = document.getElementById('ov-hours-fields');
const ovStart = document.getElementById('ov-start');
const ovEnd = document.getElementById('ov-end');
const ovNote = document.getElementById('ov-note');

// Shift types
const receptionShiftTypesWrap = document.getElementById('reception-shift-types-wrap');
const therapistShiftTypesWrap = document.getElementById('therapist-shift-types-wrap');

const shiftTypeOverlay = document.getElementById('shift-type-overlay');
const shiftTypeForm = document.getElementById('shift-type-form');
const shiftTypeFormTitle = document.getElementById('shift-type-form-title');
const shiftTypeFormErrors = document.getElementById('shift-type-form-errors');
const shiftTypeCancelBtn = document.getElementById('shift-type-cancel-btn');
const stName = document.getElementById('st-name');
const stStart = document.getElementById('st-start');
const stEnd = document.getElementById('st-end');
const stBreak = document.getElementById('st-break');

// Scheduling rules
const capHoursInput = document.getElementById('cap-hours');
const capErrors = document.getElementById('cap-errors');
const capSaveBtn = document.getElementById('cap-save-btn');
const dateFormatSelect = document.getElementById('date-format-select');

function fmtDate(dateIso, opts) { return formatDate(dateIso, state.dateFormatPreference, opts); }
function fmtRange(startIso, endIso) { return formatDateRange(startIso, endIso, state.dateFormatPreference); }

// Availability
const patternTableWrap = document.getElementById('pattern-table-wrap');
const gridMonthInput = document.getElementById('grid-month');
const copyLastMonthBtn = document.getElementById('copy-last-month-btn');
const availabilityGridWrap = document.getElementById('availability-grid-wrap');
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let paintValue = null; // true/false while actively dragging a paint stroke; null when not painting

const demandWeekdayDefault = document.getElementById('demand-weekday-default');
const demandWeekendDefault = document.getElementById('demand-weekend-default');
const applyDemandDefaultsBtn = document.getElementById('apply-demand-defaults-btn');
const demandTableWrap = document.getElementById('demand-table-wrap');

const messageOverlay = document.getElementById('message-overlay');
const messageTitle = document.getElementById('message-title');
const messageText = document.getElementById('message-text');
const messageCloseBtn = document.getElementById('message-close-btn');
const messageCopyBtn = document.getElementById('message-copy-btn');

const generateMonthInput = document.getElementById('generate-month');
const generateBtn = document.getElementById('generate-btn');
const saveDraftBtn = document.getElementById('save-draft-btn');
const generateSummary = document.getElementById('generate-summary');
const generateResults = document.getElementById('generate-results');
let lastGeneratedResult = null; // the most recent preview - what "Save as draft" persists

const rotaPeriodsWrap = document.getElementById('rota-periods-wrap');

const periodDetailPanel = document.getElementById('period-detail-panel');
const periodDetailTitle = document.getElementById('period-detail-title');
const periodDetailWrap = document.getElementById('period-detail-wrap');
const periodDetailBackBtn = document.getElementById('period-detail-back-btn');
let openPeriodDetailId = null;
let autoOpenedWeekPeriodId = null; // which period's detail we've already auto-opened, so a deliberate "Back to all periods" click isn't undone by the next persist()

const auditLogWrap = document.getElementById('audit-log-wrap');

const swapOverlay = document.getElementById('swap-overlay');
const swapForm = document.getElementById('swap-form');
const swapFormErrors = document.getElementById('swap-form-errors');
const swapStaffSelect = document.getElementById('swap-staff-select');
const swapWarningsWrap = document.getElementById('swap-warnings');
const swapCancelBtn = document.getElementById('swap-cancel-btn');
let swappingAssignmentId = null;

versionLabel.textContent = `v${APP_VERSION}`;

function persist() {
  saveState(state);
  renderWeekSummary();
}

// --- Sidebar navigation ---

navButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    navButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.entries(views).forEach(([key, el]) => el.classList.toggle('active', key === btn.dataset.view));
  });
});

// --- "This week" summary cards ---

function setStatCard(cardEl, numEl, subEl, tone, num, sub) {
  cardEl.classList.remove('attention', 'good', 'notice');
  if (tone) cardEl.classList.add(tone);
  numEl.textContent = num;
  subEl.textContent = sub;
}

function renderWeekSummary() {
  const period = pickCurrentPeriod(state.rotaPeriods, todayIso());

  if (!period) {
    weekDateRange.textContent = 'This week';
    setStatCard(statCoverageCard, statCoverageNum, statCoverageSub, null, '—', 'No rota generated yet');
    setStatCard(statSecondLookCard, statSecondLookNum, statSecondLookSub, null, '—', '');
    setStatCard(statRestNudgesCard, statRestNudgesNum, statRestNudgesSub, null, '—', '');
    return;
  }

  weekDateRange.textContent = fmtRange(period.startDate, period.endDate);

  const { complete, unfilledCount } = periodCoverage(period, state.shifts, state.assignments);
  if (complete) {
    setStatCard(statCoverageCard, statCoverageNum, statCoverageSub, 'good', 'Complete', 'All reception hours covered');
  } else {
    setStatCard(statCoverageCard, statCoverageNum, statCoverageSub, 'attention', `${unfilledCount} shift${unfilledCount === 1 ? '' : 's'}`, 'Unfilled this week');
  }

  const periodShiftIds = new Set(state.shifts.filter((s) => s.periodId === period.id).map((s) => s.id));
  const flagged = state.assignments
    .filter((a) => periodShiftIds.has(a.shiftId) && a.status !== 'cancelled' && a.staffId)
    .map((a) => assignmentWarnings(a))
    .filter((entry) => entry && entry.warnings.length > 0);

  if (flagged.length === 0) {
    setStatCard(statSecondLookCard, statSecondLookNum, statSecondLookSub, 'good', '0', 'Nothing flagged this week');
  } else {
    const first = flagged[0];
    setStatCard(statSecondLookCard, statSecondLookNum, statSecondLookSub, 'attention', String(flagged.length), `${first.staffMember.name} — ${fmtDate(first.shift.date, { includeYear: false })}`);
  }

  const recentWeeks = buildRecentWeeks(state.rotaPeriods, state.shifts, state.assignments, period);
  const nudges = computeRestWeekNudges(activeStaffSorted(), state.restWeekPolicyDefaults, recentWeeks);
  if (nudges.length === 0) {
    setStatCard(statRestNudgesCard, statRestNudgesNum, statRestNudgesSub, 'good', '0', 'None due');
  } else {
    const overdue = nudges.filter((n) => n.severity === 'overdue').length;
    const approaching = nudges.length - overdue;
    const parts = [];
    if (overdue > 0) parts.push(`${overdue} overdue`);
    if (approaching > 0) parts.push(`${approaching} approaching`);
    setStatCard(statRestNudgesCard, statRestNudgesNum, statRestNudgesSub, 'attention', String(nudges.length), parts.join(', '));
  }

  if (openPeriodDetailId === null && autoOpenedWeekPeriodId !== period.id) {
    autoOpenedWeekPeriodId = period.id;
    periodDetailPanel.hidden = false;
    renderPeriodDetail(period.id);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderStaffTable() {
  const showArchived = showArchivedToggle.checked;
  const showSensitive = showSensitiveToggle.checked;
  const today = todayIso();

  const rows = state.staff
    .filter((s) => showArchived || !isArchived(s, today))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (rows.length === 0) {
    tableWrap.innerHTML = `<p class="empty-state">No staff yet. Click "Add staff" to get started.</p>`;
    return;
  }

  const sensitiveHead = showSensitive ? '<th>Priority weight</th><th>Wage/hr</th>' : '';
  const bodyRows = rows.map((s) => {
    const archived = isArchived(s, today);
    const roleLabel = s.role === 'therapist' ? 'Therapist' : 'Receptionist';
    const employmentLabel = s.employmentType === 'flex' ? 'Flex' : 'Fixed pattern';
    const fraction = s.role === 'therapist' && s.proportionalFraction != null ? s.proportionalFraction : '—';
    const weightCell = s.priorityWeight && s.priorityWeight !== 1.0
      ? `<span class="tag weighted" title="${escapeHtml(s.priorityWeightReason || '')}">${s.priorityWeight}x</span>`
      : '1.0x';
    const wageCell = s.hourlyWageRate != null ? `£${Number(s.hourlyWageRate).toFixed(2)}` : '—';
    const sensitiveCells = showSensitive ? `<td>${weightCell}</td><td>${wageCell}</td>` : '';
    const statusTag = archived ? '<span class="tag">Archived</span>' : '';
    const capOverrideTag = s.weeklyHourCapOverride?.approved
      ? `<span class="tag weighted" title="${escapeHtml(s.weeklyHourCapOverride.note || '')}">${s.weeklyHourCapOverride.capHours}h cap</span>`
      : '';
    const actions = archived
      ? `<button class="link" data-action="reinstate" data-id="${s.id}">Reinstate</button>
         <button class="link danger" data-action="delete" data-id="${s.id}">Delete permanently</button>`
      : `<button class="link" data-action="edit" data-id="${s.id}">Edit</button>
         <button class="link" data-action="archive" data-id="${s.id}">Archive</button>`;

    return `<tr class="${archived ? 'archived' : ''}">
      <td>${escapeHtml(s.name)} ${statusTag}${capOverrideTag}</td>
      <td>${roleLabel}</td>
      <td>${employmentLabel}</td>
      <td>${fraction}</td>
      ${sensitiveCells}
      <td>${actions}</td>
    </tr>`;
  }).join('');

  tableWrap.innerHTML = `<table>
    <thead><tr>
      <th>Name</th><th>Role</th><th>Employment</th><th>Fraction</th>${sensitiveHead}<th>Actions</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;

  tableWrap.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleRowAction(btn.dataset.action, btn.dataset.id));
  });
}

function handleRowAction(action, staffId) {
  const person = state.staff.find((s) => s.id === staffId);
  if (!person) return;

  if (action === 'edit') {
    openForm(person);
  } else if (action === 'archive') {
    if (confirm(`Archive ${person.name}? They'll be hidden from new rotas but their history is kept.`)) {
      state.staff = archiveStaff(state.staff, staffId, todayIso());
      persist();
      renderStaffTable();
      renderPatternTable();
      renderAvailabilityGrid();
    }
  } else if (action === 'reinstate') {
    state.staff = reinstateStaff(state.staff, staffId);
    persist();
    renderStaffTable();
    renderPatternTable();
    renderAvailabilityGrid();
  } else if (action === 'delete') {
    const confirmed = prompt(`This permanently deletes ${person.name}'s record, including from historic references. This cannot be undone.\n\nType the person's name to confirm:`);
    if (confirmed === person.name) {
      state.staff = deleteStaffGdpr(state.staff, staffId);
      persist();
      renderStaffTable();
      renderPatternTable();
      renderAvailabilityGrid();
    }
  }
}

function updateConditionalFields() {
  fFractionField.style.display = fRole.value === 'therapist' ? '' : 'none';
  const weight = Number(fWeight.value);
  fWeightReasonField.style.display = weight !== 1.0 ? '' : 'none';
  fCapOverrideFields.style.display = fCapOverrideEnabled.checked ? '' : 'none';
}

function openForm(person) {
  editingStaffId = person ? person.id : null;
  formTitle.textContent = person ? `Edit ${person.name}` : 'Add staff';
  formErrors.hidden = true;
  formErrors.innerHTML = '';

  const draft = person ?? newStaffDraft(fRole.value || 'receptionist');
  fName.value = draft.name ?? '';
  fRole.value = draft.role ?? 'receptionist';
  fEmploymentType.value = draft.employmentType ?? 'flex';
  fStartDate.value = draft.startDate ?? '';
  fEndDate.value = draft.endDate ?? '';
  fFraction.value = draft.proportionalFraction ?? '';
  fWeight.value = draft.priorityWeight ?? 1.0;
  fWeightReason.value = draft.priorityWeightReason ?? '';
  fCapOverrideEnabled.checked = !!draft.weeklyHourCapOverride?.approved;
  fCapOverrideHours.value = draft.weeklyHourCapOverride?.capHours ?? '';
  fCapOverrideNote.value = draft.weeklyHourCapOverride?.note ?? '';
  fWage.value = draft.hourlyWageRate ?? '';

  updateConditionalFields();
  overlay.hidden = false;
  fName.focus();
}

function closeForm() {
  overlay.hidden = true;
  editingStaffId = null;
  form.reset();
}

function readFormAsDraft() {
  return {
    name: fName.value.trim(),
    role: fRole.value,
    employmentType: fEmploymentType.value,
    startDate: fStartDate.value,
    endDate: fEndDate.value || null,
    proportionalFraction: fRole.value === 'therapist' ? (fFraction.value === '' ? null : Number(fFraction.value)) : null,
    priorityWeight: fWeight.value === '' ? 1.0 : Number(fWeight.value),
    priorityWeightReason: fWeightReason.value.trim() || null,
    weeklyHourCapOverride: fCapOverrideEnabled.checked
      ? {
          approved: true,
          approvedAt: new Date().toISOString(),
          capHours: fCapOverrideHours.value === '' ? null : Number(fCapOverrideHours.value),
          note: fCapOverrideNote.value.trim(),
        }
      : null,
    hourlyWageRate: fWage.value === '' ? null : Number(fWage.value),
  };
}

addStaffBtn.addEventListener('click', () => openForm(null));
cancelBtn.addEventListener('click', closeForm);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeForm(); });
fRole.addEventListener('change', updateConditionalFields);
fWeight.addEventListener('input', updateConditionalFields);
fCapOverrideEnabled.addEventListener('change', updateConditionalFields);
showArchivedToggle.addEventListener('change', renderStaffTable);
showSensitiveToggle.addEventListener('change', renderStaffTable);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const draft = readFormAsDraft();
  const errors = validateStaffDraft(draft);
  if (errors.length > 0) {
    formErrors.hidden = false;
    formErrors.innerHTML = `<strong>Please fix the following:</strong><ul>${errors.map((err) => `<li>${escapeHtml(err)}</li>`).join('')}</ul>`;
    return;
  }

  if (editingStaffId) {
    const existing = state.staff.find((s) => s.id === editingStaffId);
    // Keep the original approval timestamp if this override was already
    // approved with the same terms - approvedAt records when it was FIRST
    // approved, not the last time the staff record happened to be saved.
    const existingOverride = existing.weeklyHourCapOverride;
    if (draft.weeklyHourCapOverride && existingOverride?.approved
        && existingOverride.capHours === draft.weeklyHourCapOverride.capHours
        && existingOverride.note === draft.weeklyHourCapOverride.note) {
      draft.weeklyHourCapOverride = { ...draft.weeklyHourCapOverride, approvedAt: existingOverride.approvedAt };
    }
    state.staff = state.staff.map((s) => (s.id === editingStaffId ? { ...s, ...draft } : s));
  } else {
    state.staff.push({ ...draft, id: newId(), restWeekPolicyOverride: null });
  }
  persist();
  closeForm();
  renderStaffTable();
  renderPatternTable();
  renderAvailabilityGrid();
});

// --- Opening hours: defaults ---

function renderOpeningHoursDefaults() {
  ohWeekdayStart.value = state.openingHours.defaultWeekday.start;
  ohWeekdayEnd.value = state.openingHours.defaultWeekday.end;
  ohWeekendStart.value = state.openingHours.defaultWeekend.start;
  ohWeekendEnd.value = state.openingHours.defaultWeekend.end;
}

ohDefaultsSaveBtn.addEventListener('click', () => {
  const defaultWeekday = { start: ohWeekdayStart.value, end: ohWeekdayEnd.value };
  const defaultWeekend = { start: ohWeekendStart.value, end: ohWeekendEnd.value };
  const errors = validateOpeningHoursDefaults(defaultWeekday, defaultWeekend);
  if (errors.length > 0) {
    ohDefaultsErrors.hidden = false;
    ohDefaultsErrors.innerHTML = `<ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
    return;
  }
  ohDefaultsErrors.hidden = true;
  state.openingHours.defaultWeekday = defaultWeekday;
  state.openingHours.defaultWeekend = defaultWeekend;
  persist();
});

// --- Opening hours: per-date overrides ---

function renderOverridesTable() {
  const overrides = [...state.openingHours.overrides].sort((a, b) => a.date.localeCompare(b.date));
  if (overrides.length === 0) {
    overridesTableWrap.innerHTML = `<p class="empty-state">No date overrides yet.</p>`;
    return;
  }
  const rows = overrides.map((o) => `<tr>
    <td>${o.date}</td>
    <td>${o.closed ? '<span class="tag">Closed</span>' : `${o.start}&ndash;${o.end}`}</td>
    <td>${escapeHtml(o.note || '')}</td>
    <td>
      <button class="link" data-action="edit-override" data-date="${o.date}">Edit</button>
      <button class="link danger" data-action="remove-override" data-date="${o.date}">Remove</button>
    </td>
  </tr>`).join('');
  overridesTableWrap.innerHTML = `<table>
    <thead><tr><th>Date</th><th>Hours</th><th>Note</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  overridesTableWrap.querySelectorAll('button[data-action]').forEach((btn) => {
    const date = btn.dataset.date;
    if (btn.dataset.action === 'edit-override') {
      btn.addEventListener('click', () => openOverrideForm(state.openingHours.overrides.find((o) => o.date === date)));
    } else {
      btn.addEventListener('click', () => {
        if (confirm(`Remove the override for ${date}?`)) {
          state.openingHours.overrides = removeOverride(state.openingHours.overrides, date);
          persist();
          renderOverridesTable();
        }
      });
    }
  });
}

function updateOverrideConditionalFields() {
  ovHoursFields.style.display = ovClosed.checked ? 'none' : '';
}

function openOverrideForm(existing) {
  editingOverrideDate = existing ? existing.date : null;
  overrideFormTitle.textContent = existing ? `Edit override: ${existing.date}` : 'Add override';
  overrideFormErrors.hidden = true;
  overrideFormErrors.innerHTML = '';

  const draft = existing ?? newOverrideDraft();
  ovDate.value = draft.date;
  ovClosed.checked = !!draft.closed;
  ovStart.value = draft.start ?? '';
  ovEnd.value = draft.end ?? '';
  ovNote.value = draft.note ?? '';

  updateOverrideConditionalFields();
  overrideOverlay.hidden = false;
  ovDate.focus();
}

function closeOverrideForm() {
  overrideOverlay.hidden = true;
  editingOverrideDate = null;
  overrideForm.reset();
}

addOverrideBtn.addEventListener('click', () => openOverrideForm(null));
overrideCancelBtn.addEventListener('click', closeOverrideForm);
overrideOverlay.addEventListener('click', (e) => { if (e.target === overrideOverlay) closeOverrideForm(); });
ovClosed.addEventListener('change', updateOverrideConditionalFields);

overrideForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const draft = {
    date: ovDate.value,
    closed: ovClosed.checked,
    start: ovClosed.checked ? '' : ovStart.value,
    end: ovClosed.checked ? '' : ovEnd.value,
    isSpecialDay: true,
    note: ovNote.value.trim(),
  };
  const errors = validateOverrideDraft(draft);
  if (errors.length > 0) {
    overrideFormErrors.hidden = false;
    overrideFormErrors.innerHTML = `<strong>Please fix the following:</strong><ul>${errors.map((err) => `<li>${escapeHtml(err)}</li>`).join('')}</ul>`;
    return;
  }
  // editing a date and changing the date itself: drop the old entry first
  if (editingOverrideDate && editingOverrideDate !== draft.date) {
    state.openingHours.overrides = removeOverride(state.openingHours.overrides, editingOverrideDate);
  }
  state.openingHours.overrides = upsertOverride(state.openingHours.overrides, draft);
  persist();
  closeOverrideForm();
  renderOverridesTable();
});

// --- Shift types ---

function renderShiftTypesTable(wrap, role) {
  const types = role === 'therapist' ? currentShiftTypeSet.therapistShiftTypes : currentShiftTypeSet.receptionShiftTypes;
  if (types.length === 0) {
    wrap.innerHTML = `<p class="empty-state">No ${role === 'therapist' ? 'therapist' : 'reception'} shift types yet.</p>`;
    return;
  }
  const rows = types.map((t) => `<tr>
    <td>${escapeHtml(t.name)}</td>
    <td>${t.start}&ndash;${t.end}</td>
    <td>${t.breakMinutes} min</td>
    <td>${shiftTypePaidHours(t)}h paid</td>
    <td>
      <button class="link" data-action="edit-shift-type" data-role="${role}" data-id="${t.id}">Edit</button>
      <button class="link danger" data-action="remove-shift-type" data-role="${role}" data-id="${t.id}">Remove</button>
    </td>
  </tr>`).join('');
  wrap.innerHTML = `<table>
    <thead><tr><th>Name</th><th>Hours</th><th>Break</th><th>Paid</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  wrap.querySelectorAll('button[data-action]').forEach((btn) => {
    const id = btn.dataset.id;
    const btnRole = btn.dataset.role;
    const list = btnRole === 'therapist' ? currentShiftTypeSet.therapistShiftTypes : currentShiftTypeSet.receptionShiftTypes;
    if (btn.dataset.action === 'edit-shift-type') {
      btn.addEventListener('click', () => openShiftTypeForm(btnRole, list.find((t) => t.id === id)));
    } else {
      btn.addEventListener('click', () => {
        const type = list.find((t) => t.id === id);
        if (confirm(`Remove the "${type.name}" shift type?`)) {
          if (btnRole === 'therapist') currentShiftTypeSet.therapistShiftTypes = removeShiftType(list, id);
          else currentShiftTypeSet.receptionShiftTypes = removeShiftType(list, id);
          persist();
          renderShiftTypesTable(wrap, btnRole);
        }
      });
    }
  });
}

function renderShiftTypesPanel() {
  renderShiftTypesTable(receptionShiftTypesWrap, 'receptionist');
  renderShiftTypesTable(therapistShiftTypesWrap, 'therapist');
}

function openShiftTypeForm(role, existing) {
  addingShiftTypeRole = role;
  editingShiftType = existing ? { id: existing.id, role } : null;
  shiftTypeFormTitle.textContent = existing ? `Edit shift type: ${existing.name}` : `Add ${role === 'therapist' ? 'therapist' : 'reception'} shift type`;
  shiftTypeFormErrors.hidden = true;
  shiftTypeFormErrors.innerHTML = '';

  const draft = existing ?? newShiftTypeDraft();
  stName.value = draft.name;
  stStart.value = draft.start;
  stEnd.value = draft.end;
  stBreak.value = draft.breakMinutes;

  shiftTypeOverlay.hidden = false;
  stName.focus();
}

function closeShiftTypeForm() {
  shiftTypeOverlay.hidden = true;
  editingShiftType = null;
  shiftTypeForm.reset();
}

document.querySelectorAll('.add-shift-type-btn').forEach((btn) => {
  btn.addEventListener('click', () => openShiftTypeForm(btn.dataset.role, null));
});
shiftTypeCancelBtn.addEventListener('click', closeShiftTypeForm);
shiftTypeOverlay.addEventListener('click', (e) => { if (e.target === shiftTypeOverlay) closeShiftTypeForm(); });

shiftTypeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const draft = {
    id: editingShiftType ? editingShiftType.id : null,
    name: stName.value.trim(),
    start: stStart.value,
    end: stEnd.value,
    breakMinutes: stBreak.value === '' ? 0 : Number(stBreak.value),
  };
  const errors = validateShiftTypeDraft(draft);
  if (errors.length > 0) {
    shiftTypeFormErrors.hidden = false;
    shiftTypeFormErrors.innerHTML = `<strong>Please fix the following:</strong><ul>${errors.map((err) => `<li>${escapeHtml(err)}</li>`).join('')}</ul>`;
    return;
  }
  const role = addingShiftTypeRole;
  if (role === 'therapist') {
    currentShiftTypeSet.therapistShiftTypes = upsertShiftType(currentShiftTypeSet.therapistShiftTypes, draft, newId);
  } else {
    currentShiftTypeSet.receptionShiftTypes = upsertShiftType(currentShiftTypeSet.receptionShiftTypes, draft, newId);
  }
  persist();
  closeShiftTypeForm();
  renderShiftTypesPanel();
});

// --- Scheduling rules: weekly hour cap ---

function renderCapSetting() {
  capHoursInput.value = state.weeklyHourCapSetting.defaultCapHours;
}

capSaveBtn.addEventListener('click', () => {
  const value = Number(capHoursInput.value);
  const errors = validateWeeklyCapSetting(value);
  if (errors.length > 0) {
    capErrors.hidden = false;
    capErrors.innerHTML = `<ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
    return;
  }
  capErrors.hidden = true;
  state.weeklyHourCapSetting.defaultCapHours = value;
  persist();
});

function renderDisplaySettings() {
  dateFormatSelect.value = state.dateFormatPreference;
}

dateFormatSelect.addEventListener('change', () => {
  state.dateFormatPreference = dateFormatSelect.value;
  persist();
  renderRotaPeriods();
  renderAuditLog();
  if (openPeriodDetailId) renderPeriodDetail(openPeriodDetailId);
  if (lastGeneratedResult) renderGenerationResults(lastGeneratedResult);
});

// --- Weekly availability pattern ---

function activeStaffSorted() {
  return state.staff.filter((s) => !isArchived(s, todayIso())).sort((a, b) => a.name.localeCompare(b.name));
}

function renderPatternTable() {
  const active = activeStaffSorted();
  if (active.length === 0) {
    patternTableWrap.innerHTML = `<p class="empty-state">Add staff first to set their availability pattern.</p>`;
    return;
  }

  const rows = active.map((s) => {
    const { hasPattern, days } = patternDaysOfWeek(state.availabilityPatterns, s.id);
    const checkboxes = DAY_LABELS.map((label, dow) => {
      const checked = hasPattern ? days.has(dow) : true;
      return `<label><input type="checkbox" class="pattern-checkbox" data-staff-id="${s.id}" data-dow="${dow}" ${checked ? 'checked' : ''}>${label}</label>`;
    }).join('');
    return `<tr>
      <td class="staff-name-cell" style="position:static;">${escapeHtml(s.name)}</td>
      <td style="padding: 0.4rem 0.6rem;"><div class="pattern-days">${checkboxes}</div></td>
      <td><button class="link" data-action="message" data-staff-id="${s.id}">Message</button></td>
    </tr>`;
  }).join('');

  patternTableWrap.innerHTML = `<table><tbody>${rows}</tbody></table>`;

  patternTableWrap.querySelectorAll('.pattern-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const staffId = cb.dataset.staffId;
      const rowCheckboxes = patternTableWrap.querySelectorAll(`.pattern-checkbox[data-staff-id="${staffId}"]`);
      const availableDays = new Set();
      rowCheckboxes.forEach((c) => { if (c.checked) availableDays.add(Number(c.dataset.dow)); });
      state.availabilityPatterns = setWeeklyPattern(state.availabilityPatterns, staffId, availableDays);
      persist();
      renderAvailabilityGrid(); // the grid's defaults may have just shifted
    });
  });

  patternTableWrap.querySelectorAll('button[data-action="message"]').forEach((btn) => {
    btn.addEventListener('click', () => openMessageOverlay(btn.dataset.staffId));
  });
}

function openMessageOverlay(staffId) {
  const person = state.staff.find((s) => s.id === staffId);
  if (!person) return;
  const [year, month] = gridMonthInput.value.split('-').map(Number);
  messageTitle.textContent = `Availability request: ${person.name}`;
  messageText.value = generateAvailabilityRequestMessage(person, year, month);
  messageOverlay.hidden = false;
}

messageCloseBtn.addEventListener('click', () => { messageOverlay.hidden = true; });
messageOverlay.addEventListener('click', (e) => { if (e.target === messageOverlay) messageOverlay.hidden = true; });
messageCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(messageText.value);
    const original = messageCopyBtn.textContent;
    messageCopyBtn.textContent = 'Copied!';
    setTimeout(() => { messageCopyBtn.textContent = original; }, 1500);
  } catch {
    messageText.select();
  }
});

// --- Availability & demand grid ---

function renderAvailabilityGrid() {
  const [year, month] = gridMonthInput.value.split('-').map(Number);
  const dates = datesInMonth(year, month);
  const active = activeStaffSorted();

  if (active.length === 0) {
    availabilityGridWrap.innerHTML = `<p class="empty-state">Add staff first to enter availability.</p>`;
    return;
  }

  const dayHeaders = dates.map((d) => {
    const dow = isoWeekday(d);
    const dayNum = Number(d.slice(8, 10));
    return `<th class="day-head ${dow >= 5 ? 'weekend' : ''}">${dayNum}</th>`;
  }).join('');

  const rows = active.map((s) => {
    const cells = dates.map((d) => {
      const available = effectiveAvailability(s.id, d, state.availability, state.availabilityPatterns);
      const overridden = hasExplicitOverride(s.id, d, state.availability);
      return `<td class="avail-cell ${available ? 'available' : 'unavailable'} ${overridden ? 'overridden' : ''}" data-staff-id="${s.id}" data-date="${d}"></td>`;
    }).join('');
    return `<tr><td class="staff-name-cell">${escapeHtml(s.name)}</td>${cells}</tr>`;
  }).join('');

  availabilityGridWrap.innerHTML = `<table class="avail-grid-table">
    <thead><tr><th class="staff-name-head">Staff</th>${dayHeaders}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function applyPaint(staffId, dateIso, value) {
  state.availability = setDayOverride(state.availability, staffId, dateIso, value ? 'available' : 'unavailable', newId);
  renderAvailabilityGrid();
}

availabilityGridWrap.addEventListener('mousedown', (e) => {
  const cell = e.target.closest('.avail-cell');
  if (!cell) return;
  const { staffId, date } = cell.dataset;
  const current = effectiveAvailability(staffId, date, state.availability, state.availabilityPatterns);
  paintValue = !current;
  applyPaint(staffId, date, paintValue);
});

availabilityGridWrap.addEventListener('mouseover', (e) => {
  if (paintValue === null) return;
  const cell = e.target.closest('.avail-cell');
  if (!cell) return;
  applyPaint(cell.dataset.staffId, cell.dataset.date, paintValue);
});

document.addEventListener('mouseup', () => {
  if (paintValue !== null) {
    paintValue = null;
    persist();
  }
});

gridMonthInput.addEventListener('change', () => {
  renderAvailabilityGrid();
  renderDemandTable();
});

copyLastMonthBtn.addEventListener('click', () => {
  const [year, month] = gridMonthInput.value.split('-').map(Number);
  const prev = previousMonth(year, month);
  const fromDates = datesInMonth(prev.year, prev.month);
  const toDates = datesInMonth(year, month);
  if (fromDates.length !== toDates.length) {
    alert(`Can't copy directly: ${prev.year}-${String(prev.month).padStart(2, '0')} has ${fromDates.length} days, but this month has ${toDates.length}.`);
    return;
  }
  const staffIds = activeStaffSorted().map((s) => s.id);
  state.availability = copyOverridesToMonth(state.availability, staffIds, fromDates, toDates, newId);
  persist();
  renderAvailabilityGrid();
});

// --- Therapist demand (forecast hours) ---

function renderDemandTable() {
  const [year, month] = gridMonthInput.value.split('-').map(Number);
  const dates = datesInMonth(year, month);

  const dayHeaders = dates.map((d) => {
    const dow = isoWeekday(d);
    const dayNum = Number(d.slice(8, 10));
    return `<th class="day-head ${dow >= 5 ? 'weekend' : ''}">${dayNum}</th>`;
  }).join('');

  const cells = dates.map((d) => {
    const hours = forecastHoursForDate(state.demand, d);
    return `<td><input type="number" class="demand-input" data-date="${d}" min="0" step="0.5" value="${hours ?? ''}" style="width: 26px; border: none; text-align: center; font-size: 0.7rem; padding: 0.3rem 0;"></td>`;
  }).join('');

  demandTableWrap.innerHTML = `<table class="avail-grid-table">
    <thead><tr><th class="staff-name-head">Forecast hours</th>${dayHeaders}</tr></thead>
    <tbody><tr><td class="staff-name-cell"></td>${cells}</tr></tbody>
  </table>`;

  demandTableWrap.querySelectorAll('.demand-input').forEach((input) => {
    input.addEventListener('change', () => {
      const value = input.value === '' ? null : Number(input.value);
      state.demand = setForecastHours(state.demand, input.dataset.date, value);
      persist();
    });
  });
}

applyDemandDefaultsBtn.addEventListener('click', () => {
  const weekdayHours = demandWeekdayDefault.value === '' ? 0 : Number(demandWeekdayDefault.value);
  const weekendHours = demandWeekendDefault.value === '' ? 0 : Number(demandWeekendDefault.value);
  const [year, month] = gridMonthInput.value.split('-').map(Number);
  const dates = datesInMonth(year, month);
  state.demand = applyWeekdayWeekendDefaults(state.demand, dates, weekdayHours, weekendHours, (d) => isoWeekday(d) >= 5);
  persist();
  renderDemandTable();
});

gridMonthInput.value = todayIso().slice(0, 7);

// --- Generate rota (Phase 6) ---

function nameOf(staffId) {
  return state.staff.find((s) => s.id === staffId)?.name ?? '(unknown)';
}

// One row per shift instance (date, role, shift type, staff) rather than
// cramming every name for a day into one cell - matches the layout the
// saved-period detail table already uses (renderPeriodDetail), so a
// manager reads both with the same learned pattern, and the shift type
// becomes a scannable badge instead of parenthetical text to parse.
function renderGenerationResults(result) {
  const rows = result.weeks.map((week) => {
    const weekHead = `<tr class="gen-week-head"><td colspan="4">Week of ${fmtDate(week.weekStart, { includeYear: false, includeWeekday: true })}</td></tr>`;
    const dayRows = week.dates.map((date, i) => {
      const receptionDay = week.reception.days[i];
      const therapistDay = week.therapist.days[i];
      const dateLabel = fmtDate(date, { includeYear: false, includeWeekday: true });

      if (receptionDay.closed) {
        return `<tr class="closed"><td>${dateLabel}</td><td>&mdash;</td><td>Closed</td><td>&mdash;</td></tr>`;
      }
      if (receptionDay.unfilled) {
        return `<tr class="unfilled"><td>${dateLabel}</td><td>Reception</td><td class="unfilled-cell" colspan="2">UNFILLED &ndash; no one available to cover</td></tr>`;
      }

      const receptionRows = receptionDay.assignment.map((a) => `<tr>
        <td>${dateLabel}</td><td>Reception</td>
        <td><span class="tag">${escapeHtml(a.shiftType.name)}</span></td>
        <td>${escapeHtml(nameOf(a.staffId))}</td>
      </tr>`);
      const therapistRows = therapistDay.assignment.map((a) => `<tr>
        <td>${dateLabel}</td><td>Therapist</td>
        <td><span class="tag">${escapeHtml(a.shiftType.name)}</span></td>
        <td>${escapeHtml(nameOf(a.staffId))}</td>
      </tr>`);
      return [...receptionRows, ...therapistRows].join('');
    }).join('');
    return weekHead + dayRows;
  }).join('');

  generateResults.innerHTML = `<table class="gen-table">
    <thead><tr><th>Date</th><th>Role</th><th>Shift type</th><th>Staff</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

generateBtn.addEventListener('click', () => {
  const [year, month] = generateMonthInput.value.split('-').map(Number);
  const weekStarts = weekStartsForMonth(year, month);
  const eligibility = buildEligibility(state);
  const receptionists = activeStaffSorted().filter((s) => s.role === 'receptionist');
  const therapists = activeStaffSorted().filter((s) => s.role === 'therapist');

  const result = solveChainedWeeks({
    weekStarts,
    openingHours: state.openingHours,
    shiftTypeSets: state.shiftTypeSets,
    receptionists,
    therapists,
    eligibility,
    weeklyHourCapSetting: state.weeklyHourCapSetting,
    demand: state.demand,
    ledgerEvents: state.ledgerEvents,
    isExempt: () => false,
  });

  const summary = summarizeGeneration(result.weeks, [...receptionists, ...therapists], result.finalBalance);
  generateSummary.innerHTML = `<p class="summary-line ${summary.coverageComplete ? '' : 'incomplete'}">${escapeHtml(summary.line)}</p>`;
  renderGenerationResults(result);

  lastGeneratedResult = result;
  saveDraftBtn.disabled = false;
});

saveDraftBtn.addEventListener('click', () => {
  if (!lastGeneratedResult) return;
  try {
    const saved = saveChainedWeeksAsDraftPeriods(
      { rotaPeriods: state.rotaPeriods, shifts: state.shifts, assignments: state.assignments },
      lastGeneratedResult, newId, new Date().toISOString()
    );
    state.rotaPeriods = saved.rotaPeriods;
    state.shifts = saved.shifts;
    state.assignments = saved.assignments;
    persist();
    const weekCount = lastGeneratedResult.weeks.length;
    generateSummary.insertAdjacentHTML('beforeend', `<p class="summary-line">Saved ${weekCount} week${weekCount === 1 ? '' : 's'} as a draft rota.</p>`);
    renderRotaPeriods();
  } catch (err) {
    alert(err.message);
  }
});

// --- Rota periods: closing (banking real ledger hours) ---

function renderRotaPeriods() {
  const periods = [...state.rotaPeriods].sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (periods.length === 0) {
    rotaPeriodsWrap.innerHTML = `<p class="empty-state">No rota periods saved yet - generate and save a draft above first.</p>`;
    return;
  }

  const rows = periods.map((p) => {
    const statusTag = `<span class="tag ${p.status === 'closed' ? '' : 'weighted'}">${p.status}</span>`;
    const closeAction = p.status === 'closed'
      ? `<span class="hint">Closed ${p.closedAt ? p.closedAt.slice(0, 10) : ''}</span>`
      : `<button class="link" data-action="close-period" data-id="${p.id}">Close this week</button>`;
    return `<tr><td>${fmtRange(p.startDate, p.endDate)}</td><td>${statusTag}</td><td>${closeAction} <button class="link" data-action="view-period" data-id="${p.id}">View shifts</button></td></tr>`;
  }).join('');

  rotaPeriodsWrap.innerHTML = `<table>
    <thead><tr><th>Week</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  rotaPeriodsWrap.querySelectorAll('button[data-action="close-period"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const period = state.rotaPeriods.find((p) => p.id === btn.dataset.id);
      if (!confirm(`Close the week of ${fmtDate(period.startDate)}? This banks everyone's actual hours into their fairness ledger for good.`)) return;
      try {
        const result = closePeriod(state, period.id, newId, new Date().toISOString());
        state.rotaPeriods = result.rotaPeriods;
        state.assignments = result.assignments;
        state.ledgerEvents = result.ledgerEvents;
        persist();
        renderRotaPeriods();
        if (openPeriodDetailId === period.id) renderPeriodDetail(period.id);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  rotaPeriodsWrap.querySelectorAll('button[data-action="view-period"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      periodDetailPanel.hidden = false;
      renderPeriodDetail(btn.dataset.id);
      periodDetailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// --- Rota periods: per-shift detail + manual editing (Phase 7) ---

function shiftTypeForShift(shift) {
  const set = resolveShiftTypeSet(state.shiftTypeSets, shift.date);
  if (!set) return null;
  const list = shift.roleRequired === 'therapist' ? set.therapistShiftTypes : set.receptionShiftTypes;
  return list.find((t) => t.id === shift.shiftTypeId) ?? null;
}

// This person's other currently-worked shifts (excluding the one named),
// resolved to their shiftType config - the shape editWarnings.js's
// swapWarnings expects, without that pure module needing to know
// shifts[]/assignments[] itself.
function otherWorkedShiftsForStaff(staffId, excludeAssignmentId) {
  return state.assignments
    .filter((a) => a.staffId === staffId && a.id !== excludeAssignmentId && a.status !== 'cancelled')
    .map((a) => {
      const shift = state.shifts.find((s) => s.id === a.shiftId);
      const shiftType = shift ? shiftTypeForShift(shift) : null;
      return shift && shiftType ? { date: shift.date, shiftType } : null;
    })
    .filter(Boolean);
}

// Whether THIS assignment's current staffId is itself flagged by the same
// advisory checks the swap form uses - reused by the "This week" summary
// and the per-shift flag-dot, so a manual swap and a solver-generated
// assignment get exactly the same scrutiny.
function assignmentWarnings(assignment) {
  if (!assignment.staffId) return null;
  const shift = state.shifts.find((s) => s.id === assignment.shiftId);
  const shiftType = shift ? shiftTypeForShift(shift) : null;
  const staffMember = state.staff.find((s) => s.id === assignment.staffId);
  if (!shift || !shiftType || !staffMember) return null;
  const rawWarnings = swapWarnings({
    staffId: assignment.staffId,
    targetDate: shift.date,
    targetShiftType: shiftType,
    staffMember,
    otherShiftsForStaff: otherWorkedShiftsForStaff(assignment.staffId, assignment.id),
    weeklyHourCapSetting: state.weeklyHourCapSetting,
    availability: state.availability,
    availabilityPatterns: state.availabilityPatterns,
    plannedRestWeeks: state.plannedRestWeeks,
  });
  const warnings = undismissedWarnings(rawWarnings, assignment.dismissedWarnings ?? []);
  return { shift, staffMember, warnings };
}

function renderPeriodDetail(periodId) {
  const period = state.rotaPeriods.find((p) => p.id === periodId);
  if (!period) {
    periodDetailPanel.hidden = true;
    openPeriodDetailId = null;
    return;
  }
  openPeriodDetailId = periodId;
  periodDetailTitle.textContent = `Week of ${fmtRange(period.startDate, period.endDate)}`;

  const shifts = state.shifts
    .filter((s) => s.periodId === periodId && !s.isShadowSlot)
    .sort((a, b) => a.date.localeCompare(b.date) || a.roleRequired.localeCompare(b.roleRequired));

  if (shifts.length === 0) {
    periodDetailWrap.innerHTML = `<p class="empty-state">No shifts in this period.</p>`;
    return;
  }

  const rows = shifts.map((shift) => {
    const assignment = state.assignments.find((a) => a.shiftId === shift.id);
    const shiftType = shiftTypeForShift(shift);
    const roleLabel = shift.roleRequired === 'therapist' ? 'Therapist' : 'Reception';
    const statusTag = assignment.status === 'assigned' ? '' : ` <span class="tag">${escapeHtml(assignment.status)}</span>`;
    const flagged = assignmentWarnings(assignment);
    const flagDot = flagged && flagged.warnings.length > 0
      ? `<span class="flag-dot" title="${escapeHtml(flagged.warnings.join(' '))}"></span>`
      : '';
    const staffCell = assignment.staffId
      ? `${escapeHtml(nameOf(assignment.staffId))}${flagDot}${statusTag}`
      : '<span class="unfilled-cell">Unfilled</span>';
    // Pre-close, plannedHours IS the only figure that exists - "planned" as a
    // qualifier only earns its place once there's an actual figure to
    // contrast it with (a week that's closed, possibly after a reduction),
    // so it stays bare until then rather than implying a distinction that
    // doesn't exist yet.
    const hoursCell = assignment.actualHours != null
      ? `${assignment.actualHours}h actual / ${assignment.plannedHours}h planned`
      : `${assignment.plannedHours}h`;
    const canEdit = period.status === 'draft' && assignment.status === 'assigned';
    const dismissBtn = flagged && flagged.warnings.length > 0
      ? ` <button class="link" data-action="dismiss-warnings" data-assignment-id="${assignment.id}">Mark as checked</button>`
      : '';
    const actions = (canEdit
      ? `<button class="link" data-action="swap" data-assignment-id="${assignment.id}">Swap</button>`
      : '<span class="hint">&mdash;</span>') + dismissBtn;
    return `<tr>
      <td>${fmtDate(shift.date, { includeYear: false })}</td>
      <td>${roleLabel}</td>
      <td>${escapeHtml(shiftType ? shiftType.name : '(unknown shift type)')}</td>
      <td>${staffCell}</td>
      <td>${hoursCell}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  periodDetailWrap.innerHTML = `<table>
    <thead><tr><th>Date</th><th>Role</th><th>Shift</th><th>Staff</th><th>Hours</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  periodDetailWrap.querySelectorAll('button[data-action="swap"]').forEach((btn) => {
    btn.addEventListener('click', () => openSwapForm(btn.dataset.assignmentId));
  });

  periodDetailWrap.querySelectorAll('button[data-action="dismiss-warnings"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const assignment = state.assignments.find((a) => a.id === btn.dataset.assignmentId);
      const flagged = assignmentWarnings(assignment);
      if (!flagged || flagged.warnings.length === 0) return;
      const result = dismissAssignmentWarnings(
        { assignments: state.assignments, auditLog: state.auditLog },
        assignment.id, flagged.warnings, newId, new Date().toISOString()
      );
      state.assignments = result.assignments;
      state.auditLog = result.auditLog;
      persist();
      renderPeriodDetail(openPeriodDetailId);
      renderAuditLog();
    });
  });
}

periodDetailBackBtn.addEventListener('click', () => {
  periodDetailPanel.hidden = true;
  openPeriodDetailId = null;
});

function renderAuditLog() {
  const entries = sortedAuditLogDesc(state.auditLog);
  if (entries.length === 0) {
    auditLogWrap.innerHTML = `<p class="empty-state">No manual changes yet.</p>`;
    return;
  }
  const rows = entries.map((e) => {
    const shift = state.shifts.find((s) => s.id === e.shiftId);
    const shiftLabel = shift ? `${fmtDate(shift.date, { includeYear: false })} (${shift.roleRequired === 'therapist' ? 'Therapist' : 'Reception'})` : '(unknown shift)';
    return `<tr>
      <td>${escapeHtml(e.timestamp.slice(0, 16).replace('T', ' '))}</td>
      <td>${escapeHtml(e.type)}</td>
      <td>${escapeHtml(nameOf(e.staffId))}</td>
      <td>${escapeHtml(shiftLabel)}</td>
      <td>${escapeHtml(e.note || '')}</td>
    </tr>`;
  }).join('');
  auditLogWrap.innerHTML = `<table>
    <thead><tr><th>When</th><th>Type</th><th>Staff</th><th>Shift</th><th>Note</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function openSwapForm(assignmentId) {
  const assignment = state.assignments.find((a) => a.id === assignmentId);
  if (!assignment) return;
  const shift = state.shifts.find((s) => s.id === assignment.shiftId);
  if (!shift) return;

  swappingAssignmentId = assignmentId;
  swapFormErrors.hidden = true;
  swapFormErrors.innerHTML = '';

  const candidates = state.staff
    .filter((s) => s.role === shift.roleRequired && !isArchived(s, shift.date))
    .sort((a, b) => a.name.localeCompare(b.name));
  swapStaffSelect.innerHTML = candidates
    .map((s) => `<option value="${s.id}" ${s.id === assignment.staffId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
    .join('');

  updateSwapWarnings();
  swapOverlay.hidden = false;
}

function updateSwapWarnings() {
  const assignment = state.assignments.find((a) => a.id === swappingAssignmentId);
  if (!assignment) return;
  const shift = state.shifts.find((s) => s.id === assignment.shiftId);
  const shiftType = shift ? shiftTypeForShift(shift) : null;
  const staffMember = state.staff.find((s) => s.id === swapStaffSelect.value);

  if (!shift || !shiftType || !staffMember) {
    swapWarningsWrap.innerHTML = '';
    return;
  }

  const warnings = swapWarnings({
    staffId: staffMember.id,
    targetDate: shift.date,
    targetShiftType: shiftType,
    staffMember,
    otherShiftsForStaff: otherWorkedShiftsForStaff(staffMember.id, assignment.id),
    weeklyHourCapSetting: state.weeklyHourCapSetting,
    availability: state.availability,
    availabilityPatterns: state.availabilityPatterns,
    plannedRestWeeks: state.plannedRestWeeks,
  });

  swapWarningsWrap.innerHTML = warnings.length > 0
    ? `<strong>Heads up:</strong><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : '';
}

function closeSwapForm() {
  swapOverlay.hidden = true;
  swappingAssignmentId = null;
  swapForm.reset();
}

swapStaffSelect.addEventListener('change', updateSwapWarnings);
swapCancelBtn.addEventListener('click', closeSwapForm);
swapOverlay.addEventListener('click', (e) => { if (e.target === swapOverlay) closeSwapForm(); });

swapForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const assignment = state.assignments.find((a) => a.id === swappingAssignmentId);
  if (!assignment) return;

  const draft = newSwapDraft(assignment);
  draft.staffId = swapStaffSelect.value;

  const errors = validateSwapDraft(draft, { assignments: state.assignments, shifts: state.shifts, staff: state.staff });
  if (errors.length > 0) {
    swapFormErrors.hidden = false;
    swapFormErrors.innerHTML = `<strong>Please fix the following:</strong><ul>${errors.map((err) => `<li>${escapeHtml(err)}</li>`).join('')}</ul>`;
    return;
  }

  const result = swapAssignmentStaff(
    { assignments: state.assignments, auditLog: state.auditLog }, draft, newId, new Date().toISOString()
  );
  state.assignments = result.assignments;
  state.auditLog = result.auditLog;
  persist();
  closeSwapForm();
  renderPeriodDetail(openPeriodDetailId);
  renderAuditLog();
});

generateMonthInput.value = todayIso().slice(0, 7);

renderStaffTable();
renderOpeningHoursDefaults();
renderOverridesTable();
renderShiftTypesPanel();
renderCapSetting();
renderDisplaySettings();
renderPatternTable();
renderAvailabilityGrid();
renderDemandTable();
renderRotaPeriods();
renderAuditLog();
renderWeekSummary();
