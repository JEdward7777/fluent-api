const panel = document.getElementById('normal-save');
const button = document.getElementById('normal-save-button');
const agreement = document.getElementById('save-replacement-agreement');
const agreementLabel = document.getElementById('save-replacement');
const receiptKey = 'license-workbench-save-receipt';
let request;
let getSetup;
let refresh;
let recover;
let hasDraft;
let isBlocked;
let pending = null;
let previewIdentity = '';
let submitting = false;
let practiceSavePending = null;
let practiceSaving = false;
let setPracticeBusy;
const storageKey = 'license-workbench-pending-save';
let unresolved = false;
let checking = false;

function syncSaveReviewer(setup, next) {
  const reviewerField = document.getElementById('save-reviewer');
  if (setup?.loadRevision !== next.loadRevision) reviewerField.value = next.preview?.reviewer ?? '';
  document.getElementById('save-reviewer-label').hidden = !next.analysis?.pendingReviews;
}

export function reviewerMatchesPreview(setup) {
  return (
    !setup.analysis?.pendingReviews ||
    setup.preview?.reviewer === document.getElementById('save-reviewer').value.trim()
  );
}

function storedPending(setup, key = storageKey) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) || 'null');
    if (saved?.launchId === setup.launchId) return saved;
    if (saved) window.sessionStorage.removeItem(key);
  } catch {
    window.sessionStorage.removeItem(key);
  }
  return null;
}

function remember(setup, kind, body) {
  window.sessionStorage.removeItem(receiptKey);
  window.sessionStorage.setItem(
    storageKey,
    JSON.stringify({ launchId: setup.launchId, kind, body })
  );
}

function forget(operationId, setup = getSetup()) {
  if (pending?.operationId === operationId) pending = null;
  if (practiceSavePending?.operationId === operationId) practiceSavePending = null;
  if (storedPending(setup)?.body.operationId === operationId) {
    window.sessionStorage.removeItem(storageKey);
    unresolved = false;
  }
}

function recordOutcome(setup, operation) {
  if (storedPending(setup)?.body.operationId !== operation.operationId) return;
  window.sessionStorage.setItem(
    receiptKey,
    JSON.stringify({ launchId: setup.launchId, operation })
  );
  forget(operation.operationId, setup);
}

// A missing operation is conclusive only after this particular POST was definitively rejected.
function settleMissingOperation(setup, id, lookup) {
  const saved = storedPending(setup);
  if (lookup.status !== 404 || saved?.body.operationId !== id || !saved.rejection) return false;
  recordOutcome(setup, { operationId: id, state: 'rejected', error: saved.rejection });
  return true;
}

export function withTabSaveOutcome(setup, previous) {
  syncSaveReviewer(previous, setup);
  const saved = storedPending(setup);
  if (!saved) {
    unresolved = false;
    const receipt = storedPending(setup, receiptKey);
    return receipt ? { ...setup, saveOutcome: receipt.operation } : setup;
  }
  if (setup.saveOutcome?.operationId === saved.body.operationId) {
    if (setup.saveOutcome.state !== 'running') recordOutcome(setup, setup.saveOutcome);
    unresolved = false;
    return setup;
  }
  unresolved = true;
  if (!checking) {
    checking = true;
    void request(`operations/${encodeURIComponent(saved.body.operationId)}`)
      .then(
        (operation) => {
          if (operation.kind !== 'save' || operation.operationId !== saved.body.operationId) return;
          if (operation.state !== 'running') recordOutcome(setup, operation);
          return refresh();
        },
        (lookup) => {
          if (settleMissingOperation(setup, saved.body.operationId, lookup)) return refresh();
        }
      )
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }
  return { ...setup, saveOutcome: null };
}

export function saveStatusUnconfirmed() {
  return unresolved;
}

export function initSave(dependencies) {
  ({ request, getSetup, refresh, recover, hasDraft, isBlocked, setPracticeBusy } = dependencies);
  document.getElementById('practice-save').addEventListener('click', () => void practiceSave());
  agreement.addEventListener('change', () => renderSave(getSetup()));
  button.addEventListener('click', () => void startSave());
}

export function renderSave(setup) {
  if (!setup) return;
  panel.hidden = setup.practice || (!setup.preview && !setup.saveOutcome);
  const result = document.getElementById('save-result');
  result.hidden = !setup.saveOutcome && !unresolved && (setup.practice || !setup.preview);
  if (result.hidden) return;
  const preview = setup.preview;
  const identity = preview ? preview.token : '';
  if (previewIdentity !== identity) {
    previewIdentity = identity;
    agreement.checked = false;
  }
  agreementLabel.hidden = !preview?.requiresForceAgreement;
  agreement.disabled = Boolean(setup.activeOperationId) || isBlocked();
  const hasConflict = Boolean(preview?.conflicts?.length);
  button.disabled =
    submitting ||
    Boolean(setup.activeOperationId) ||
    isBlocked() ||
    unresolved ||
    hasDraft() ||
    !reviewerMatchesPreview(setup) ||
    setup.state !== 'previewed' ||
    !preview ||
    hasConflict ||
    (preview?.requiresForceAgreement && !agreement.checked);
  const outcome = setup.saveOutcome;
  if (outcome?.state === 'succeeded') {
    const saved = outcome.result;
    result.textContent = `Save completed. Operation ${outcome.operationId}. Whole JSON SHA-256 ${saved.wholeFileHash}. ${saved.targets.map((target) => `${target.role} written: ${target.path} (SHA-256 ${target.hash}).`).join(' ')} ${saved.policy ? `Policy changed: ${saved.policy.inserts} inserts, ${saved.policy.updates} updates, ${saved.policy.deletes} deletes. No resource-cache rows were written by Save.` : 'No policy rows were written.'}`;
  } else if (outcome?.state === 'failed') {
    const recovery = outcome.recovery;
    const recoveryText = recovery
      ? `Affected paths: ${recovery.affectedPaths.join(', ') || 'none'}. Recovery files: ${recovery.recoveryFiles.join(', ') || 'none confirmed'}. Retained temporary files: ${recovery.retainedTemporary.join(', ') || 'none confirmed'}. Recovery writes that failed: ${recovery.recoveryFailures.join(', ') || 'none'}.`
      : '';
    result.textContent =
      outcome.recovery ||
      (setup.state === 'uncertain' && setup.latestOperation?.operationId === outcome.operationId)
        ? `Save outcome uncertain for operation ${outcome.operationId}. Inspect the actual targets outside this session before starting a new process. ${outcome.error} ${recoveryText}`
        : `Save did not complete for operation ${outcome.operationId}. ${outcome.error} ${recoveryText} Inspect inputs again and make a new preview before retrying.`;
  } else if (outcome?.state === 'rejected') {
    result.textContent = `Save request ${outcome.operationId} was rejected before writing. ${outcome.error}`;
  } else if (outcome?.state === 'running') {
    result.textContent = `Save operation ${outcome.operationId} is running. Reloading keeps this operation; closing waits for its outcome.`;
  } else if (unresolved) {
    result.textContent =
      'Save acknowledgment is unresolved. Reload to check the same operation ID. If the server no longer knows it, inspect actual targets before starting a new process.';
  } else if (hasConflict) {
    result.textContent = `Resolve destination conflicts before Save: ${preview.conflicts.join('; ')}`;
  } else if (preview?.requiresForceAgreement) {
    result.textContent = 'Check the separate replacement agreement to enable Save.';
  } else {
    result.textContent = 'Ready to Save the exact previewed revision.';
  }
}

async function submitSave(path, body) {
  try {
    await request(path, 'POST', body);
  } catch (error) {
    const setup = getSetup();
    const saved = storedPending(setup);
    if (error.requestRejected && saved?.body.operationId === body.operationId)
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify({ ...saved, rejection: error.message })
      );
    try {
      await request(`operations/${encodeURIComponent(body.operationId)}`);
    } catch (lookup) {
      settleMissingOperation(setup, body.operationId, lookup);
      throw error;
    }
  }
  await refresh();
}

async function startSave() {
  const setup = getSetup();
  if (button.disabled || !setup?.preview || submitting || hasDraft() || isBlocked() || unresolved)
    return;
  const body = pending ?? {
    operationId: crypto.randomUUID(),
    configurationRevision: setup.configurationRevision,
    contentRevision: setup.contentRevision,
    previewToken: setup.preview.token,
    agreeToReplace: agreement.checked,
  };
  pending = body;
  remember(setup, 'normal', body);
  submitting = true;
  button.disabled = true;
  try {
    await submitSave('save', body);
  } catch (error) {
    await recover(error instanceof Error ? error.message : String(error));
  } finally {
    submitting = false;
    renderSave(getSetup());
  }
}

async function practiceSave() {
  if (
    getSetup()?.state !== 'previewed' ||
    !getSetup().preview ||
    getSetup().preview.conflicts?.length ||
    !reviewerMatchesPreview(getSetup()) ||
    practiceSaving ||
    hasDraft() ||
    isBlocked() ||
    unresolved
  )
    return;
  const body = practiceSavePending ?? {
    operationId: crypto.randomUUID(),
    configurationRevision: getSetup().configurationRevision,
    contentRevision: getSetup().contentRevision,
    previewToken: getSetup().preview.token,
  };
  practiceSavePending = body;
  remember(getSetup(), 'practice', body);
  practiceSaving = true;
  setPracticeBusy(true);
  try {
    await submitSave('practice/save', body);
  } catch (error) {
    await recover(error instanceof Error ? error.message : String(error));
  } finally {
    practiceSaving = false;
    setPracticeBusy(false);
  }
}
