import { hasUnsavedReviewDraft } from './review.js';
import { saveStatusUnconfirmed } from './save.js';

export function renderGuide(next, { dirty, practiceBusy, sessionUnconfirmed }) {
  document.getElementById('guide-settings-effect').textContent = next.practice
    ? ' Practice has a preset source and destination. You can change the input path; click Apply settings if you do. Applying does not read the input.'
    : ' Choose a source and destination. Click Apply settings if you change the form; it records your choices without reading inputs.';
  document.getElementById('guide-analyze-effect').textContent = next.practice
    ? ' It uses saved JSON evidence without a model request.'
    : next.source === 'json'
      ? ' It uses saved JSON evidence without a model request or policy write.'
      : ' It may call Gemini and write request cache, but does not save policy or artifacts.';
  document.getElementById('guide-preview-effect').textContent = next.practice
    ? ' It shows the exact incomplete scratch JSON without changing the source.'
    : ' It checks and shows the exact changes without saving them.';
  document.getElementById('guide-preview-action').textContent = next.practice
    ? 'Click Preview scratch output.'
    : 'Click Preview current revision.';
  document.getElementById('guide-save-action').textContent = next.practice
    ? 'Click Save incomplete scratch JSON.'
    : 'Click Save reviewed changes.';
  document.getElementById('guide-save-effect').textContent = next.practice
    ? ' It writes only incomplete JSON to private scratch; it does not update the source or database.'
    : ' It writes the exact previewed JSON and any selected policy changes after required agreements.';

  let step;
  let message;
  if (sessionUnconfirmed || saveStatusUnconfirmed() || next.state === 'uncertain') {
    message =
      'Next: Check the session and actual targets before another action. See the status below.';
  } else if (
    next.activeOperationId ||
    practiceBusy ||
    ['inspecting', 'analyzing', 'previewing', 'saving', 'exporting', 'reconfiguring'].includes(
      next.state
    )
  ) {
    message = 'Current operation is running. Wait for its result; reloading keeps the operation.';
  } else if (hasUnsavedReviewDraft()) {
    step = 'review';
    message = 'Next: Apply or discard the open row edit before previewing or saving.';
  } else if (dirty) {
    step = 'settings';
    message = next.analysis
      ? 'Next: Check Discard unsaved review, then click Apply settings to replace these settings.'
      : 'Next: Click Apply settings to record your changed choices.';
  } else if (next.state === 'saved') {
    message = next.practice
      ? 'Done: Incomplete JSON was saved to private scratch. See its path below.'
      : 'Done: Save completed. See the written paths and policy result below.';
  } else if (next.state === 'previewed' && next.preview?.incomplete && next.preview?.replace) {
    step = 'preview';
    message =
      'Next: Complete the review attestation below, then preview the changed revision again.';
  } else if (next.state === 'previewed') {
    step = 'save';
    message = next.practice
      ? 'Next: Click Save incomplete scratch JSON to write only the private scratch copy.'
      : 'Next: Check any required replacement agreement, then click Save reviewed changes.';
  } else if (next.analysis) {
    step = 'review';
    message = next.practice
      ? 'Next: Review the evidence below, then click Preview scratch output.'
      : 'Next: Review the evidence below, then click Preview current revision.';
  } else if (next.state === 'inspected') {
    step = 'analyze';
    message = 'Next: Check the inspection estimate, then click Start analysis.';
  } else if (next.readyForInspect) {
    step = 'inspect';
    message = 'Next: Click Inspect inputs. Apply settings first only if you change the form.';
  } else {
    step = 'settings';
    message = 'Next: Choose the required settings and click Apply settings.';
  }
  for (const item of document.querySelectorAll('.guide-list li')) {
    if (item.id === `guide-${step}`) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  document.getElementById('guide-next').textContent = message;
}
