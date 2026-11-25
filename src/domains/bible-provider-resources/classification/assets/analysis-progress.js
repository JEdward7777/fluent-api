export function createAnalysisProgress(getSetup, render, isUnconfirmed) {
  const actions = document.getElementById('analysis-actions');
  const spinner = document.querySelector('.analysis-spinner');
  const label = document.getElementById('analysis-progress-text');
  let starting = null;

  function update(next, error) {
    const running = next.state === 'analyzing';
    const busy = !isUnconfirmed() && (starting === 'analysis' || starting === 'paid' || running);
    const operation = next.latestOperation;
    const progress = operation?.kind === 'paid' && operation.progress;
    let text = error ?? '';
    if (!text && starting === 'paid' && operation?.state !== 'running') {
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
    return 'Save outcome uncertain. Inspect actual targets before starting a new process.';
  const operation = next.latestOperation;
  if (starting === 'inspect' || (operation?.kind === 'inspect' && operation.state === 'running'))
    return 'Inspecting the selected source…';
  if (starting === 'analysis') return 'Starting free preparation…';
  if (operation?.kind === 'inspect') {
    if (operation.state === 'failed')
      return [operation.error, operation.cleanupWarning].filter(Boolean).join(' ');
    if (operation.state === 'succeeded' && operation.cleanupWarning)
      return `Loaded the selected source. ${operation.cleanupWarning}`;
  }
  if (!next.practice && next.state === 'saved')
    return 'Save completed. See the written paths, hashes and policy result below.';
  if (next.practice && next.state === 'saved')
    return `Incomplete practice JSON saved to ${next.preview?.output}. Discard the scratch directory when finished.`;
  if (next.analysis)
    return next.practice
      ? `Practice analysis ready: ${next.analysis.rows} rows. Review the evidence below, then save only to scratch.`
      : `Review available for ${next.analysis.rows} rows. Open a row to inspect its evidence.`;
  if (operation?.state === 'failed') return operation.error;
  if (next.state === 'inspected') return 'Inputs inspected. Prepare free evidence to continue.';
  if (busy) return `${next.state}… Reloading keeps the operation.`;
  if (dirty) return 'Apply the changes or restore the applied settings.';
  return next.readyForInspect
    ? 'Settings ready. Click Inspect inputs.'
    : 'Choose settings and click Apply settings.';
}

export function evidenceActions(next, blocked, dirtySettings, dirtyRow) {
  const available = !blocked && !dirtySettings && !dirtyRow;
  return {
    inspect:
      available &&
      next.readyForInspect &&
      (next.sourceDraftPending || ['configuring', 'error'].includes(next.state)),
    analyze:
      available &&
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
  if (dirtySettings)
    return `${inventory} Apply or restore your settings to see the current estimate.`;
  if (next.sourceDraftPending)
    return `${inventory} Inspect the newly selected source for its estimate.`;
  const estimate = next.paidEstimate;
  if (!estimate || estimate.contentRevision !== next.contentRevision)
    return `${inventory} The estimate needs refreshing. Click Prepare free evidence to recalculate it.`;
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
