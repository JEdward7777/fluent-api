export function trackOperationFocus(captureFocus, status) {
  let operation;
  function finish(failed) {
    if (failed) operation?.focusError(status);
    operation = undefined;
  }
  return {
    start(id) {
      operation = { id, focusError: captureFocus() };
    },
    observe(latest) {
      if (operation && latest?.operationId === operation.id && latest.state !== 'running')
        finish(latest.state === 'failed');
    },
    fail() {
      finish(true);
    },
  };
}

function loadingSource(next, starting) {
  const operation = next.latestOperation;
  return (
    starting === 'inspect' ||
    next.state === 'inspecting' ||
    (Boolean(next.activeOperationId) &&
      operation?.operationId === next.activeOperationId &&
      operation.kind === 'inspect' &&
      operation.state === 'running')
  );
}

export function createAnalysisProgress(getSetup, render, isUnconfirmed) {
  const actions = document.getElementById('analysis-actions');
  const spinner = document.querySelector('.analysis-spinner');
  const label = document.getElementById('analysis-progress-text');
  let starting = null;

  function update(next, error) {
    const running = next.state === 'analyzing';
    const loading = loadingSource(next, starting);
    const busy = !isUnconfirmed() && (loading || Boolean(starting) || running);
    const operation = next.latestOperation;
    const progress = operation?.kind === 'paid' && operation.progress;
    let text = error ?? '';
    if (!text && loading) {
      text = 'Loading source and preparing free evidence…';
    } else if (!text && starting === 'paid' && operation?.state !== 'running') {
      text = 'Starting paid classification…';
    } else if (!text && progress) {
      const status =
        operation.state === 'failed'
          ? operation.error
          : operation.state === 'succeeded'
            ? 'Paid batch applied.'
            : progress.stopRequested
              ? 'Stop requested. Waiting for in-flight requests…'
              : 'Running paid classification…';
      text = `${status} ${progress.completedRows} of ${progress.totalRows} rows classified; ${progress.attempts} model attempts started. Cost unavailable.`;
    } else if (!text && busy) {
      text = running ? 'Preparing free review evidence…' : 'Starting free preparation…';
    } else if (!text && operation?.kind === 'analysis' && operation.state === 'failed') {
      text = operation.error;
    }
    actions.setAttribute('aria-busy', String(busy));
    spinner.hidden = !busy;
    if (text !== label.textContent) label.textContent = text;
  }
  return {
    get starting() {
      return starting;
    },
    update,
    async start(kind, begin, recover) {
      starting = kind;
      render(getSetup());
      try {
        await begin();
      } catch (error) {
        await recover();
        throw error;
      } finally {
        starting = null;
        if (!isUnconfirmed()) render(getSetup());
      }
    },
  };
}

export function workflowStatus(next, { busy, dirty, starting }) {
  if (next.state === 'uncertain')
    return 'Save outcome uncertain. Check the actual Save targets before continuing.';
  const operation = next.latestOperation;
  if (loadingSource(next, starting)) return 'Inspecting the selected source…';
  if (starting === 'analysis') return 'Starting free preparation…';
  if (starting === 'paid') return 'Starting paid classification…';
  if (operation?.state === 'running') {
    if (operation.kind === 'paid')
      return operation.progress?.stopRequested
        ? 'Stopping paid classification after in-flight requests finish…'
        : 'Running paid classification…';
    if (operation.kind === 'analysis') return 'Preparing free evidence…';
    if (operation.kind === 'save') return 'Saving the previewed changes…';
  }
  if (operation?.kind === 'inspect') {
    if (operation.state === 'failed')
      return [operation.error, operation.cleanupWarning].filter(Boolean).join(' ');
    if (operation.state === 'succeeded' && operation.cleanupWarning)
      return `Loaded the selected source. ${operation.cleanupWarning}`;
  }
  if (operation?.state === 'failed') return operation.error;
  if (next.state === 'saved' && next.saveOutcome?.state !== 'succeeded')
    return next.saveOutcome?.error ?? 'Checking this tab’s Save operation.';
  if (!next.practice && next.state === 'saved')
    return 'Save completed. See the written paths, hashes and policy result below.';
  if (next.practice && next.state === 'saved')
    return `Incomplete practice JSON saved to ${next.saveOutcome.result.targets[0]?.path}. Discard the scratch directory when finished.`;
  if (busy) return 'The workbench is busy. Checking operation status…';
  if (next.analysis)
    return next.practice
      ? `Practice analysis ready: ${next.analysis.rows} rows. Review the evidence below, then save only to scratch.`
      : `Review available for ${next.analysis.rows} rows. Open a row to inspect its evidence.`;

  if (dirty) return `Unapplied settings: ${dirty}.`;
  return next.readyForInspect
    ? 'Settings ready. Load the source.'
    : 'Choose a source, then load it to prepare its evidence.';
}

export function evidenceActions(next, blocked, dirtySettings, dirtyRow) {
  const available = !blocked && !dirtyRow;
  return {
    inspect:
      available &&
      next.state !== 'uncertain' &&
      (dirtySettings.source === undefined ? next.readyForInspect : Boolean(dirtySettings.source)) &&
      (Boolean(dirtySettings.load) ||
        next.sourceDraftPending ||
        (next.practice && next.state === 'inspected' && !next.analysis) ||
        ['configuring', 'error'].includes(next.state)),
    analyze:
      available &&
      !dirtySettings.analysis &&
      !next.sourceDraftPending &&
      (next.state === 'inspected' ||
        (!next.practice && ['reviewing', 'previewed', 'saved'].includes(next.state))),
  };
}

export function ruleNonmatchMessage(estimate) {
  const count = estimate?.unmatchedRuleIds?.length;
  if (!count) return '';
  return estimate.selection || count === 1
    ? 'No rule matched the selected notice. Its decision was kept.'
    : `No rule matched ${count} selected notices. Their decisions were kept.`;
}

export function inspectionSummary(next, dirtySettings) {
  const loaded = next.inspected;
  if (!loaded) return '';
  const inventory = `Inspected ${loaded.inspectedAt}. ${loaded.preflight.distinctKeys} distinct keys.`;
  if (next.practice) return `${inventory} Offline practice uses saved evidence.`;
  if (dirtySettings) return `${inventory} Preparing the estimate for the current AI settings.`;
  if (next.sourceDraftPending) return `${inventory} Load the selected source for its estimate.`;
  const estimate = next.paidEstimate;
  if (!estimate || estimate.contentRevision !== next.contentRevision)
    return `${inventory} The estimate is being refreshed automatically.`;
  const nonmatch = ruleNonmatchMessage(estimate);
  const requests = estimate.expectedUncachedRequests;
  const scope = estimate.selection ? 'Selected row' : 'Loaded source';
  const revision = `${scope}, revision ${estimate.contentRevision}.`;
  if (!requests) {
    const outcome =
      [nonmatch, estimate.replacements.length ? 'Free replacement awaits confirmation.' : '']
        .filter(Boolean)
        .join(' ') || 'No AI work needed.';
    return `${inventory} ${revision} 0 outstanding model requests. ${outcome}`;
  }
  const credential =
    next.hasPaidCredential === false
      ? ' A model credential is required to run paid classification.'
      : '';
  const ruleResult = nonmatch ? ` ${nonmatch}` : '';
  const protectedRows =
    estimate.outstanding?.some((row) => row.human) || estimate.replacements.length;
  const humanReview = protectedRows
    ? ' Replacing a selected human decision requires confirmation.'
    : '';
  return `${inventory} ${revision} ${requests} outstanding model request${requests === 1 ? '' : 's'}, up to ${estimate.maximumAttempts} attempts. ${estimate.provider}:${estimate.model}, ${estimate.sampleCount} samples per row. Cost unavailable. ${estimate.cost.reason}${humanReview}${ruleResult}${credential}`;
}

// Observe other tabs without allowing an older GET to overwrite a local mutation or render.
export function watchSession(fetchApi, token, apply, canRead) {
  let snapshot;
  let generation = 0;
  let writes = 0;
  let reading = false;
  let timer;
  let observingOperation = false;
  const request = sessionRequest(fetchApi, token, async (send) => {
    generation++;
    writes++;
    try {
      return await send();
    } finally {
      writes--;
    }
  });
  function schedule() {
    window.clearTimeout(timer);
    if (!document.hidden) timer = window.setTimeout(refresh, observingOperation ? 800 : 5000);
  }
  async function refresh() {
    if (document.hidden || reading) return;
    if (writes || !canRead()) {
      schedule();
      return;
    }
    window.clearTimeout(timer);
    const started = generation;
    reading = true;
    try {
      const next = await request('setup');
      if (started !== generation || writes || !canRead()) return;
      observingOperation = Boolean(next.activeOperationId || next.testingDatabase);
      if (snapshot !== JSON.stringify(next)) apply(next);
    } catch {
      // Keep the acknowledged snapshot until a later read succeeds.
    } finally {
      reading = false;
      schedule();
    }
  }
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return {
    request,
    refresh,
    get observingOperation() {
      return observingOperation;
    },
    remember(raw) {
      generation++;
      if (!Object.hasOwn(raw, 'sessionSave')) snapshot = JSON.stringify(raw);
      if (!reading && !timer) schedule();
    },
  };
}

function sessionRequest(fetchApi, token, write) {
  async function send(path, method = 'GET', body, responseType = 'json') {
    const response = await fetchApi(path, {
      method,
      headers: {
        'x-workbench-token': token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(await response.text());
      error.status = response.status;
      error.requestRejected = [400, 403, 409].includes(response.status);
      throw error;
    }
    return responseType === 'blob' ? response.blob() : response.json();
  }
  return (path, method = 'GET', body, type) =>
    method === 'GET' ? send(path, method, body, type) : write(() => send(path, method, body, type));
}

export function createEvidencePolling(getSetup, request, render, unavailable) {
  async function refresh() {
    render(await request('setup'));
    const setup = getSetup();
    if (setup.activeOperationId) {
      const operation = await request(`operations/${encodeURIComponent(setup.activeOperationId)}`);
      if (operation.state === 'running') window.setTimeout(pollEvidence, 800);
      else render(await request('setup'));
    } else if (setup.testingDatabase) window.setTimeout(pollEvidence, 800);
  }
  async function pollEvidence() {
    try {
      await refresh();
    } catch {
      unavailable();
    }
  }
  return { refresh, pollEvidence };
}
