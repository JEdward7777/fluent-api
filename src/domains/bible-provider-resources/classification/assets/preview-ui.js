import { jsonDecisionCounts, licenseWorkbenchPreviewLines } from './preview-text.js';
import { renderReportControls } from './report-controls.js';
import { hasUnsavedReviewDraft } from './review.js';
import { reviewerMatchesPreview, saveStatusUnconfirmed } from './save.js';

const normalPreview = document.getElementById('normal-preview');

const previewResult = document.getElementById('preview-result');
export function renderExactPreview(
  next,
  { dirty, practiceBusy, sessionUnconfirmed, settingsBusy }
) {
  normalPreview.hidden = next.practice || (!next.analysis && !next.saveOutcome);
  const blocked = hasUnsavedReviewDraft() || sessionUnconfirmed || saveStatusUnconfirmed() || dirty;
  renderReportControls(
    next,
    blocked || practiceBusy || settingsBusy || !reviewerMatchesPreview(next)
  );
  if (normalPreview.hidden) return;
  const attestation = document.getElementById('attestation');
  document.getElementById('assertion-section').hidden =
    !next.preview ||
    Boolean(next.analysis?.pendingReviews) ||
    next.preview.review?.status === 'ready' ||
    next.state !== 'previewed';
  for (const element of attestation.elements)
    element.disabled = blocked || practiceBusy || settingsBusy || Boolean(next.activeOperationId);
  const preview = next.preview;
  if (blocked) {
    previewResult.textContent = sessionUnconfirmed
      ? 'Session status is unavailable. Reload before any preview, attestation or export.'
      : saveStatusUnconfirmed()
        ? 'Save acknowledgment is unresolved. Inspect actual targets before another mutation.'
        : dirty
          ? `Pending settings changes: ${dirty}. Apply the source or destination changes on their stage, or restore settings on the affected stage.`
          : 'Waiting for the row edit to be kept in this session.';
    return;
  }
  if (next.state !== 'previewed' || !preview || !reviewerMatchesPreview(next) || practiceBusy) {
    previewResult.textContent = previewMessage(next, practiceBusy);
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

  document.getElementById('practice-save').disabled =
    blocked ||
    busy ||
    setup.state !== 'previewed' ||
    !setup.preview ||
    Boolean(setup.preview.conflicts?.length) ||
    !reviewerMatchesPreview(setup);
  document.getElementById('practice-preview-result').textContent = blocked
    ? 'Waiting for the row edit to be kept in this session.'
    : setup.state === 'previewed' && setup.preview && reviewerMatchesPreview(setup) && !practiceBusy
      ? `Scratch output: ${setup.preview.output}. ${jsonDecisionCounts(setup.preview.json)} ${setup.preview.reviewer ? `Pending decisions: ${setup.preview.reviewer}, ${setup.preview.reviewedAt}.` : 'No pending decisions to attribute.'} SHA-256: ${setup.preview.wholeFileHash}. This remains incomplete and carries no practice attestation.`
      : previewMessage(setup, practiceBusy);
}

function previewMessage(setup, busy) {
  if (busy) return 'Preparing the current revision…';
  if (setup.state === 'uncertain') return 'Check the actual Save targets before continuing.';
  if (setup.state === 'saved') return 'See the completed Save receipt.';
  if (!setup.destination && !setup.practice) return 'Choose and apply a destination.';
  if (setup.analysis?.pendingReviews && !document.getElementById('save-reviewer').value.trim())
    return 'Enter the reviewer name to preview pending decisions.';
  return 'Waiting for a current preview.';
}

export function createAutomaticPreview(getSetup, field, available, prepare) {
  let timer;
  let attempted = '';
  return (reset = false) => {
    clearTimeout(timer);
    if (reset) attempted = '';
    const setup = getSetup();
    if (
      !setup?.analysis ||
      !available() ||
      setup.sourceChanged ||
      !['inspected', 'reviewing', 'previewed'].includes(setup.state) ||
      (!setup.practice &&
        (!setup.destination || (['json', 'both'].includes(setup.destination) && !setup.output)))
    )
      return;
    const reviewedBy = setup.analysis.pendingReviews ? field.value.trim() : '';
    const { configurationRevision, contentRevision } = setup;
    const key = JSON.stringify([
      configurationRevision,
      contentRevision,
      reviewedBy,
      setup.sessionSave?.state === 'failed'
        ? [setup.sessionSave.operationId, setup.sessionSave.reconciliation?.outcome]
        : null,
    ]);
    if (
      (!reset && setup.preview?.reviewer === reviewedBy) ||
      (setup.analysis.pendingReviews && !reviewedBy)
    ) {
      attempted = key;
      return;
    }
    if (attempted === key) return;
    const start = () => {
      attempted = key;
      void prepare(setup.practice ? 'practice/preview' : 'preview', {
        reviewedBy,
        configurationRevision,
        contentRevision,
      });
    };
    if (reset) start();
    else timer = setTimeout(start, 250);
  };
}

export function initAttestation(getSetup, prepare, blocked) {
  const attestation = document.getElementById('attestation');
  attestation.addEventListener('submit', (event) => {
    event.preventDefault();
    const setup = getSetup();
    if (blocked() || !setup.preview || !attestation.elements.responsibility.checked) return;
    void prepare('attest', {
      configurationRevision: setup.configurationRevision,
      contentRevision: setup.contentRevision,
      reviewContentHash: setup.preview.reviewContentHash,
      reviewedBy: attestation.elements.reviewedBy.value,
      reviewReason: attestation.elements.reviewReason.value,
      responsibility: true,
    });
  });
}
