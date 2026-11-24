import { licenseWorkbenchPreviewLines } from './preview-text.js';
import { renderReportControls } from './report-controls.js';
import { hasUnsavedReviewDraft } from './review.js';
import { saveStatusUnconfirmed } from './save.js';

const normalPreview = document.getElementById('normal-preview');
const previewButton = document.getElementById('normal-preview-button');
const previewResult = document.getElementById('preview-result');
export function renderExactPreview(
  next,
  { dirty, practiceBusy, sessionUnconfirmed, settingsBusy }
) {
  normalPreview.hidden = next.practice || (!next.analysis && !next.saveOutcome);
  const blocked = hasUnsavedReviewDraft() || sessionUnconfirmed || saveStatusUnconfirmed() || dirty;
  renderReportControls(next, blocked || practiceBusy || settingsBusy);
  if (normalPreview.hidden) return;
  previewButton.disabled =
    blocked ||
    practiceBusy ||
    settingsBusy ||
    Boolean(next.activeOperationId) ||
    !['reviewing', 'previewed'].includes(next.state);
  const attestation = document.getElementById('attestation');
  attestation.hidden =
    !next.preview || next.preview.review?.status === 'ready' || next.state !== 'previewed';
  for (const element of attestation.elements)
    element.disabled = blocked || practiceBusy || settingsBusy || Boolean(next.activeOperationId);
  const preview = next.preview;
  if (blocked) {
    previewResult.textContent = sessionUnconfirmed
      ? 'Session status is unavailable. Reload before any preview, attestation or export.'
      : saveStatusUnconfirmed()
        ? 'Save acknowledgment is unresolved. Inspect actual targets before another mutation.'
        : dirty
          ? `Pending settings changes: ${dirty}. Restore applied settings to keep the current review, or apply the changes and inspect again.`
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

export function syncPracticeDraftControls(
  setup,
  { dirty, practiceBusy, sessionUnconfirmed, settingsBusy }
) {
  if (!setup?.practice || !setup.analysis) return;
  const blocked = hasUnsavedReviewDraft();
  const busy =
    sessionUnconfirmed ||
    saveStatusUnconfirmed() ||
    dirty ||
    practiceBusy ||
    settingsBusy ||
    Boolean(setup.activeOperationId);
  document.getElementById('practice-preview').disabled = blocked || busy || setup.state === 'saved';
  document.getElementById('practice-save').disabled = blocked || busy || !setup.preview;
  document.getElementById('practice-preview-result').textContent = blocked
    ? 'Apply this row edit or use Back to results to discard it before previewing or saving.'
    : setup.preview
      ? `Scratch output: ${setup.preview.output}. SHA-256: ${setup.preview.wholeFileHash}. This remains incomplete and carries no practice attestation.`
      : 'Preview the exact edited revision before saving.';
}
