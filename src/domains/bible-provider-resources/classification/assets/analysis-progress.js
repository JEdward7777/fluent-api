export function createAnalysisProgress(getSetup, render, isUnconfirmed) {
  const actions = document.getElementById('analysis-actions');
  const spinner = document.querySelector('.analysis-spinner');
  const label = document.getElementById('analysis-progress-text');
  let starting = false;

  function update(next, error) {
    const running = next.state === 'analyzing';
    const busy = !isUnconfirmed() && (starting || running);
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
    async start(begin, recover) {
      starting = true;
      render(getSetup());
      try {
        await begin();
      } catch (error) {
        await recover();
        throw error;
      } finally {
        starting = false;
        if (!isUnconfirmed()) render(getSetup());
      }
    },
  };
}

export function workflowStatus(next, { busy, dirty, starting }) {
  if (next.state === 'uncertain')
    return 'Save outcome uncertain. Inspect actual targets before starting a new process.';
  if (!next.practice && next.state === 'saved')
    return 'Save completed. See the written paths, hashes and policy result below.';
  if (next.practice && next.state === 'saved')
    return `Incomplete practice JSON saved to ${next.preview?.output}. Discard the scratch directory when finished.`;
  if (next.analysis)
    return next.practice
      ? `Practice analysis ready: ${next.analysis.rows} rows. Review the evidence below, then save only to scratch.`
      : `Analysis ready: ${next.analysis.rows} rows. Review the evidence below before previewing changes.`;
  if (busy && starting) return 'Starting analysis…';
  if (next.latestOperation?.state === 'failed') return next.latestOperation.error;
  if (next.state === 'inspected')
    return 'Inputs inspected. Review the request estimate, then start analysis.';
  if (busy) return `${next.state}… Reloading keeps the operation.`;
  if (dirty) return 'Apply the changes or restore the applied settings.';
  return next.readyForInspect
    ? 'Settings ready. Click Inspect inputs.'
    : 'Choose settings and click Apply settings.';
}
