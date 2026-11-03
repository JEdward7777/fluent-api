import { renderGuide as updateGuide } from './guide.js';
import { licenseWorkbenchPreviewLines } from './preview-text.js';
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
let setup;
let dirty = false;
let practiceBusy = false;
let sessionUnconfirmed = false;
const normalPreview = document.getElementById('normal-preview');
const previewButton = document.getElementById('normal-preview-button');
const previewResult = document.getElementById('preview-result');
const attestation = document.getElementById('attestation');
const reportExport = document.getElementById('report-export');
const reportPath = document.getElementById('report-path');
const reportFormat = document.getElementById('report-format');
const reportTarget = document.getElementById('report-target');
const reportWrite = document.getElementById('report-write');
const reportOverwrite = document.getElementById('report-overwrite');
let reportPlan = null;

const renderGuide = (next) => updateGuide(next, { dirty, practiceBusy, sessionUnconfirmed });

function clearReportPlan() {
  reportPlan = null;
  reportTarget.textContent = 'Inspect the selected target path before export.';
  reportWrite.disabled = true;
  document.getElementById('report-agreement').hidden = true;
  reportOverwrite.checked = false;
}

function renderExactPreview(next) {
  normalPreview.hidden = next.practice || (!next.analysis && !next.saveOutcome);
  if (normalPreview.hidden) return;
  const blocked = hasUnsavedReviewDraft() || sessionUnconfirmed || saveStatusUnconfirmed() || dirty;
  previewButton.disabled =
    blocked ||
    practiceBusy ||
    Boolean(next.activeOperationId) ||
    !['reviewing', 'previewed'].includes(next.state);
  attestation.hidden =
    !next.preview || next.preview.review?.status === 'ready' || next.state !== 'previewed';
  for (const element of attestation.elements)
    element.disabled = blocked || practiceBusy || Boolean(next.activeOperationId);
  const preview = next.preview;
  if (
    reportPlan &&
    (reportPlan.contentRevision !== next.contentRevision ||
      reportPlan.configurationRevision !== next.configurationRevision ||
      reportPlan.path !== reportPath.value ||
      reportPlan.format !== reportFormat.value ||
      !preview)
  )
    clearReportPlan();
  reportExport.hidden = !preview;
  document.getElementById('report-inspect').disabled =
    blocked || practiceBusy || Boolean(next.activeOperationId) || !preview;
  reportWrite.disabled = blocked || practiceBusy || Boolean(next.activeOperationId) || !reportPlan;
  if (blocked) {
    previewResult.textContent = sessionUnconfirmed
      ? 'Session status is unavailable. Reload before any preview, attestation or export.'
      : saveStatusUnconfirmed()
        ? 'Save acknowledgment is unresolved. Inspect actual targets before another mutation.'
        : dirty
          ? 'Apply settings and inspect again before preview, attestation or Save.'
          : 'Apply this row edit or discard it before preview or attestation.';
    return;
  }
  if (!preview) {
    previewResult.textContent =
      'No current preview. Review edits and attestation require a fresh preview.';
    return;
  }
  const lines = licenseWorkbenchPreviewLines(next);
  previewResult.replaceChildren(
    ...lines.filter(Boolean).map((line) => {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      return paragraph;
    })
  );
}

function syncPracticeDraftControls() {
  if (!setup?.practice || !setup.analysis) return;
  const blocked = hasUnsavedReviewDraft();
  const busy =
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    dirty ||
    practiceBusy ||
    Boolean(setup.activeOperationId);
  document.getElementById('practice-preview').disabled = blocked || busy || setup.state === 'saved';
  document.getElementById('practice-save').disabled = blocked || busy || !setup.preview;
  document.getElementById('practice-preview-result').textContent = blocked
    ? 'Apply this row edit or use Back to results to discard it before previewing or saving.'
    : setup.preview
      ? `Scratch output: ${setup.preview.output}. SHA-256: ${setup.preview.wholeFileHash}. This remains incomplete and carries no practice attestation.`
      : 'Preview the exact edited revision before saving.';
}

async function request(path, method = 'GET', body) {
  const response = await fetch(`./api/${path}`, {
    method,
    headers: {
      'x-workbench-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
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
  }
);
function render(next, populate = false) {
  sessionUnconfirmed = false;
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
    dirty = false;
  }
  form.hidden = false;
  document.getElementById('practice-banner').hidden = !next.practice;
  document.getElementById('cli-details').hidden = next.practice;
  document.getElementById('operations-heading').textContent = next.practice
    ? 'Workflow modes'
    : 'What the selections mean';
  document.getElementById('alternatives-note').textContent = next.practice
    ? 'Practice uses saved JSON → scratch JSON. Database targets require a separate normal workbench launch.'
    : 'Both writes file and database targets. Ordinary sync propagates policy later. A nonempty table needs force and reviewed attestation before replacement.';
  document.getElementById('inspect-help').textContent = next.practice
    ? 'Inspect reads the selected saved JSON or bundled example and copies it into a new private scratch directory. No model or database is used.'
    : 'Inspect reads selected files, database and request cache as needed.';
  document.getElementById('analysis-help').textContent = next.practice
    ? 'Practice analysis uses saved JSON evidence without model requests.'
    : 'Analysis may call Gemini and write cache; it does not publish policy or artifacts.';
  if (next.practice) {
    for (const key of ['output', 'cacheDir', 'reportDir', 'reportFormats'])
      form.elements[key].value = next[key] ?? '';
    document.getElementById('practice-location').textContent = next.scratch
      ? `Scratch: ${next.scratch}. Original SHA-256: ${next.originalHash}. Restart with --practice for a fresh session; discard this directory when finished. Practice output is never imported into a real session automatically.`
      : 'Scratch is allocated after Inspect. Restart with --practice for a fresh session; discard the scratch directory when finished. Practice output is never imported into a real session automatically.';
  }
  document.getElementById('discard-label').hidden = !next.analysis;
  document.getElementById('database-target').textContent = next.databaseTarget;
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
  const busy =
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    Boolean(next.activeOperationId) ||
    ['inspecting', 'analyzing', 'previewing', 'saving', 'exporting', 'reconfiguring'].includes(
      next.state
    );
  for (const field of form.elements) field.disabled = busy;
  if (next.practice) {
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
  inspect.disabled =
    busy ||
    dirty ||
    !next.readyForInspect ||
    (next.state !== 'configuring' && next.state !== 'error');
  analyze.disabled = busy || dirty || next.state !== 'inspected';
  stop.hidden = next.state !== 'analyzing';
  stop.disabled = next.state !== 'analyzing';
  inspection.hidden = !next.inspected;
  if (next.inspected) {
    const preflight = next.inspected.preflight;
    inspection.textContent = `Inspected ${next.inspected.inspectedAt}. ${preflight.distinctKeys} distinct keys; ${preflight.tableHits} table hits; ${preflight.ruleHits} rule hits; ${preflight.modelKeys} model keys. ${preflight.validCacheHits} valid cache hits; ${preflight.expectedUncachedRequests} expected requests, up to ${preflight.maximumAttempts} attempts. Cost unavailable: ${preflight.cost.reason}`;
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
  else
    status.textContent = next.readyForInspect
      ? 'Settings ready. Click Inspect inputs.'
      : 'Choose settings and click Apply settings.';
  const practiceReview = document.getElementById('practice-review');
  practiceReview.hidden = !next.practice || !next.analysis;
  renderExactPreview(next);
  renderSave(next);
  syncPracticeDraftControls();
  renderGuide(next);
  setReviewBusy(
    sessionUnconfirmed || saveStatusUnconfirmed() || practiceBusy || Boolean(next.activeOperationId)
  );
}
async function refresh() {
  render(await request('setup'));
  if (setup.activeOperationId) {
    const operation = await request(`operations/${encodeURIComponent(setup.activeOperationId)}`);
    if (operation.state === 'running') window.setTimeout(refresh, 800);
    else render(await request('setup'));
  }
}
form.addEventListener('input', () => {
  dirty = true;
  inspect.disabled = true;
  analyze.disabled = true;
  if (setup) {
    renderExactPreview(setup);
    renderSave(setup);
    syncPracticeDraftControls();
    renderGuide(setup);
  }
  status.textContent = 'Settings changed. Apply settings before inspecting.';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
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
      }),
      true
    );
  } catch (error) {
    status.textContent = error.message;
  }
});
async function start(kind) {
  if (sessionUnconfirmed || saveStatusUnconfirmed()) return;
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
  if (practiceBusy || sessionUnconfirmed || saveStatusUnconfirmed() || dirty) return;
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
  isBlocked: () => sessionUnconfirmed || practiceBusy || dirty,
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
for (const control of [reportPath, reportFormat])
  control.addEventListener('input', clearReportPlan);
document.getElementById('report-inspect').addEventListener('click', async () => {
  if (hasUnsavedReviewDraft() || !setup.preview) return;
  try {
    reportPlan = await request('report/inspect', 'POST', {
      configurationRevision: setup.configurationRevision,
      contentRevision: setup.contentRevision,
      format: reportFormat.value,
      path: reportPath.value,
    });
    reportTarget.textContent = `${reportPlan.path}: ${reportPlan.existed ? `existing, SHA-256 ${reportPlan.priorHash}` : 'new file'}. This target was inspected for this revision.`;
    document.getElementById('report-agreement').hidden = !reportPlan.existed;
    reportWrite.disabled = false;
  } catch (error) {
    clearReportPlan();
    await recoverActionFailure(error instanceof Error ? error.message : String(error), true);
  }
});
reportWrite.addEventListener('click', async () => {
  if (!reportPlan || hasUnsavedReviewDraft()) return;
  if (reportPlan.existed && !reportOverwrite.checked) {
    reportTarget.textContent = 'Agree to overwrite the existing report separately from Save.';
    reportOverwrite.focus();
    return;
  }
  const plan = reportPlan;
  reportWrite.disabled = true;
  try {
    const result = await request('report/export', 'POST', {
      planId: plan.id,
      operationId: crypto.randomUUID(),
      agreeToOverwrite: reportOverwrite.checked,
    });
    reportTarget.textContent = `Exported ${result.format} report to ${result.path}. This did not Save policy or JSON.`;
    reportPlan = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clearReportPlan();
    await recoverActionFailure(message, true);
  }
});
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
    if (setup.activeOperationId) await refresh();
  } catch (error) {
    status.textContent = error.message;
    document.getElementById('guide-next').textContent =
      'Session unavailable. Reload before continuing.';
  }
}
