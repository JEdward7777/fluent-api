import { createDraftDatabaseTest } from './database-test.js';
import { renderGuide as updateGuide } from './guide.js';
import {
  initReportControls,
  renderExactPreview as updateExactPreview,
  syncPracticeDraftControls as updatePracticeDraftControls,
} from './preview-ui.js';
import { hasUnsavedReviewDraft, initReview, setReviewBusy, updateReview } from './review.js';
import { initSave, renderSave, saveStatusUnconfirmed } from './save.js';

const launchedToken = window.location.hash.slice(1);
if (launchedToken) window.sessionStorage.setItem('license-workbench-token', launchedToken);
const token = launchedToken || window.sessionStorage.getItem('license-workbench-token');
window.history.replaceState(null, '', window.location.pathname + window.location.search);
const status = document.getElementById('status');
const form = document.getElementById('setup');
const inspect = document.getElementById('inspect');
const analyze = document.getElementById('analyze');
const stop = document.getElementById('stop');
const inspection = document.getElementById('inspection');
const databaseTest = document.getElementById('database-test');
const applySettings = document.getElementById('apply-settings');
const databaseSettings = document.getElementById('database-settings');
const settingsActionsHelp = document.getElementById('settings-actions-help');
let setup;
let dirty = false;
let applyingSettings = false;
let practiceBusy = false;
let sessionUnconfirmed = false;
const previewButton = document.getElementById('normal-preview-button');
const attestation = document.getElementById('attestation');
const reportTarget = document.getElementById('report-target');
const draftDatabase = createDraftDatabaseTest(
  form,
  request,
  confirmTestRevision,
  updateDraftControls
);

function settingsRequestActive(next = setup) {
  return applyingSettings || draftDatabase.running || next?.testingDatabase;
}

function workbenchBusy(next) {
  return (
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
  inspect.disabled =
    blocked || dirty || !next.readyForInspect || !['configuring', 'error'].includes(next.state);
  analyze.disabled = blocked || dirty || next.state !== 'inspected';
}

const renderGuide = (next) => updateGuide(next, { dirty, practiceBusy, sessionUnconfirmed });

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
  if (populate) {
    for (const key of [
      'source',
      'destination',
      'input',
      'output',
      'model',
      'cacheDir',
      'reportFormats',
      'reportDir',
    ])
      form.elements[key].value = next[key] ?? '';
    form.elements.samples.value = next.sampleCount;
    for (const key of ['force', 'noCache']) form.elements[key].checked = next[key];
    form.elements.preserve.checked = next.preserveExistingNonUnknowns;
    form.elements.databaseMode.value = next.databaseConnection.mode;
    if (next.databaseConnection.mode === 'session') {
      for (const [control, key] of [
        ['databaseHost', 'host'],
        ['databasePort', 'port'],
        ['databaseName', 'database'],
        ['databaseUsername', 'username'],
        ['databaseTls', 'tls'],
      ])
        form.elements[control].value = next.databaseConnection[key];
    }
    form.elements.databasePassword.value = '';
    form.elements.databaseClearPassword.checked = false;
    dirty = false;
  }
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
  inspection.hidden = !next.inspected;
  if (next.inspected) {
    const preflight = next.inspected.preflight;
    inspection.textContent = `Inspected ${next.inspected.inspectedAt}. ${preflight.distinctKeys} distinct keys; ${preflight.tableHits} saved decisions (${preflight.savedEvidenceReuse} complete saved model assessments reused); ${preflight.ruleHits} rule matches; ${preflight.modelKeys} model keys. ${preflight.validCacheHits} valid cache hits; ${preflight.expectedUncachedRequests} expected uncached requests, up to ${preflight.maximumAttempts} attempts. ${preflight.rows.map((row) => `${row.normalizedText}: ${row.action} (${row.reason}${row.ruleMatches ? '; rule match' : '; rule nonmatch'})`).join(' | ')} Cost unavailable: ${preflight.cost.reason}`;
  }
  if (next.state === 'uncertain')
    status.textContent =
      'Save outcome uncertain. Inspect actual targets before starting a new process.';
  else if (!next.practice && next.state === 'saved')
    status.textContent = 'Save completed. See the written paths, hashes and policy result below.';
  else if (next.practice && next.state === 'saved')
    status.textContent = `Incomplete practice JSON saved to ${next.preview?.output}. Discard the scratch directory when finished.`;
  else if (next.analysis)
    status.textContent = next.practice
      ? `Practice analysis ready: ${next.analysis.rows} rows. Review the evidence below, then save only to scratch.`
      : `Analysis ready: ${next.analysis.rows} rows. Review the evidence below before previewing changes.`;
  else if (next.state === 'inspected')
    status.textContent = 'Inputs inspected. Review the request estimate, then start analysis.';
  else if (next.latestOperation?.state === 'failed')
    status.textContent = next.latestOperation.error;
  else if (busy) status.textContent = `${next.state}… Reloading keeps the operation.`;
  else if (dirty) status.textContent = 'Settings changed. Apply settings before inspecting.';
  else
    status.textContent = next.readyForInspect
      ? 'Settings ready. Click Inspect inputs.'
      : 'Choose settings and click Apply settings.';
  const practiceReview = document.getElementById('practice-review');
  practiceReview.hidden = !next.practice || !next.analysis;
  syncReviewAvailability(next);
  renderGuide(next);
}
async function refresh() {
  render(await request('setup'));
  if (setup.activeOperationId) {
    const operation = await request(`operations/${encodeURIComponent(setup.activeOperationId)}`);
    if (operation.state === 'running') window.setTimeout(refresh, 800);
    else render(await request('setup'));
  } else if (setup.testingDatabase && !draftDatabase.running) window.setTimeout(refresh, 800);
}
form.addEventListener('input', (event) => {
  draftDatabase.syncFields(setup?.databaseConnection);
  if (databaseSettings.contains(event.target)) draftDatabase.invalidate();
  dirty = true;
  if (setup) {
    syncSettingsActions(setup);
    syncReviewAvailability(setup);
    renderGuide(setup);
  }
  status.textContent = 'Settings changed. Apply settings before inspecting.';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!setup || workbenchBusy(setup) || settingsRequestActive()) return;
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
      status.textContent = 'Check the discard box before replacing reviewed decisions.';
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
        source: values.source.value || null,
        destination: values.destination.value || null,
        input: values.input.value,
        output: values.output.value,
        model: values.model.value,
        sampleCount: Number(values.samples.value),
        cacheDir: values.cacheDir.value || null,
        reportFormats: values.reportFormats.value,
        reportDir: values.reportDir.value || null,
        force: values.force.checked,
        noCache: values.noCache.checked,
        preserveExistingNonUnknowns: values.preserve.checked,
        databaseConnection: draftDatabase.read(),
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
  if (sessionUnconfirmed || saveStatusUnconfirmed() || settingsRequestActive()) return;
  try {
    await request(kind, 'POST', {
      operationId: crypto.randomUUID(),
      configurationRevision: setup.configurationRevision,
    });
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
}
inspect.addEventListener('click', () => start('inspect'));
analyze.addEventListener('click', () => start('analysis'));
stop.addEventListener('click', async () => {
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
    dirty ||
    settingsRequestActive()
  )
    return;
  if (hasUnsavedReviewDraft()) {
    status.textContent = 'Apply or discard the open row edit before previewing or saving.';
    return;
  }
  practiceBusy = true;
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
async function recoverActionFailure(message, report = false) {
  try {
    render(await request('setup'));
    status.textContent = `${message} ${setup.state === 'configuring' ? 'Inspect inputs again.' : 'Check the current session before retrying.'}`;
    if (report && setup.preview)
      reportTarget.textContent = `${message} Inspect the actual report target before retrying.`;
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
  isBlocked: () => sessionUnconfirmed || practiceBusy || dirty || settingsRequestActive(),
  setPracticeBusy: (value) => {
    practiceBusy = value;
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
    dirty ||
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
initReportControls(request, () => setup, recoverActionFailure, token);
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
    if (setup.activeOperationId || setup.testingDatabase) await refresh();
  } catch (error) {
    status.textContent = error.message;
    document.getElementById('guide-next').textContent =
      'Session unavailable. Reload before continuing.';
  }
}
