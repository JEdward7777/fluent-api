import { licenseWorkbenchPreviewLines } from './preview-text.js';
import { hasUnsavedReviewDraft } from './review.js';
import { saveStatusUnconfirmed } from './save.js';

const normalPreview = document.getElementById('normal-preview');
const previewButton = document.getElementById('normal-preview-button');
const previewResult = document.getElementById('preview-result');
const reportExport = document.getElementById('report-export');
const reportPath = document.getElementById('report-path');
const reportFormat = document.getElementById('report-format');
const reportTarget = document.getElementById('report-target');
const reportWrite = document.getElementById('report-write');
const reportOverwrite = document.getElementById('report-overwrite');
let reportPlan = null;

function clearReportPlan() {
  reportPlan = null;
  reportTarget.textContent = 'Inspect the selected target path before export.';
  reportWrite.disabled = true;
  document.getElementById('report-agreement').hidden = true;
  reportOverwrite.checked = false;
}

export function renderExactPreview(next, { dirty, practiceBusy, sessionUnconfirmed }) {
  normalPreview.hidden = next.practice || (!next.analysis && !next.saveOutcome);
  if (normalPreview.hidden) return;
  const blocked = hasUnsavedReviewDraft() || sessionUnconfirmed || saveStatusUnconfirmed() || dirty;
  previewButton.disabled =
    blocked ||
    practiceBusy ||
    Boolean(next.activeOperationId) ||
    !['reviewing', 'previewed'].includes(next.state);
  const attestation = document.getElementById('attestation');
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

export function syncPracticeDraftControls(setup, { dirty, practiceBusy, sessionUnconfirmed }) {
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

export function initReportControls(request, getSetup, recoverActionFailure) {
  for (const control of [reportPath, reportFormat])
    control.addEventListener('input', clearReportPlan);
  document.getElementById('report-inspect').addEventListener('click', async () => {
    const setup = getSetup();
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
}
