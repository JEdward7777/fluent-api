import {
  createAnalysisProgress,
  createEvidencePolling,
  evidenceActions,
  inspectionSummary,
  trackOperationFocus,
  watchSession,
  workflowStatus,
} from './analysis-progress.js';
import { createDraftDatabaseTest } from './database-test.js';
import { createStageNavigation, renderSetupContext, trackActionFocus } from './guide.js';
import { createPaidControls } from './paid-controls.js';
import {
  renderExactPreview as updateExactPreview,
  syncPracticeDraftControls as updatePracticeDraftControls,
} from './preview-ui.js';
import { initReportControls, invalidateReportSelection } from './report-controls.js';
import { reassessmentStatus } from './review-rerun.js';
import {
  hasUnsavedReviewDraft,
  initReview,
  pushStage,
  setReviewBusy,
  updateReview,
} from './review.js';
import { initSave, renderSave, saveStatusUnconfirmed, withTabSaveOutcome } from './save.js';
import { pendingSettings, roleConnectionDrafts, syncSettingsFields } from './settings-draft.js';

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

const getSetup = () => setup;
const fetchApi = (path, options) => fetch(`./api/${path}`, options);
const observer = watchSession(
  fetchApi,
  token,
  (next) => render(next, false, undefined, true),
  mayObserve
);
const { request } = observer;
const previewButton = document.getElementById('normal-preview-button');
const attestation = document.getElementById('attestation');
const draftDatabase = createDraftDatabaseTest(
  form,
  request,
  confirmTestRevision,
  updateDraftControls,
  (role) => setup?.[`${role}DatabaseTest`]
);

const analysisProgress = createAnalysisProgress(getSetup, render, () => sessionUnconfirmed);
function mayObserve() {
  return (
    setup &&
    !applyingSettings &&
    !practiceBusy &&
    !sessionUnconfirmed &&
    !saveStatusUnconfirmed() &&
    !analysisProgress.starting &&
    !draftDatabase.running
  );
}
const drafts = roleConnectionDrafts(form, draftDatabase, getSetup, checkPendingSettings);
const { appliedConnection, pending } = drafts;
const loadChanges = () => pending('load');
const evidenceChanges = () => pending('load', 'ai');
const saveChanges = () => pending('load', 'save');

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

const stages = createStageNavigation(form, {
  getSetup,
  pushStage,
  draftStatus: draftDatabase.draftStatus,
  onVisit: observer.refresh,
  syncRoleActions,
  hasAiDraft: () => Boolean(pending('ai')),
});
const paidControls = createPaidControls(getSetup, syncSettingsActions, start);
function syncSettingsActions(next) {
  const busy = workbenchBusy(next);
  syncSettingsFields(
    form,
    (busy && !observer.observingOperation) || applyingSettings,
    next.practice
  );
  const blocked = busy || settingsRequestActive(next);
  syncRoleActions(next, stages.current);
  restoreSettings.disabled = blocked;
  const actions = evidenceActions(
    next,
    blocked,
    { load: loadChanges(), analysis: evidenceChanges() },
    hasUnsavedReviewDraft()
  );
  paidControls.update(next, actions.analyze);
  inspect.disabled = !actions.inspect;
  analyze.disabled = !actions.analyze;
  inspection.hidden = !next.inspected;
  inspection.textContent = inspectionSummary(next, evidenceChanges());
}

function syncRoleActions(next, stage) {
  const blocked = workbenchBusy(next) || settingsRequestActive(next);
  databaseTest.disabled =
    blocked || drafts.conflicted(drafts.role) || next.practice || next.state === 'uncertain';
  const role = stage === 'load' ? 'source' : stage === 'save' ? 'destination' : null;
  const conflicted =
    role && ['database', 'both'].includes(form.elements[role].value) && drafts.conflicted(role);
  applySettings.disabled = blocked || conflicted;
  const changes = pending(stage);
  settingsChangeStatus.textContent = conflicted
    ? drafts.conflict
    : changes
      ? `Pending settings changes: ${changes}. Apply or restore this stage’s settings.`
      : '';
}
const renderGuide = (next) => stages.update(next);
const captureFocus = trackActionFocus();
const operationFocus = trackOperationFocus(captureFocus, status);

const previewFlags = () => ({
  dirty: saveChanges(),
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
  setReviewBusy(
    workbenchBusy(next) || practiceBusy || settingsRequestActive(next),
    Boolean(evidenceChanges())
  );
}

function checkPendingSettings() {
  const changes = pending();
  if (changes !== dirty) {
    dirty = changes;
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    renderGuide(setup);
  }
  return Boolean(changes);
}

initReview(
  request,
  async (body) => {
    return request('review/draft', 'POST', body);
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
    if (evidenceChanges())
      throw new Error('Apply or restore source and AI settings before reassessment.');
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
    if (!evidenceChanges()) status.textContent = reassessmentStatus(body, next.paidEstimate);
    return next;
  },
  (next) => render(next, false, undefined, true)
);
function render(raw, populate = false, accepted, passive = false) {
  observer.remember(raw);
  const next = withTabSaveOutcome(raw, setup);
  sessionUnconfirmed = false;
  if (setup?.loadRevision !== next.loadRevision || setup?.contentRevision !== next.contentRevision)
    form.elements.discardReviewedState.checked = false;
  drafts.refresh(setup, next, populate, accepted);
  setup = next;
  if (!passive || !hasUnsavedReviewDraft()) updateReview(next, !passive);
  draftDatabase.syncFields(appliedConnection());
  form.hidden = false;
  renderSetupContext(form, next);
  dirty = pending();
  document.getElementById('discard-label').hidden = !next.analysis;
  const busy = workbenchBusy(next);
  syncSettingsActions(next);
  databaseTest.hidden = next.practice;
  settingsActionsHelp.hidden = next.practice;
  if (next.practice) {
    document.getElementById('database-settings').hidden = true;
    form.elements.input.required = false;
    form.elements.input.placeholder = 'Bundled example or an absolute saved JSON path';
  }
  stop.hidden = next.state !== 'analyzing';
  stop.disabled =
    next.state !== 'analyzing' || Boolean(next.latestOperation?.progress?.stopRequested);
  analysisProgress.update(next);
  status.dataset.state = busy
    ? 'busy'
    : next.latestOperation?.state === 'failed' || next.state === 'uncertain'
      ? 'error'
      : 'ready';
  status.textContent = workflowStatus(next, { busy, dirty, starting: analysisProgress.starting });
  const practiceReview = document.getElementById('practice-review');
  practiceReview.hidden = !next.practice || !next.analysis;
  syncReviewAvailability(next);
  renderGuide(next);
  if (!analysisProgress.starting) operationFocus.observe(next.latestOperation);
}
const { refresh, pollEvidence } = createEvidencePolling(getSetup, request, render, () => {
  sessionUnconfirmed = true;
  stop.disabled = true;
  const message = 'Operation status is unavailable. Reload to check the result.';
  analysisProgress.update(setup, message);
  status.dataset.state = 'error';
  status.textContent = message;
  operationFocus.fail();
  syncSettingsActions(setup);
  syncReviewAvailability(setup);
  renderGuide(setup);
});
form.addEventListener('input', (event) => {
  draftDatabase.syncFields(appliedConnection());
  if (databaseSettings.contains(event.target)) {
    draftDatabase.invalidate();
    renderGuide(setup);
  }
  checkPendingSettings();
});
form.addEventListener('change', checkPendingSettings);
document.addEventListener('focusin', checkPendingSettings);
document.addEventListener('pointerdown', checkPendingSettings, true);
restoreSettings.addEventListener('click', () => {
  if (!setup || restoreSettings.disabled) return;
  drafts.restore(stages.current);
  draftDatabase.syncFields(appliedConnection());
  checkPendingSettings();
  renderGuide(setup);
  status.textContent = 'Applied settings restored for this stage.';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!setup || applySettings.disabled || !checkPendingSettings() || !stages.validate()) return;
  const focusError = captureFocus();
  try {
    if (hasUnsavedReviewDraft()) {
      status.textContent = 'Apply or discard the open row edit before changing settings.';
      status.focus();
      return;
    }
    const submission = drafts.stageSubmission(stages.current);
    if (!pendingSettings(setup, submission.body)) {
      status.textContent = 'This stage already uses the applied settings.';
      return;
    }
    applyingSettings = true;
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    status.textContent = 'Applying settings…';
    render(await request('setup', 'POST', submission.body), false, submission);
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = error.message;
    focusError(status);
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
  renderGuide(setup);
  syncSettingsActions(setup);
  syncReviewAvailability(setup);
  if (setup.testingDatabase && !draftDatabase.running && !sessionUnconfirmed)
    window.setTimeout(refresh, 800);
}

databaseTest.addEventListener('click', async () => {
  if (!setup || databaseTest.disabled || settingsRequestActive()) return;
  const focusError = captureFocus();
  focusError(
    await draftDatabase.run(setup[`${drafts.role}Revision`], drafts.role, appliedConnection())
  );
});
async function start(kind, paidBody) {
  if (hasUnsavedReviewDraft() || (kind === 'inspect' ? inspect.disabled : analyze.disabled)) return;
  if (
    !setup ||
    workbenchBusy(setup) ||
    settingsRequestActive() ||
    (kind === 'inspect' ? loadChanges() : evidenceChanges())
  )
    return;
  const body = paidBody ?? {
    operationId: crypto.randomUUID(),
    configurationRevision: setup.configurationRevision,
    ...drafts.discardConfirmation(),
  };
  operationFocus.start(body.operationId);
  const begin = async () => {
    await request(kind, 'POST', body);
    await refresh();
  };
  try {
    await analysisProgress.start(kind, begin, pollEvidence);
  } catch (error) {
    if (sessionUnconfirmed) return;
    status.dataset.state = 'error';
    status.textContent = error.message;
    operationFocus.fail();
    if (kind !== 'inspect') analysisProgress.update(setup, error.message);
    if (kind === 'paid' && error.requestRejected) paidControls.resetReceipt();
  }
}
inspect.addEventListener('click', () => start('inspect'));
analyze.addEventListener('click', () => start('analysis'));
stop.addEventListener('click', async () => {
  if (stop.disabled || sessionUnconfirmed) return;
  const focusError = captureFocus();
  try {
    await request('stop', 'POST');
    stop.disabled = true;
    status.textContent = 'Stop requested after the current key.';
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = error.message;
    focusError(status);
  }
});
async function practiceAction(path, body) {
  if (
    practiceBusy ||
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    saveChanges() ||
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
  status.focus();
}
initSave({
  request,
  getSetup,
  refresh,
  recover: recoverActionFailure,
  hasDraft: hasUnsavedReviewDraft,
  isBlocked: () =>
    sessionUnconfirmed || practiceBusy || Boolean(saveChanges()) || settingsRequestActive(),
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
    saveChanges() ||
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
initReportControls(request, getSetup, recoverActionFailure, token, saveChanges);
document
  .getElementById('practice-preview')
  .addEventListener('click', () => void preview('practice/preview'));
if (!token) {
  status.textContent = 'Open the printed local URL, including its session token after #.';
} else {
  try {
    render(await request('setup'), true);
    if (setup.activeOperationId || setup.testingDatabase) await pollEvidence();
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = error.message;
  }
}
