import { createAnalysisProgress, workflowStatus } from './analysis-progress.js';
import { createDraftDatabaseTest } from './database-test.js';
import { renderGuide as updateGuide } from './guide.js';
import {
  renderExactPreview as updateExactPreview,
  syncPracticeDraftControls as updatePracticeDraftControls,
} from './preview-ui.js';
import { initReportControls, invalidateReportSelection } from './report-controls.js';
import { hasUnsavedReviewDraft, initReview, setReviewBusy, updateReview } from './review.js';
import { initSave, renderSave, saveStatusUnconfirmed } from './save.js';
import { pendingSettings, populateSettings, readSettings } from './settings-draft.js';

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
const readDraft = () => readSettings(form, draftDatabase.read());
const pending = () => (setup ? pendingSettings(setup, readDraft()) : '');

function showPending(changes) {
  dirty = changes;
  settingsChangeStatus.textContent = dirty
    ? `Pending settings changes: ${dirty}. Restore applied settings to keep the current review.`
    : '';
}

function settingsRequestActive(next = setup) {
  return applyingSettings || draftDatabase.running || next?.testingDatabase;
}

function workbenchBusy(next) {
  return (
    analysisProgress.starting ||
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    Boolean(next.activeOperationId) ||
    ['inspecting', 'analyzing', 'previewing', 'saving', 'exporting', 'reconfiguring'].includes(
      next.state
    )
  );
}

function syncSettingsActions(next) {
  const blocked = workbenchBusy(next) || settingsRequestActive(next);
  databaseTest.disabled = blocked || next.practice || next.state === 'uncertain';
  applySettings.disabled = blocked;
  restoreSettings.disabled = blocked;
  inspect.disabled =
    blocked || dirty || !next.readyForInspect || !['configuring', 'error'].includes(next.state);
  analyze.disabled = blocked || dirty || next.state !== 'inspected';
}

const renderGuide = (next) =>
  updateGuide(next, {
    dirty,
    practiceBusy,
    sessionUnconfirmed,
    startingAnalysis: analysisProgress.starting,
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
  setReviewBusy(
    sessionUnconfirmed ||
      saveStatusUnconfirmed() ||
      practiceBusy ||
      settingsRequestActive(next) ||
      Boolean(next.activeOperationId)
  );
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
  if (!response.ok) throw new Error(await response.text());
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
      renderExactPreview(setup);
      renderSave(setup);
      renderGuide(setup);
    }
  },
  async (body) => {
    const next = await request('review/rerun', 'POST', body);
    render(next, true);
    status.textContent =
      'Row reassessment selected. Inspect to review exact rule and model request estimates before Analyze.';
  }
);
function render(next, populate = false) {
  sessionUnconfirmed = false;
  if (next.configurationRevision !== setup?.configurationRevision) draftDatabase.invalidate();
  setup = next;
  updateReview(next);
  if (populate) populateSettings(form, next);
  draftDatabase.syncFields(setup?.databaseConnection);
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
    : `Analysis uses the inspected eligibility plan${next.inspected?.preflight.modelKeys ? ` and may make ${next.inspected.preflight.expectedUncachedRequests} uncached model requests` : ' without model requests'}; it does not publish policy or artifacts.`;
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
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  document.getElementById('cli-command').textContent = [
    'npm run db:classify:licenses -- --ui=cli',
    ...(next.source ? [`--source=${quote(next.source)}`] : []),
    ...(next.destination ? [`--destination=${quote(next.destination)}`] : []),
    `--input=${quote(next.input)}`,
    `--output=${quote(next.output)}`,
    `--model=${quote(next.model)}`,
    `--sample-count=${next.sampleCount}`,
    `--report-formats=${quote(next.reportFormats)}`,
    ...(next.reportDir ? [`--report-dir=${quote(next.reportDir)}`] : []),
    ...(next.cacheDir ? [`--cache-dir=${quote(next.cacheDir)}`] : []),
    ...(next.noCache ? ['--no-cache'] : []),
    ...(next.force ? ['--force'] : []),
    ...(next.preserveExistingNonUnknowns ? ['--preserve-existing-non-unknowns'] : []),
  ].join(' ');
  const busy = workbenchBusy(next);
  for (const field of form.elements) field.disabled = busy;
  syncSettingsActions(next);
  databaseTest.hidden = next.practice;
  settingsActionsHelp.hidden = next.practice;
  if (next.practice) {
    document.getElementById('database-settings').hidden = true;
    for (const key of [
      'source',
      'destination',
      'output',
      'model',
      'samples',
      'force',
      'noCache',
      'cacheDir',
      'reportFormats',
      'reportDir',
      'preserve',
    ])
      form.elements[key].disabled = true;
    form.elements.input.placeholder = 'Bundled example or an absolute saved JSON path';
  }
  stop.hidden = next.state !== 'analyzing';
  stop.disabled = next.state !== 'analyzing';
  analysisProgress.update(next);
  inspection.hidden = !next.inspected;
  if (next.inspected) {
    const preflight = next.inspected.preflight;
    inspection.textContent = `Inspected ${next.inspected.inspectedAt}. ${preflight.distinctKeys} distinct keys; ${preflight.tableHits} saved decisions (${preflight.savedEvidenceReuse} complete saved model assessments reused); ${preflight.ruleHits} rule matches; ${preflight.modelKeys} model keys. ${preflight.validCacheHits} valid cache hits; ${preflight.expectedUncachedRequests} expected uncached requests, up to ${preflight.maximumAttempts} attempts. ${preflight.rows.map((row) => `${row.normalizedText}: ${row.action} (${row.reason}${row.ruleMatches ? '; rule match' : '; rule nonmatch'})`).join(' | ')} Cost unavailable: ${preflight.cost.reason}`;
  }
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
    if (operation.state === 'running')
      window.setTimeout(operation.kind === 'analysis' ? pollAnalysis : refresh, 800);
    else render(await request('setup'));
  } else if (setup.testingDatabase && !draftDatabase.running) window.setTimeout(refresh, 800);
}
async function pollAnalysis() {
  try {
    await refresh();
  } catch {
    sessionUnconfirmed = true;
    stop.disabled = true;
    const message = 'Analysis status is unavailable. Reload to check the result.';
    analysisProgress.update(setup, message);
    status.textContent = message;
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    renderGuide(setup);
  }
}
form.addEventListener('input', (event) => {
  draftDatabase.syncFields(setup?.databaseConnection);
  if (databaseSettings.contains(event.target)) draftDatabase.invalidate();
  checkPendingSettings();
});
form.addEventListener('change', checkPendingSettings);
document.addEventListener('focusin', checkPendingSettings);
document.addEventListener('pointerdown', checkPendingSettings, true);
restoreSettings.addEventListener('click', () => {
  if (!setup || restoreSettings.disabled) return;
  populateSettings(form, setup);
  draftDatabase.syncFields(setup.databaseConnection);
  draftDatabase.invalidate();
  checkPendingSettings();
  status.textContent = 'Applied settings restored.';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!setup || workbenchBusy(setup) || settingsRequestActive() || !checkPendingSettings()) return;
  try {
    if (hasUnsavedReviewDraft()) {
      status.textContent = 'Apply or discard the open row edit before changing settings.';
      status.tabIndex = -1;
      status.focus();
      return;
    }
    const values = form.elements;
    const discardReviewedState = Boolean(setup.analysis && values.discardReviewedState.checked);
    if (setup.analysis && !discardReviewedState) {
      status.textContent =
        'Restore applied settings to keep this review. To replace its settings, check Discard unsaved review and apply.';
      return;
    }
    applyingSettings = true;
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    status.textContent = 'Applying settings…';
    render(
      await request('setup', 'POST', {
        configurationRevision: setup.configurationRevision,
        discardReviewedState,
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
async function confirmTestRevision(revision) {
  try {
    const latest = await request('setup');
    if (latest.configurationRevision === revision) {
      render(latest);
      return true;
    }
    status.textContent = 'Review settings changed while testing. Reload before applying settings.';
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
  void draftDatabase.run(setup.configurationRevision);
});
async function start(kind) {
  if (!setup || workbenchBusy(setup) || settingsRequestActive() || checkPendingSettings()) return;
  const begin = async () => {
    await request(kind, 'POST', {
      operationId: crypto.randomUUID(),
      configurationRevision: setup.configurationRevision,
    });
    await refresh();
  };
  try {
    if (kind === 'analysis') await analysisProgress.start(begin, pollAnalysis);
    else await begin();
  } catch (error) {
    if (sessionUnconfirmed) return;
    status.textContent = error.message;
    if (kind === 'analysis') analysisProgress.update(setup, error.message);
  }
}
inspect.addEventListener('click', () => start('inspect'));
analyze.addEventListener('click', () => start('analysis'));
stop.addEventListener('click', async () => {
  if (stop.disabled || sessionUnconfirmed) return;
  try {
    await request('stop', 'POST');
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
    if (setup) renderExactPreview(setup);
    setReviewBusy(value);
    if (setup) syncPracticeDraftControls();
    if (setup) renderGuide(setup);
  },
  render,
});
previewButton.addEventListener('click', () => {
  void practiceAction('preview', {
    configurationRevision: setup.configurationRevision,
    contentRevision: setup.contentRevision,
  });
});
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
document.getElementById('practice-preview').addEventListener('click', () => {
  void practiceAction('practice/preview', {
    configurationRevision: setup.configurationRevision,
    contentRevision: setup.contentRevision,
  });
});
if (!token) {
  status.textContent = 'Open the printed local URL, including its session token after #.';
  document.getElementById('guide-next').textContent = 'Open the printed session URL to begin.';
} else {
  try {
    render(await request('setup'), true);
    if (setup.activeOperationId && setup.latestOperation?.kind === 'analysis') await pollAnalysis();
    else if (setup.activeOperationId || setup.testingDatabase) await refresh();
  } catch (error) {
    status.textContent = error.message;
    document.getElementById('guide-next').textContent =
      'Session unavailable. Reload before continuing.';
  }
}
