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
import { createEstimateRefresh, olderSetup } from './estimate-refresh.js';
import { createStageNavigation, renderSetupContext, trackActionFocus } from './guide.js';
import { createPaidControls } from './paid-controls.js';
import {
  createAutomaticPreview,
  initAttestation,
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
import {
  pendingSettings,
  roleConnectionDrafts,
  stageSettingsActions,
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
const paid = document.getElementById('paid');
const stop = document.getElementById('stop');
const inspection = document.getElementById('inspection');
const databaseTest = document.getElementById('database-test');
const applySettings = document.getElementById('apply-settings');
const databaseSettings = document.getElementById('database-settings');
const settingsActionsHelp = document.getElementById('settings-actions-help');
let setup;
let dirty = '';
let applyingSettings = false;
let practiceBusy = false;
let estimateRefresh;
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
const saveReviewer = document.getElementById('save-reviewer');
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
    !estimateRefresh.running &&
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
const evidenceChanges = () => pending('ai');
const saveChanges = () => pending('save');

function settingsRequestActive(next = setup) {
  return (
    estimateRefresh.running || applyingSettings || draftDatabase.running || next?.testingDatabase
  );
}

function workbenchBusy(next) {
  return (
    practiceBusy ||
    Boolean(analysisProgress.starting) ||
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    Boolean(next.activeOperationId) ||
    ['inspecting', 'analyzing', 'previewing', 'saving', 'exporting', 'reconfiguring'].includes(
      next.state
    )
  );
}

const syncRoleActions = stageSettingsActions(
  form,
  drafts,
  (next) => workbenchBusy(next) || settingsRequestActive(next),
  () => {
    draftDatabase.syncFields(appliedConnection());
    checkPendingSettings();
    render(setup);
  }
);
const stages = createStageNavigation(form, {
  getSetup,
  pushStage,
  draftStatus: draftDatabase.draftStatus,
  onVisit: observer.refresh,
  syncRoleActions,
  onStage: visitStage,
  hasAiDraft: () => Boolean(pending('ai')) || estimateRefresh.blocked,
});
const paidControls = createPaidControls(getSetup, syncSettingsActions, start, selectRerun);
estimateRefresh = createEstimateRefresh({
  getSetup,
  read: drafts.readDraft,
  restoreAi: (next) => drafts.restore('ai', next),
  dirty: evidenceChanges,
  request,
  render: (next) => render(next, false, undefined, true),
  available: () => !workbenchBusy(setup) && !settingsRequestActive() && !hasUnsavedReviewDraft(),
  sync: syncSessionControls,
});
function syncSettingsActions(next) {
  const busy = workbenchBusy(next);
  syncSettingsFields(
    form,
    (busy && (!observer.observingOperation || drafts.loading)) || applyingSettings,
    next.practice
  );
  const blocked = busy || settingsRequestActive(next);
  syncRoleActions(next, stages.current);
  const actions = evidenceActions(
    next,
    blocked,
    { load: loadChanges(), analysis: evidenceChanges(), source: form.elements.source.value },
    hasUnsavedReviewDraft()
  );
  paidControls.update(next, actions.analyze && !estimateRefresh.blocked, estimateRefresh.message());
  inspect.disabled =
    !actions.inspect || (form.elements.source.value === 'database' && drafts.conflicted('source'));
  inspection.hidden = !next.inspected;
  inspection.textContent = inspectionSummary(next, evidenceChanges());
}

const renderGuide = (next) => stages.update(next);
function syncSessionControls() {
  syncSettingsActions(setup);
  syncReviewAvailability(setup);
  renderGuide(setup);
}
const captureFocus = trackActionFocus();
const operationFocus = trackOperationFocus(captureFocus, status);

const previewFlags = () => ({
  dirty: saveChanges(),
  practiceBusy,
  sessionUnconfirmed,
  settingsBusy: settingsRequestActive(),
});
const schedulePreview = createAutomaticPreview(
  getSetup,
  saveReviewer,
  () =>
    stages.current === 'save' &&
    !saveChanges() &&
    !workbenchBusy(setup) &&
    !settingsRequestActive() &&
    !practiceBusy &&
    !hasUnsavedReviewDraft(),
  practiceAction
);
function visitStage(stage) {
  schedulePreview(true);
  if (stage === 'save' && setup?.analysis?.pendingReviews && !saveReviewer.value.trim())
    saveReviewer.focus();
}
const renderExactPreview = (next) => updateExactPreview(next, previewFlags());
const syncPracticeDraftControls = () => updatePracticeDraftControls(setup, previewFlags());

function syncReviewAvailability(next) {
  schedulePreview();
  renderExactPreview(next);
  renderSave(next);
  syncPracticeDraftControls();
  setReviewBusy(
    workbenchBusy(next) || practiceBusy || settingsRequestActive(next),
    Boolean(evidenceChanges()) || estimateRefresh.edited
  );
}

function checkPendingSettings() {
  const changes = pending();
  if (changes !== dirty) {
    dirty = changes;
    syncSessionControls();
  }
  return Boolean(changes);
}

initReview(
  request,
  (body) => request('review/draft', 'POST', body),
  () => {
    if (!setup) return;
    estimateRefresh.schedule();
    syncSessionControls();
  },
  selectRerun,
  (next) => render(next, false, undefined, true),
  () => stages.navigate('ai')
);
async function selectRerun(body) {
  const next = await estimateRefresh.select(body);
  status.textContent = reassessmentStatus(body, next.paidEstimate);
  return next;
}
function render(raw, populate = false, accepted, passive = false) {
  if (olderSetup(setup, raw)) return;
  observer.remember(raw);
  const next = withTabSaveOutcome(raw, setup);
  sessionUnconfirmed = false;
  if (setup?.loadRevision !== next.loadRevision || setup?.contentRevision !== next.contentRevision)
    form.elements.discardReviewedState.checked = false;
  drafts.refresh(setup, next, populate, accepted, estimateRefresh.rebase(next));
  setup = next;
  if (!passive || !hasUnsavedReviewDraft()) updateReview(next, !passive);
  draftDatabase.syncFields(appliedConnection());
  form.hidden = false;
  renderSetupContext(form, next, drafts.readDraft());
  dirty = pending();
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
  schedulePreview();
  estimateRefresh.schedule();
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
  syncSessionControls();
});
form.addEventListener('input', (event) => {
  if (event.target.closest('label')?.dataset.stage === 'ai') {
    paidControls.resetConsent();
    estimateRefresh.change(event.target.name);
  }
  draftDatabase.syncFields(appliedConnection());
  if (databaseSettings.contains(event.target)) {
    draftDatabase.invalidate();
    renderGuide(setup);
  }
  if (stages.current === 'load' && event.target !== form.elements.discardReviewedState) {
    drafts.rejectLoad();
    form.elements.discardReviewedState.checked = false;
  }
  checkPendingSettings();
  renderSetupContext(form, setup, drafts.readDraft());
});
form.addEventListener('change', (event) => {
  checkPendingSettings();
  if (event.target === form.elements.source) syncSettingsActions(setup);
});
document.addEventListener('focusin', checkPendingSettings);
document.addEventListener('pointerdown', checkPendingSettings, true);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (stages.current === 'load') return start('inspect');
  if (stages.current !== 'save') return;
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
  if (hasUnsavedReviewDraft() || (kind === 'inspect' ? inspect.disabled : paid.disabled)) return;
  if (
    !setup ||
    workbenchBusy(setup) ||
    settingsRequestActive() ||
    (kind === 'inspect' ? !stages.validate() : evidenceChanges())
  )
    return;
  const body = paidBody ?? {
    operationId: crypto.randomUUID(),
    configurationRevision: setup.configurationRevision,
    ...drafts.discardConfirmation(),
  };
  if (kind === 'inspect') body.sourceSettings = drafts.submitLoad(body.operationId);
  operationFocus.start(body.operationId);
  const begin = async () => {
    await request(kind, 'POST', body);
    await refresh();
  };
  try {
    await analysisProgress.start(kind, begin, pollEvidence);
  } catch (error) {
    if (sessionUnconfirmed) return;
    if (kind === 'inspect' && error.requestRejected) drafts.rejectLoad(body.operationId);
    status.dataset.state = 'error';
    status.textContent = error.message;
    operationFocus.fail();
    if (kind !== 'inspect') analysisProgress.update(setup, error.message);
    if (kind === 'paid' && error.requestRejected) paidControls.resetReceipt();
  }
}
inspect.addEventListener('click', () => start('inspect'));
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
    status.textContent = 'Wait for the row edit to be kept in this session.';
    return;
  }
  practiceBusy = true;
  syncSettingsActions(setup);
  invalidateReportSelection();
  renderExactPreview(setup);
  setReviewBusy(true);
  renderGuide(setup);
  let failure;
  renderSave(setup);
  syncPracticeDraftControls();
  try {
    render(await request(path, 'POST', body));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    practiceBusy = false;
    setReviewBusy(false);
    renderGuide(setup);
    if (failure) await recoverActionFailure(failure, path.endsWith('preview'));
    else render(setup);
  }
}
async function recoverActionFailure(message, previewFailure = false) {
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
  if (previewFailure && stages.current === 'save' && setup && !setup.preview) {
    document.getElementById(
      setup.practice ? 'practice-preview-result' : 'preview-result'
    ).textContent = `Preview failed: ${message} Check the settings, then return to Save to retry.`;
  }
  if (!previewFailure) status.focus();
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
saveReviewer.addEventListener('input', () => syncReviewAvailability(setup));
initAttestation(
  getSetup,
  practiceAction,
  () => saveChanges() || sessionUnconfirmed || saveStatusUnconfirmed()
);
initReportControls(request, getSetup, recoverActionFailure, token, saveChanges);
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
