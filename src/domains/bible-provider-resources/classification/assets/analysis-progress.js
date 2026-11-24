export function createAnalysisProgress(getSetup, render, isUnconfirmed) {
  const actions = document.getElementById('analysis-actions');
  const spinner = document.querySelector('.analysis-spinner');
  const label = document.getElementById('analysis-progress-text');
  let starting = null;

  function update(next, error) {
    const running = next.state === 'analyzing';
    const busy = !isUnconfirmed() && (starting === 'analysis' || running);
    const operation = next.latestOperation;
    const text = busy
      ? running
        ? next.inspected?.preflight.expectedUncachedRequests === 0
          ? 'Preparing review evidence without new model requests…'
          : 'Analyzing the inspected evidence…'
        : 'Starting analysis…'
      : (error ??
        (operation?.kind === 'analysis' && operation.state === 'failed' ? operation.error : ''));
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
  if (starting === 'analysis') return 'Starting analysis…';
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
      : `Analysis ready: ${next.analysis.rows} rows. Review the evidence below before previewing changes.`;
  if (operation?.state === 'failed') return operation.error;
  if (next.state === 'inspected')
    return 'Inputs inspected. Review the request estimate, then start analysis.';
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
    analyze: available && !next.sourceDraftPending && next.state === 'inspected',
  };
}
