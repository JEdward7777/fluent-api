import {
  createAnalysisProgress,
  evidenceActions,
  inspectionSummary,
  workflowStatus,
} from './analysis-progress.js';
import { createDraftDatabaseTest } from './database-test.js';
import { renderGuide as updateGuide } from './guide.js';
import { createPaidControls } from './paid-controls.js';
import {
  renderExactPreview as updateExactPreview,
  syncPracticeDraftControls as updatePracticeDraftControls,
} from './preview-ui.js';
import { initReportControls, invalidateReportSelection } from './report-controls.js';
import { reassessmentStatus } from './review-rerun.js';
import { hasUnsavedReviewDraft, initReview, setReviewBusy, updateReview } from './review.js';
import { initSave, renderSave, saveStatusUnconfirmed, withTabSaveOutcome } from './save.js';
import {
  equivalentCliCommand,
  pendingSettings,
  populateSettings,
  roleConnectionDrafts,
  syncSettingsFields,
} from './settings-draft.js';

const launchedToken = window.location.hash.slice(1);
if (launchedToken) window.sessionStorage.setItem('license-workbench-token', launchedToken);
const token = launchedToken || window.sessionStorage.getItem('license-workbench-token');
if (launchedToken)
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
const status = document.getElementById('status');
const form = document.getElementById('setup');
const inspect = document.getElementById('inspect');
const analyze = document.getElementById('analyze');
const stop = document.getElementById('stop');
const inspection = document.getElementById('inspection');
const databaseTest = document.getElementById('database-test');
const applySettings = document.getElementById('apply-settings');
const restoreSettings = document.getElementById('restore-settings');
const settingsChangeStatus = document.getElementById('settings-change-status');
const databaseSettings = document.getElementById('database-settings');
const settingsActionsHelp = document.getElementById('settings-actions-help');
let setup;
let dirty = '';
let applyingSettings = false;
let practiceBusy = false;
let sessionUnconfirmed = false;

const previewButton = document.getElementById('normal-preview-button');
const attestation = document.getElementById('attestation');
const draftDatabase = createDraftDatabaseTest(
  form,
  request,
  confirmTestRevision,
  updateDraftControls
);

const analysisProgress = createAnalysisProgress(
  () => setup,
  render,
  () => sessionUnconfirmed
);
const drafts = roleConnectionDrafts(form, draftDatabase, () => setup, checkPendingSettings);
const { readDraft, appliedConnection } = drafts;
const pending = () => drafts.conflict || (setup ? pendingSettings(setup, readDraft()) : '');

function showPending(changes) {
  dirty = changes;
  settingsChangeStatus.textContent =
    drafts.conflict ||
    (dirty
      ? `Pending settings changes: ${dirty}. Restore applied settings to keep the current review.`
      : '');
}

function settingsRequestActive(next = setup) {
  return applyingSettings || draftDatabase.running || next?.testingDatabase;
}

function workbenchBusy(next) {
  return (
    Boolean(analysisProgress.starting) ||
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    Boolean(next.activeOperationId) ||
    ['inspecting', 'analyzing', 'previewing', 'saving', 'exporting', 'reconfiguring'].includes(
      next.state
    )
  );
}

const paidControls = createPaidControls(() => setup, syncSettingsActions, start);
function syncSettingsActions(next) {
  const busy = workbenchBusy(next);
  syncSettingsFields(form, busy || applyingSettings, next.practice);
  const blocked = busy || settingsRequestActive(next);
  databaseTest.disabled =
    blocked || Boolean(drafts.conflict) || next.practice || next.state === 'uncertain';
  applySettings.disabled = blocked || Boolean(drafts.conflict);
  restoreSettings.disabled = blocked;
  const actions = evidenceActions(next, blocked, dirty, hasUnsavedReviewDraft());
  paidControls.update(next, actions.analyze);
  inspect.disabled = !actions.inspect;
  analyze.disabled = !actions.analyze;
  inspection.hidden = !next.inspected;
  inspection.textContent = inspectionSummary(next, dirty);
}

const renderGuide = (next) =>
  updateGuide(next, {
    dirty,
    practiceBusy,
    sessionUnconfirmed,
    startingAnalysis: analysisProgress.starting === 'analysis',
  });

const previewFlags = () => ({
  dirty,
  practiceBusy,
  sessionUnconfirmed,
  settingsBusy: settingsRequestActive(),
});
const renderExactPreview = (next) => updateExactPreview(next, previewFlags());
const syncPracticeDraftControls = () => updatePracticeDraftControls(setup, previewFlags());

function syncReviewAvailability(next) {
  renderExactPreview(next);
  renderSave(next);
  syncPracticeDraftControls();
  setReviewBusy(workbenchBusy(next) || practiceBusy || settingsRequestActive(next), Boolean(dirty));
}

function checkPendingSettings() {
  const changes = pending();
  if (changes !== dirty) {
    showPending(changes);
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    renderGuide(setup);
  }
  return Boolean(changes);
}

async function request(path, method = 'GET', body, responseType = 'json') {
  const response = await fetch(`./api/${path}`, {
    method,
    headers: {
      'x-workbench-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = new Error(await response.text());
    error.status = response.status;
    error.requestRejected = [400, 403, 409].includes(response.status);
    throw error;
  }
  return responseType === 'blob' ? response.blob() : response.json();
}
initReview(
  request,
  async (body) => {
    const result = await request('review/edit', 'POST', body);
    render(result.setup);
    return result;
  },
  () => {
    syncPracticeDraftControls();
    if (setup) {
      syncSettingsActions(setup);
      renderExactPreview(setup);
      renderSave(setup);
      renderGuide(setup);
    }
  },
  async (body) => {
    if (checkPendingSettings()) throw new Error('Apply or restore settings before reassessment.');
    const next = await request('review/rerun', 'POST', body);
    if (
      next.configurationRevision < setup.configurationRevision ||
      (next.configurationRevision === setup.configurationRevision &&
        next.contentRevision < setup.contentRevision)
    )
      throw Object.assign(new Error('The review changed. Select reassessment again.'), {
        requestRejected: true,
      });
    render(next);
    if (!dirty) status.textContent = reassessmentStatus(body, next.paidEstimate);
    return next;
  }
);
function render(raw, populate = false) {
  const next = withTabSaveOutcome(raw, setup);
  sessionUnconfirmed = false;
  if (setup?.loadRevision !== next.loadRevision || setup?.contentRevision !== next.contentRevision)
    form.elements.discardReviewedState.checked = false;
  drafts.refresh(setup, next, populate);
  setup = next;
  updateReview(next);
  draftDatabase.syncFields(appliedConnection());
  form.hidden = false;
  document.getElementById('practice-banner').hidden = !next.practice;
  document.getElementById('cli-details').hidden = next.practice;
  document.getElementById('operations-heading').textContent = next.practice
    ? 'Workflow modes'
    : 'What the selections mean';
  document.getElementById('alternatives-note').textContent = next.practice
    ? 'Practice uses saved JSON → scratch JSON. Database targets require a separate normal workbench launch.'
    : 'Both previews JSON and database destinations independently. Cross-storage sync preserves stronger destination decisions and omitted rows.';
  document.getElementById('inspect-help').textContent = next.practice
    ? 'Inspect reads the selected saved JSON or bundled example and copies it into a new private scratch directory. No model or database is used.'
    : 'Inspect reads selected files, database and request cache as needed.';
  document.getElementById('analysis-help').textContent = next.practice
    ? 'Practice analysis uses saved JSON evidence without model requests.'
    : 'Prepare free evidence applies rule matches and complete cached assessments. Missing samples stay unchanged and are counted below. This action sends zero model requests.';
  if (next.practice) {
    for (const key of ['output', 'cacheDir', 'reportDir', 'reportFormats'])
      form.elements[key].value = next[key] ?? '';
    document.getElementById('practice-location').textContent = next.scratch
      ? `Scratch: ${next.scratch}. Original SHA-256: ${next.originalHash}. Restart with --practice for a fresh session; discard this directory when finished. Practice output is never imported into a real session automatically.`
      : 'Scratch is allocated after Inspect. Restart with --practice for a fresh session; discard the scratch directory when finished. Practice output is never imported into a real session automatically.';
  }
  showPending(pending());
  document.getElementById('discard-label').hidden = !next.analysis;
  document.getElementById('database-target').textContent = next.databaseTarget;
  document.getElementById('cli-connection-note').textContent =
    next.databaseConnection.mode === 'session'
      ? 'The CLI command below does not transfer this session database or its password. The CLI uses its own environment database connection.'
      : 'The CLI uses its environment database connection.';
  const step = ['inspected', 'analyzing'].includes(next.state)
    ? 'Analyze'
    : ['reviewing', 'previewing'].includes(next.state)
      ? 'Review'
      : ['previewed', 'saving'].includes(next.state)
        ? 'Preview changes'
        : next.state === 'saved'
          ? 'Save'
          : 'Choose inputs';
  for (const item of document.querySelectorAll('nav li')) {
    if (item.textContent === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  document.getElementById('cli-command').textContent = equivalentCliCommand(next);
  const busy = workbenchBusy(next);
  syncSettingsActions(next);
  databaseTest.hidden = next.practice;
  settingsActionsHelp.hidden = next.practice;
  if (next.practice) {
    document.getElementById('database-settings').hidden = true;
    form.elements.input.placeholder = 'Bundled example or an absolute saved JSON path';
  }
  stop.hidden = next.state !== 'analyzing';
  stop.disabled =
    next.state !== 'analyzing' || Boolean(next.latestOperation?.progress?.stopRequested);
  analysisProgress.update(next);
  status.textContent = workflowStatus(next, { busy, dirty, starting: analysisProgress.starting });
  const practiceReview = document.getElementById('practice-review');
  practiceReview.hidden = !next.practice || !next.analysis;
  syncReviewAvailability(next);
  renderGuide(next);
}
async function refresh() {
  render(await request('setup'));
  if (setup.activeOperationId) {
    const operation = await request(`operations/${encodeURIComponent(setup.activeOperationId)}`);
    if (operation.state === 'running') window.setTimeout(pollEvidence, 800);
    else render(await request('setup'));
  } else if (setup.testingDatabase && !draftDatabase.running) window.setTimeout(refresh, 800);
}
async function pollEvidence() {
  try {
    await refresh();
  } catch {
    sessionUnconfirmed = true;
    stop.disabled = true;
    const message = 'Operation status is unavailable. Reload to check the result.';
    analysisProgress.update(setup, message);
    status.textContent = message;
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    renderGuide(setup);
  }
}
form.addEventListener('input', (event) => {
  draftDatabase.syncFields(appliedConnection());
  if (databaseSettings.contains(event.target)) draftDatabase.invalidate();
  checkPendingSettings();
});
form.addEventListener('change', checkPendingSettings);
document.addEventListener('focusin', checkPendingSettings);
document.addEventListener('pointerdown', checkPendingSettings, true);
restoreSettings.addEventListener('click', () => {
  if (!setup || restoreSettings.disabled) return;
  drafts.reset();
  populateSettings(form, setup);
  draftDatabase.syncFields(appliedConnection());
  draftDatabase.invalidate();
  checkPendingSettings();
  status.textContent = 'Applied settings restored.';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!setup || applySettings.disabled || !checkPendingSettings()) return;
  try {
    if (hasUnsavedReviewDraft()) {
      status.textContent = 'Apply or discard the open row edit before changing settings.';
      status.tabIndex = -1;
      status.focus();
      return;
    }
    applyingSettings = true;
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    status.textContent = 'Applying settings…';
    render(
      await request('setup', 'POST', {
        configurationRevision: setup.configurationRevision,
        ...drafts.discardConfirmation(),
        ...readDraft(),
      }),
      true
    );
  } catch (error) {
    status.textContent = error.message;
  } finally {
    applyingSettings = false;
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
  }
});
async function confirmTestRevision(revision, role) {
  try {
    const latest = await request('setup');
    render(latest);
    if (latest[`${role}Revision`] === revision) return true;
    status.textContent =
      drafts.conflict ||
      'Connection settings changed while testing. Review the current settings and test again.';
    return false;
  } catch {
    status.textContent = 'Session status is unavailable. Reload before applying settings.';
  }
  sessionUnconfirmed = true;
  return false;
}

function updateDraftControls() {
  syncSettingsActions(setup);
  syncReviewAvailability(setup);
  if (setup.testingDatabase && !draftDatabase.running && !sessionUnconfirmed)
    window.setTimeout(refresh, 800);
}

databaseTest.addEventListener('click', () => {
  if (!setup || databaseTest.disabled || settingsRequestActive()) return;
  void draftDatabase.run(setup[`${drafts.role}Revision`], drafts.role);
});
async function start(kind, paidBody) {
  if (hasUnsavedReviewDraft() || (kind === 'inspect' ? inspect.disabled : analyze.disabled)) return;
  if (!setup || workbenchBusy(setup) || settingsRequestActive() || checkPendingSettings()) return;
  const begin = async () => {
    await request(
      kind,
      'POST',
      paidBody ?? {
        operationId: crypto.randomUUID(),
        configurationRevision: setup.configurationRevision,
        ...drafts.discardConfirmation(),
      }
    );
    await refresh();
  };
  try {
    await analysisProgress.start(kind, begin, pollEvidence);
  } catch (error) {
    if (sessionUnconfirmed) return;
    status.textContent = error.message;
    if (kind !== 'inspect') analysisProgress.update(setup, error.message);
    if (kind === 'paid' && error.requestRejected) paidControls.resetReceipt();
  }
}
inspect.addEventListener('click', () => start('inspect'));
analyze.addEventListener('click', () => start('analysis'));
stop.addEventListener('click', async () => {
  if (stop.disabled || sessionUnconfirmed) return;
  try {
    await request('stop', 'POST');
    stop.disabled = true;
    status.textContent = 'Stop requested after the current key.';
  } catch (error) {
    status.textContent = error.message;
  }
});
async function practiceAction(path, body) {
  if (
    practiceBusy ||
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    checkPendingSettings() ||
    settingsRequestActive()
  )
    return;
  if (hasUnsavedReviewDraft()) {
    status.textContent = 'Apply or discard the open row edit before previewing or saving.';
    return;
  }
  practiceBusy = true;
  invalidateReportSelection();
  renderExactPreview(setup);
  setReviewBusy(true);
  renderGuide(setup);
  let failure;
  for (const id of ['practice-preview', 'practice-save'])
    document.getElementById(id).disabled = true;
  try {
    render(await request(path, 'POST', body));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    practiceBusy = false;
    setReviewBusy(false);
    renderGuide(setup);
    if (failure) await recoverActionFailure(failure);
    else render(setup);
  }
}
async function recoverActionFailure(message) {
  try {
    render(await request('setup'));
    status.textContent = `${message} ${setup.state === 'configuring' ? 'Inspect inputs again.' : 'Check the current session before retrying.'}`;
  } catch {
    sessionUnconfirmed = true;
    if (setup) {
      syncSettingsActions(setup);
      renderExactPreview(setup);
      syncPracticeDraftControls();
      setReviewBusy(true);
      renderGuide(setup);
    }
    status.textContent = `${message} Session status unavailable; inspect actual targets and reload before retrying.`;
  }
  status.tabIndex = -1;
  status.focus();
}
initSave({
  request,
  getSetup: () => setup,
  refresh,
  recover: recoverActionFailure,
  hasDraft: hasUnsavedReviewDraft,
  isBlocked: () =>
    sessionUnconfirmed || practiceBusy || Boolean(pending()) || settingsRequestActive(),
  setPracticeBusy: (value) => {
    practiceBusy = value;
    if (value) invalidateReportSelection();
    if (setup) {
      syncReviewAvailability(setup);
      renderGuide(setup);
    }
  },
});
const saveReviewer = document.getElementById('save-reviewer');
saveReviewer.addEventListener('input', () => syncReviewAvailability(setup));
function preview(path) {
  if (setup.analysis?.pendingReviews && !saveReviewer.value.trim()) {
    status.textContent = 'Enter a reviewer name for pending decisions.';
    saveReviewer.focus();
    return;
  }
  return practiceAction(path, {
    reviewedBy: saveReviewer.value,
    configurationRevision: setup.configurationRevision,
    contentRevision: setup.contentRevision,
  });
}
previewButton.addEventListener('click', () => void preview('preview'));
attestation.addEventListener('submit', (event) => {
  event.preventDefault();
  if (
    checkPendingSettings() ||
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    !setup.preview ||
    !attestation.elements.responsibility.checked
  )
    return;
  void practiceAction('attest', {
    configurationRevision: setup.configurationRevision,
    contentRevision: setup.contentRevision,
    reviewContentHash: setup.preview.reviewContentHash,
    reviewedBy: attestation.elements.reviewedBy.value,
    reviewReason: attestation.elements.reviewReason.value,
    responsibility: true,
  });
});
initReportControls(request, () => setup, recoverActionFailure, token, checkPendingSettings);
document
  .getElementById('practice-preview')
  .addEventListener('click', () => void preview('practice/preview'));
if (!token) {
  status.textContent = 'Open the printed local URL, including its session token after #.';
  document.getElementById('guide-next').textContent = 'Open the printed session URL to begin.';
} else {
  try {
    render(await request('setup'), true);
    if (setup.activeOperationId || setup.testingDatabase) await pollEvidence();
  } catch (error) {
    status.textContent = error.message;
    document.getElementById('guide-next').textContent =
      'Session unavailable. Reload before continuing.';
  }
}
