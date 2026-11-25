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

export function reviewRerunActions(item, { selectRerun, isBusy, showError }) {
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [kind, label] of [
    ['rule', 'Reevaluate this row with rules'],
    ['model', 'Prepare model reassessment'],
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
      try {
        request ??= {
          operationId: crypto.randomUUID(),
          configurationRevision: item.configurationRevision,
          contentRevision: item.contentRevision,
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
            confirmation: replacement.confirmation,
            ...(accepted ? {} : { cancel: true }),
          };
          await selectRerun(request);
        }
        request = undefined;
      } catch (error) {
        if (error.requestRejected) request = undefined;
        showError(error.message);
      } finally {
        delete button.dataset.running;
        button.disabled = isBusy();
      }
    });
    actions.append(button);
  }
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

export function reassessmentStatus(request, estimate) {
  if (request.cancel) return 'Human review kept.';
  if (estimate?.replacements.length) return 'Confirm replacement of this human decision.';
  if (estimate?.expectedUncachedRequests)
    return `Reassessment needs ${estimate.expectedUncachedRequests} uncached model requests. No requests were sent.`;
  return ruleNonmatchMessage(estimate) || 'Free reassessment complete.';
}
