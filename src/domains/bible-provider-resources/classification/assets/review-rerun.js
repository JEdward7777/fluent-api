import { ruleNonmatchMessage } from './analysis-progress.js';

function confirmReplacement(kind) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'rerun-confirmation';
    dialog.setAttribute('aria-label', 'Replace this human review?');
    const message = document.createElement('p');
    message.textContent = `Replace this row’s human decision with the prepared ${kind === 'rule' ? 'rule' : 'cached model'} result?`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Keep human review';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = 'Replace this decision';
    const finish = (accepted) => {
      dialog.close();
      dialog.remove();
      resolve(accepted);
    };
    cancel.addEventListener('click', () => finish(false));
    accept.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.append(message, cancel, accept);
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

export function reviewRerunActions(item, { selectRerun, isBusy, openEstimate, getSetup }) {
  const actions = document.createElement('div');
  actions.className = 'actions';
  const outcome = document.createElement('p');
  outcome.dataset.rerunStatus = '';
  outcome.setAttribute('role', 'status');
  const open = document.createElement('button');
  open.type = 'button';
  open.dataset.openEstimate = '';
  open.textContent = 'View AI estimate';
  open.addEventListener('click', openEstimate);
  for (const [kind, label] of [
    ['rule', 'Reevaluate this row with rules'],
    ['model', 'Reassess with AI'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.rerun = kind;
    button.textContent = label;
    button.disabled = isBusy();
    let request;
    button.addEventListener('click', async () => {
      if (isBusy()) return;
      button.dataset.running = 'true';
      button.disabled = true;
      outcome.textContent =
        kind === 'model'
          ? 'Preparing the estimate for this notice…'
          : 'Checking this notice against the rules…';
      try {
        request ??= {
          operationId: crypto.randomUUID(),
          configurationRevision: item.configurationRevision,
          contentRevision: item.contentRevision,
          estimateRevision: getSetup().estimateRevision,
          id: item.id,
          kind,
        };
        const result = await selectRerun(request);
        const replacement = result.paidEstimate?.replacements.find((row) => row.id === item.id);
        if (replacement && !isBusy()) {
          const accepted = await confirmReplacement(kind);
          request = {
            ...request,
            operationId: crypto.randomUUID(),
            estimateRevision: result.estimateRevision,
            confirmation: replacement.confirmation,
            ...(accepted ? {} : { cancel: true }),
          };
          const changed = await selectRerun(request);
          outcome.textContent = reassessmentStatus(request, changed.paidEstimate);
        } else {
          outcome.textContent = reassessmentStatus(request, result.paidEstimate);
        }
        request = undefined;
      } catch (error) {
        if (error.requestRejected) request = undefined;
        outcome.textContent = error.message;
      } finally {
        delete button.dataset.running;
        button.disabled = isBusy();
      }
    });
    actions.append(button);
  }
  actions.append(open, outcome);
  syncRerunOutcome(actions, item.id, getSetup());
  return actions;
}

export function reassessmentUnavailable(setup, busy) {
  return (
    busy ||
    setup?.sourceDraftPending ||
    Boolean(setup?.activeOperationId) ||
    !['inspected', 'reviewing', 'previewed', 'saved'].includes(setup?.state)
  );
}

export function syncRerunButtons(detail, unavailable) {
  for (const button of detail.querySelectorAll('[data-rerun]'))
    button.disabled = unavailable || button.dataset.running === 'true';
}

export function syncRerunOutcome(detail, id, setup) {
  const label = detail.querySelector('[data-rerun-status]');
  if (!label) return;
  const estimate = setup.paidEstimate;
  const selected = setup.selectedModelId === id;
  const operation = setup.selectedPaid?.selectedModel?.id === id && setup.selectedPaid;
  const offer = selected && estimate?.selection?.id === id;
  const open = detail.querySelector('[data-open-estimate]');
  open.hidden = !offer || !estimate.expectedUncachedRequests;
  const parts = [];
  if (operation) {
    const { attempts } = operation.progress;
    const result = operation.selectedModel;
    if (operation.state === 'succeeded')
      parts.push(
        `Reassessment complete. Decision: ${result.decision}. ${result.freshSamples} fresh samples, ${result.reusedSamples} reused. ${attempts} model attempts.`
      );
    else if (operation.state === 'failed')
      parts.push(`${operation.error} Decision kept. ${attempts} model attempts started.`);
    else parts.push(`Running the selected reassessment. ${attempts} model attempts started.`);
  }
  if (setup.canceledModelId === id && !operation)
    parts.push(
      setup.reassessmentSourceChange
        ? 'The source changed and closed this reassessment.'
        : 'Canceled the reassessment. Your decision was kept.'
    );
  if (offer && (!operation || operation.state === 'failed'))
    parts.push(reassessmentStatus(estimate.selection, estimate));
  if (parts.length) {
    label.textContent = parts.join(' ');
    label.dataset.scoped = 'true';
  } else if (label.dataset.scoped) {
    label.textContent = '';
    delete label.dataset.scoped;
  }
}

export function reassessmentStatus(request, estimate) {
  if (request.cancel) return 'Selection closed. The current decision was kept.';
  if (estimate?.replacements.length) return 'Confirm replacement of this human decision.';
  if (estimate?.expectedUncachedRequests)
    return `This notice needs ${estimate.expectedUncachedRequests} fresh model requests. ${estimate.cost.reason} Review the estimate before running paid classification.`;
  return ruleNonmatchMessage(estimate) || 'Free reassessment complete.';
}
