const panel = document.getElementById('normal-save');
const button = document.getElementById('normal-save-button');
const agreement = document.getElementById('save-replacement-agreement');
const agreementLabel = document.getElementById('save-replacement');
const result = document.getElementById('save-result');
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
let render;
const storageKey = 'license-workbench-pending-save';
let unresolved = false;
let checking = false;

function storedPending(setup) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey) || 'null');
    if (saved?.launchId === setup.launchId) return saved;
    if (saved) window.sessionStorage.removeItem(storageKey);
  } catch {
    window.sessionStorage.removeItem(storageKey);
  }
  return null;
}

function remember(setup, kind, body) {
  window.sessionStorage.setItem(
    storageKey,
    JSON.stringify({ launchId: setup.launchId, kind, body })
  );
}

function reconcile(setup) {
  const saved = storedPending(setup);
  if (!saved) {
    unresolved = false;
    return;
  }
  if (setup.saveOutcome?.operationId === saved.body.operationId) {
    if (setup.saveOutcome.state !== 'running') {
      window.sessionStorage.removeItem(storageKey);
      pending = null;
      practiceSavePending = null;
    }
    unresolved = false;
    return;
  }
  unresolved = true;
  if (checking) return;
  checking = true;
  void request(`operations/${encodeURIComponent(saved.body.operationId)}`)
    .then((operation) => {
      if (operation.kind !== 'save') return;
      if (operation.state !== 'running') {
        window.sessionStorage.removeItem(storageKey);
        unresolved = false;
      }
      return refresh();
    })
    .catch(() => {})
    .finally(() => {
      checking = false;
    });
}

export function saveStatusUnconfirmed() {
  return unresolved;
}

export function initSave(dependencies) {
  ({ request, getSetup, refresh, recover, hasDraft, isBlocked, setPracticeBusy, render } =
    dependencies);
  document.getElementById('practice-save').addEventListener('click', () => void practiceSave());
  agreement.addEventListener('change', () => renderSave(getSetup()));
  button.addEventListener('click', () => void startSave());
}

export function renderSave(setup) {
  if (!setup) return;
  reconcile(setup);
  panel.hidden = setup.practice || (!setup.preview && !setup.saveOutcome);
  if (panel.hidden) return;
  const preview = setup.preview;
  const identity = preview
    ? `${preview.configurationRevision}:${preview.contentRevision}:${preview.wholeFileHash}`
    : '';
  if (previewIdentity !== identity) {
    previewIdentity = identity;
    agreement.checked = false;
  }
  agreementLabel.hidden = !preview?.requiresForceAgreement;
  agreement.disabled = Boolean(setup.activeOperationId) || isBlocked();
  const incompleteImport = Boolean(preview?.incomplete && preview.replace);
  button.disabled =
    submitting ||
    Boolean(setup.activeOperationId) ||
    isBlocked() ||
    unresolved ||
    hasDraft() ||
    setup.state !== 'previewed' ||
    !preview ||
    incompleteImport ||
    (preview?.requiresForceAgreement && !agreement.checked);
  const outcome = setup.saveOutcome;
  if (outcome?.state === 'succeeded') {
    const saved = outcome.result;
    result.textContent = `Save completed. Operation ${outcome.operationId}. Whole JSON SHA-256 ${saved.wholeFileHash}. ${saved.targets.map((target) => `${target.role} written: ${target.path} (SHA-256 ${target.hash}).`).join(' ')} ${saved.policy ? `Policy changed: ${saved.policy.inserts} inserts, ${saved.policy.updates} updates, ${saved.policy.deletes} deletes. No resource-cache rows were written by Save.` : 'No policy rows were written.'} ${saved.incomplete ? 'JSON remains incomplete and cannot be imported as policy.' : ''}`;
  } else if (outcome?.state === 'failed') {
    const recovery = outcome.recovery;
    const recoveryText = recovery
      ? `Affected paths: ${recovery.affectedPaths.join(', ') || 'none'}. Recovery files: ${recovery.recoveryFiles.join(', ') || 'none confirmed'}. Retained temporary files: ${recovery.retainedTemporary.join(', ') || 'none confirmed'}. Recovery writes that failed: ${recovery.recoveryFailures.join(', ') || 'none'}.`
      : '';
    result.textContent =
      setup.state === 'uncertain'
        ? `Save outcome uncertain for operation ${outcome.operationId}. Inspect the actual targets outside this session before starting a new process. ${outcome.error} ${recoveryText}`
        : `Save did not complete for operation ${outcome.operationId}. ${outcome.error} ${recoveryText} Inspect inputs again and make a new preview before retrying.`;
  } else if (outcome?.state === 'running') {
    result.textContent = `Save operation ${outcome.operationId} is running. Reloading keeps this operation; closing waits for its outcome.`;
  } else if (unresolved) {
    result.textContent =
      'Save acknowledgment is unresolved. Reload to check the same operation ID. If the server no longer knows it, inspect actual targets before starting a new process.';
  } else if (incompleteImport) {
    result.textContent =
      'This JSON import is incomplete. Complete attestation and preview again before replacing policy.';
  } else if (preview?.requiresForceAgreement) {
    result.textContent = 'Check the separate replacement agreement to enable Save.';
  } else {
    result.textContent = 'Ready to Save the exact previewed revision.';
  }
}

async function startSave() {
  const setup = getSetup();
  if (button.disabled || !setup?.preview || submitting || hasDraft() || isBlocked() || unresolved)
    return;
  const body = pending ?? {
    operationId: crypto.randomUUID(),
    configurationRevision: setup.configurationRevision,
    contentRevision: setup.contentRevision,
    agreeToReplace: agreement.checked,
  };
  pending = body;
  remember(setup, 'normal', body);
  submitting = true;
  button.disabled = true;
  try {
    await request('save', 'POST', body);
    await refresh();
  } catch (error) {
    // A lost acknowledgment never authorizes a new operation ID.
    try {
      await request(`operations/${encodeURIComponent(body.operationId)}`);
      await refresh();
    } catch {
      await recover(error instanceof Error ? error.message : String(error));
    }
  } finally {
    submitting = false;
    renderSave(getSetup());
  }
}

async function practiceSave() {
  if (practiceSaving || hasDraft() || isBlocked() || unresolved) return;
  const body = practiceSavePending ?? {
    operationId: crypto.randomUUID(),
    configurationRevision: getSetup().configurationRevision,
    contentRevision: getSetup().contentRevision,
  };
  practiceSavePending = body;
  remember(getSetup(), 'practice', body);
  practiceSaving = true;
  setPracticeBusy(true);
  try {
    await request('practice/save', 'POST', body);
    await refresh();
  } catch (error) {
    try {
      await request(`operations/${encodeURIComponent(body.operationId)}`);
      await refresh();
    } catch {
      await recover(error instanceof Error ? error.message : String(error));
    }
  } finally {
    practiceSaving = false;
    setPracticeBusy(false);
    if (getSetup()) render(getSetup());
  }
}
