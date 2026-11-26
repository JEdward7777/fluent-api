import {
  jsonDecisionCounts,
  licenseWorkbenchPreviewLines,
  previewFingerprints,
} from './preview-text.js';
import { invalidateReportSelection, renderReportControls } from './report-controls.js';
import { hasUnsavedReviewDraft } from './review.js';
import { syncSaveChanges } from './save-changes.js';
import { reviewerMatchesPreview, saveStatusUnconfirmed, saveSubmitting } from './save.js';

const normalPreview = document.getElementById('normal-preview');

const previewResult = document.getElementById('preview-result');
export function renderExactPreview(
  next,
  { dirty, practiceBusy, sessionUnconfirmed, settingsBusy, savedViewBusy, readiness }
) {
  normalPreview.hidden = next.practice || (!next.analysis && !next.saveOutcome);
  const blocked = hasUnsavedReviewDraft() || sessionUnconfirmed || saveStatusUnconfirmed() || dirty;
  const viewBlocked = blocked || practiceBusy || !reviewerMatchesPreview(next);
  const unavailable = viewBlocked || settingsBusy || (readiness && next.state !== 'saved');
  const receipt = next.sessionSave;
  const sameSave =
    receipt?.state === 'succeeded' &&
    receipt.result?.previewToken === next.preview?.token &&
    receipt.configurationRevision === next.configurationRevision &&
    receipt.operationId === next.saveOutcome?.operationId;
  const readable =
    !next.practice &&
    !next.activeOperationId &&
    !next.sourceChanged &&
    (next.preview?.saved
      ? sameSave && !viewBlocked && !savedViewBusy
      : next.state === 'previewed' && !unavailable);
  const viewToken = readable ? next.preview?.token : undefined;
  renderReportControls(next, unavailable, viewToken);
  syncSaveChanges(viewToken, next.preview?.conflicts.length);
  const technical = document.getElementById('preview-technical');
  technical.hidden = !next.preview || unavailable || !['saved', 'previewed'].includes(next.state);
  if (!technical.hidden)
    document.getElementById('preview-hashes').textContent = previewFingerprints(next);
  if (normalPreview.hidden) return;
  const attestation = document.getElementById('attestation');
  document.getElementById('assertion-section').hidden =
    !next.preview ||
    Boolean(next.analysis?.pendingReviews) ||
    next.preview.review?.status === 'ready' ||
    next.state !== 'previewed';
  for (const element of attestation.elements)
    element.disabled = Boolean(unavailable || next.activeOperationId);
  const preview = next.preview;
  if (blocked) {
    previewResult.textContent = sessionUnconfirmed
      ? 'Session status is unavailable. Reload before any preview, attestation or export.'
      : saveStatusUnconfirmed()
        ? 'Save acknowledgment is unresolved. Inspect actual targets before another mutation.'
        : dirty
          ? `Updating destination settings: ${dirty}.`
          : 'Waiting for the row edit to be kept in this session.';
    return;
  }
  if (unavailable || next.state !== 'previewed' || !preview) {
    previewResult.textContent = readiness || previewMessage(next, practiceBusy);
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
  { dirty, practiceBusy, sessionUnconfirmed, settingsBusy, readiness }
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
    Boolean(readiness) ||
    setup.state !== 'previewed' ||
    !setup.preview ||
    Boolean(setup.preview.conflicts?.length) ||
    !reviewerMatchesPreview(setup);
  const progress = document.getElementById('practice-preview-result');
  const writing = setup.state === 'saving' || saveSubmitting();
  progress.dataset.busy = String(writing || readiness === 'Preparing preview…');
  progress.textContent = writing
    ? 'Saving…'
    : readiness ||
      (blocked
        ? 'Waiting for the row edit to be kept in this session.'
        : setup.state === 'previewed' &&
            setup.preview &&
            reviewerMatchesPreview(setup) &&
            !practiceBusy
          ? `Scratch output: ${setup.preview.output}. ${jsonDecisionCounts(setup.preview.json)} ${setup.preview.reviewer ? `Pending decisions: ${setup.preview.reviewer}, ${setup.preview.reviewedAt}.` : 'No pending decisions to attribute.'} This remains incomplete and carries no practice attestation.`
          : previewMessage(setup, practiceBusy));
}

function previewMessage(setup, busy) {
  if (busy) return 'Preparing the current revision…';
  if (setup.state === 'uncertain') return 'Check the actual Save targets before continuing.';
  if (setup.state === 'saved') return 'See the completed Save receipt.';
  if (!setup.destination && !setup.practice) return 'Choose a destination.';
  if (setup.analysis?.pendingReviews && !document.getElementById('save-reviewer').value.trim())
    return 'Enter the reviewer name to preview pending decisions.';
  return 'Waiting for a current preview.';
}

function createAutomaticPreview(getSetup, field, available, prepare) {
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
      setup.stateRevision,
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
        expectedPreviewToken: setup.preview?.token ?? null,
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

export function createSavePreview({
  getSetup,
  form,
  field,
  saveSettings,
  saveChanges,
  request,
  render,
  sync,
  available,
  unconfirmed,
  testing,
  estimating,
  recover,
}) {
  let previewError = '';
  let previewPending = false;
  let busy = false;
  let previewEdit = 0;
  let retryingSave = '';
  let lastToken;
  function saveFailure(next) {
    return next.sessionSave?.state === 'failed' &&
      next.sessionSave.operationId !== retryingSave &&
      !next.preview &&
      next.sessionSave.configurationRevision === next.configurationRevision &&
      next.sessionSave.contentRevision === next.contentRevision
      ? next.sessionSave.error
      : '';
  }
  function saveReadiness(next) {
    if (next.state === 'uncertain')
      return 'Check actual Save targets to resolve the previous Save.';
    if (unconfirmed()) return 'Session status is unavailable. Reload to check the current Save.';
    if (saveStatusUnconfirmed()) return 'Checking the previous Save acknowledgment.';
    if (!next.analysis) return 'Load a source before saving.';
    if (next.sourceChanged) return 'Compare the changed source with your session below.';
    if (hasUnsavedReviewDraft()) return 'Wait for the current row edit to be kept.';
    const settingsError = saveSettings.message();
    if (settingsError) return settingsError;
    if (!form.elements.destination.value && !next.practice) return 'Choose a destination.';
    if (next.analysis.pendingReviews && !field.value.trim())
      return 'Enter the reviewer name for pending decisions.';
    if (previewError) return previewError;
    if (saveFailure(next)) return saveFailure(next);
    if (next.activeOperationId && next.state !== 'saving')
      return 'Wait for the current session operation.';
    if (testing() || next.testingDatabase) return 'Wait for the connection test.';
    if (estimating()) return 'Wait for the request estimate.';
    if (next.state === 'saved' && !saveChanges()) return 'Save completed.';
    if (
      saveChanges() ||
      saveSettings.running ||
      previewPending ||
      !next.preview ||
      next.preview.reviewer !== (next.analysis.pendingReviews ? field.value.trim() : '')
    )
      return 'Preparing preview…';
    return '';
  }

  const schedulePreview = createAutomaticPreview(
    getSetup,
    field,
    () =>
      available() &&
      !busy &&
      !previewError &&
      !saveFailure(getSetup()) &&
      !saveChanges() &&
      !hasUnsavedReviewDraft(),
    action
  );
  const retries = [
    document.getElementById('retry-preview'),
    document.getElementById('retry-practice-preview'),
  ];
  for (const retry of retries)
    retry.addEventListener('click', () => {
      previewError = '';
      retryingSave = getSetup().sessionSave?.operationId;
      schedulePreview(true);
      sync();
    });
  function change() {
    previewEdit++;
    previewError = '';
  }
  field.addEventListener('input', () => {
    change();
    sync();
  });
  async function action(path, body) {
    if (!available() || busy || saveChanges() || hasUnsavedReviewDraft()) return;
    const isPreview = path.endsWith('preview');
    const edit = previewEdit;
    busy = true;
    previewPending = isPreview;
    invalidateReportSelection();
    sync();
    try {
      const result = await request(path, 'POST', body);
      if (isPreview) {
        const current = await request('setup');
        render(current);
        if (
          edit === previewEdit &&
          result.preview &&
          current.preview?.token !== result.preview.token
        )
          previewError =
            'The preview changed in another tab. Check the current destination and reviewer.';
      } else render(result);
    } catch (error) {
      await recover(error.message, isPreview);
      if (isPreview && edit === previewEdit) previewError = `Preview failed: ${error.message}`;
    } finally {
      busy = false;
      previewPending = false;
      sync();
    }
  }
  return {
    get pending() {
      return previewPending;
    },
    get busy() {
      return busy;
    },
    get blocked() {
      return Boolean(previewError);
    },
    change,
    invalidate(message) {
      previewError = message;
      sync();
    },
    action,
    reason: saveReadiness,
    schedule(reset) {
      const next = getSetup();
      const show = (previewError || saveFailure(next)) && !next.sourceChanged && next.analysis;
      for (const retry of retries) {
        retry.hidden = !show;
        retry.disabled = !available();
      }
      schedulePreview(reset);
    },
    rebase(setup, next) {
      if (
        setup?.loadRevision !== next.loadRevision ||
        setup?.configurationRevision !== next.configurationRevision ||
        setup?.contentRevision !== next.contentRevision
      )
        previewError = '';
      if (
        !previewPending &&
        setup?.loadRevision === next.loadRevision &&
        next.preview &&
        lastToken !== next.preview.token &&
        next.analysis?.pendingReviews &&
        field.value.trim() !== next.preview.reviewer
      )
        previewError =
          'The reviewer changed in another tab. Check the name and prepare the preview again.';
      if (next.preview || setup?.loadRevision !== next.loadRevision)
        lastToken = next.preview?.token;
    },
  };
}
