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
let readiness;
let sync;
let isBlocked;
let canReconcileSource;
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
  reviewerField.required = Boolean(next.analysis?.pendingReviews);
  document.getElementById('save-reviewer-label').hidden = !reviewerField.required;
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
  // The global write fence and this tab's receipt can belong to different Saves.
  setup = { ...setup, sessionSave: setup.saveOutcome };
  const saved = storedPending(setup);
  if (!saved) {
    unresolved = false;
    const receipt = storedPending(setup, receiptKey);
    if (
      receipt?.operation.operationId === setup.saveOutcome?.operationId &&
      setup.saveOutcome?.reconciliation
    ) {
      window.sessionStorage.setItem(
        receiptKey,
        JSON.stringify({ launchId: setup.launchId, operation: setup.saveOutcome })
      );
      return setup;
    }
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

export function saveSubmitting() {
  return submitting || practiceSaving;
}

export function saveStatusUnconfirmed() {
  return unresolved;
}

export function initSave(dependencies) {
  ({
    request,
    getSetup,
    refresh,
    recover,
    hasDraft,
    isBlocked,
    canReconcileSource,
    setPracticeBusy,
    readiness,
    sync,
  } = dependencies);
  document.getElementById('practice-save').addEventListener('click', () => void practiceSave());
  document.getElementById('source-inspect')?.addEventListener('click', inspectSourceChanges);
  agreement.addEventListener('change', () => renderSave(getSetup()));
  button.addEventListener('click', () => void startSave());
  document.getElementById('reconcile-save')?.addEventListener('click', async (event) => {
    const setup = getSetup();
    const operationId = setup.sessionSave?.operationId;
    if (!operationId) return;
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const operation = await request('save/reconcile', 'POST', { operationId });
      if (storedPending(setup, receiptKey)?.operation.operationId === operationId)
        window.sessionStorage.setItem(
          receiptKey,
          JSON.stringify({ launchId: setup.launchId, operation })
        );
      await refresh();
    } catch {
      const status =
        setup.saveOutcome?.operationId === operationId ? 'save-result' : 'session-save-status';
      document.getElementById(status).textContent =
        `Could not verify Save ${operationId}. Check its targets again.`;
    } finally {
      control.disabled = false;
    }
  });
}

function describeRecovery(recovery) {
  return recovery
    ? `Affected paths: ${recovery.affectedPaths.join(', ') || 'none'}. Recovery files: ${recovery.recoveryFiles.join(', ') || 'none confirmed'}. Retained temporary files: ${recovery.retainedTemporary.join(', ') || 'none confirmed'}. Recovery writes that failed: ${recovery.recoveryFailures.join(', ') || 'none'}.`
    : '';
}

async function inspectSourceChanges() {
  if (!canReconcileSource()) return;
  const form = document.getElementById('source-resolution');
  const status = document.getElementById('source-resolution-status');
  try {
    const proposal = await request('source/reconcile', 'POST', {});
    form.replaceChildren();
    for (const change of proposal.changes) {
      const details = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = change.label + (change.conflict ? ' (conflict)' : '');
      const records = document.createElement('pre');
      records.textContent = JSON.stringify(
        {
          original: change.original,
          working: change.working,
          pending: change.pending,
          source: change.source,
        },
        null,
        2
      );
      details.append(title, records);
      const control = document.createElement('select');
      control.name = change.id;
      control.setAttribute('aria-label', change.label);
      control.required = change.conflict;
      const proposed =
        change.proposed === 'working' ? 'Keep session version' : 'Use refreshed source';
      control.add(new Option(change.conflict ? 'Choose a version' : `Proposed: ${proposed}`, ''));
      control.add(new Option('Keep session version', 'working'));
      control.add(
        new Option(
          change.source === null ? 'Accept deletion from source' : 'Use refreshed source',
          'source'
        )
      );
      if (change.pending && change.source)
        control.add(new Option('Use refreshed source and keep pending mark', 'source-with-mark'));
      form.append(details, control);
    }
    const accept = document.createElement('button');
    accept.textContent = 'Accept reconciliation';
    form.append(accept);
    form.hidden = false;
    status.textContent = '';
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!canReconcileSource()) return;
      try {
        const choices = Object.fromEntries([...new FormData(form)].filter(([, value]) => value));
        await request('source/reconcile', 'POST', { token: proposal.token, choices });
        form.hidden = true;
        await refresh();
      } catch (error) {
        status.textContent = error.message;
      }
    };
  } catch (error) {
    status.textContent = error.message;
  }
}

export function renderSave(setup) {
  const drift = document.getElementById('source-drift');
  if (drift) {
    drift.hidden = !setup.sourceChanged || setup.state !== 'reviewing';
    if (!drift.hidden) {
      const blocked = !canReconcileSource();
      document.getElementById('source-inspect').disabled = blocked;
      const accept = document.querySelector('#source-resolution button');
      if (accept) accept.disabled = blocked;
    }
  }
  if (!setup) return;
  panel.hidden = setup.practice;
  document.getElementById('save-reviewer').disabled =
    saveSubmitting() || Boolean(setup.activeOperationId);
  const reconcile = document.getElementById('reconcile-save');
  const shared = setup.sessionSave;
  if (reconcile) reconcile.hidden = setup.state !== 'uncertain' || !shared;
  const sharedStatus = document.getElementById('session-save-status');
  if (sharedStatus) {
    sharedStatus.hidden =
      !shared ||
      shared.operationId === setup.saveOutcome?.operationId ||
      (setup.state !== 'uncertain' && !shared.reconciliation);
    if (!sharedStatus.hidden) {
      const checked = shared.reconciliation;
      const progress =
        checked?.outcome === 'planned'
          ? 'confirmed successful'
          : checked?.outcome === 'prior'
            ? 'confirmed unwritten; prepare a fresh preview to retry'
            : 'uncertain; check the actual Save targets';
      const targets = checked?.targets.map(({ target, match }) => `${target}: ${match}`).join('. ');
      sharedStatus.textContent = `Session Save ${shared.operationId} is ${progress}. ${targets || shared.error || ''} ${setup.state === 'uncertain' ? describeRecovery(shared.recovery) : ''}`;
    }
  }
  const result = document.getElementById('save-result');
  result.hidden = !setup.saveOutcome && !unresolved;
  const preview = setup.preview;
  const identity = preview ? preview.token : '';
  if (previewIdentity !== identity) {
    previewIdentity = identity;
    agreement.checked = false;
  }
  agreementLabel.hidden = !preview?.requiresForceAgreement;
  agreement.disabled = Boolean(setup.activeOperationId) || isBlocked();
  const hasConflict = Boolean(preview?.conflicts?.length);
  const reason = readiness?.(setup) ?? '';
  button.disabled =
    Boolean(reason) ||
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
  const progress = document.getElementById('save-readiness');
  const writing = submitting || setup.state === 'saving';
  progress.textContent = writing
    ? 'Saving…'
    : reason ||
      (hasConflict
        ? `Resolve destination conflicts: ${preview.conflicts.join('; ')}`
        : preview?.requiresForceAgreement && !agreement.checked
          ? 'Confirm replacement before saving.'
          : button.disabled
            ? 'Wait for the current session operation.'
            : 'Ready to save these changes.');
  progress.setAttribute?.('data-busy', String(writing || reason === 'Preparing preview…'));
  const outcome = setup.saveOutcome;
  document.getElementById('receipt-technical').hidden = outcome?.state !== 'succeeded';
  if (outcome?.state === 'succeeded') {
    const saved = outcome.result;
    const json = saved.json;
    document.getElementById('receipt-hashes').textContent = [
      ['Working review content', saved.reviewContentHash],
      ['JSON review content', json?.reviewContentHash],
      ...saved.targets.map((target) => [target.path, target.hash]),
      ['Database decisions', saved.policy?.reviewContentHash],
    ]
      .filter(([, hash]) => hash)
      .map(([label, hash]) => `${label}: ${hash}`)
      .join('\n');
    const jsonSummary = json
      ? `JSON decisions: ${json.inserted} inserts, ${json.updated} updates (${json.permissionChanges} permission, ${json.metadataChanges} metadata only), ${json.preserved} preserved, ${json.unchanged} unchanged, ${json.deleted.length} deletions. File contains ${json.artifactRows} rows (${json.artifactBytes} bytes).`
      : '';
    const deletions = [
      ...(json?.deleted ?? []).map((key) => key || '(empty notice)'),
      ...(json?.deletedCatalog ?? []).map(
        ({ provider, externalId }) => `${provider}/${externalId}`
      ),
    ];
    const deleted = deletions.length ? ` Deleted from JSON: ${deletions.join(' | ')}.` : '';
    result.textContent = `Save completed. Operation ${outcome.operationId}.${saved.reviewer ? ` Newly reviewed by ${saved.reviewer} at ${saved.reviewedAt}.` : ''} ${saved.targets.map((target) => `${target.role} written: ${target.path}.`).join(' ')} ${jsonSummary}${deleted} ${saved.policy ? `Policy at ${saved.policy.target ?? 'the selected database'}: ${saved.policy.inserts} inserts, ${saved.policy.updates} updates (${saved.policy.permissionChanges} permission, ${saved.policy.metadataChanges} metadata only), ${saved.policy.unchanged} unchanged, ${saved.policy.deletes} deletes.${saved.policy.preserved !== undefined ? ` ${saved.policy.preserved} destination records preserved.` : ''} No resource-cache rows were written by Save.` : 'No policy rows were written.'}`;
  } else if (outcome?.state === 'failed') {
    const recoveryText = describeRecovery(outcome.recovery);
    const checked = outcome.reconciliation;
    const targets = checked?.targets.map(({ target, match }) => `${target}: ${match}`).join('. ');
    result.textContent =
      checked?.outcome === 'prior'
        ? `All targets match their prior state. Prepare a fresh preview before retrying. ${targets}`
        : outcome.recovery ||
            (setup.state === 'uncertain' &&
              setup.latestOperation?.operationId === outcome.operationId)
          ? `Save outcome uncertain for operation ${outcome.operationId}. Check the actual targets to reconcile this Save. ${targets || outcome.error} ${recoveryText}`
          : `Save did not complete for operation ${outcome.operationId}. ${outcome.error} ${recoveryText} Inspect inputs again and make a new preview before retrying.`;
  } else if (outcome?.state === 'rejected') {
    result.textContent = `Save request ${outcome.operationId} was rejected before writing. ${outcome.error}`;
  } else if (outcome?.state === 'running') {
    result.textContent = `Save operation ${outcome.operationId} is running. Reloading keeps this operation; closing waits for its outcome.`;
  } else if (unresolved) {
    result.textContent =
      'Save acknowledgment is unresolved. Reload to check the same operation ID. If the server no longer knows it, inspect actual targets before starting a new process.';
  } else {
    result.textContent = '';
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
  renderSave(setup);
  sync?.();
  try {
    await submitSave('save', body);
  } catch (error) {
    await recover(error instanceof Error ? error.message : String(error));
  } finally {
    submitting = false;
    renderSave(getSetup());
    sync?.();
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
