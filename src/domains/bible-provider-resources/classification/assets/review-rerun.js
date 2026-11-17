function confirmDiscard(kind) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'rerun-confirmation';
    dialog.setAttribute('aria-label', 'Confirm discarding unsaved review edits');
    const message = document.createElement('p');
    message.textContent = `Reassessing this row restarts Inspect and discards every unsaved review edit in this session, including decisions or notes on other rows. Continue with ${kind} reassessment?`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel and keep edits';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = 'Discard edits and select reassessment';
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

export function reviewRerunActions(item, { selectRerun, hasDraft, isBusy, showError }) {
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [kind, label, description] of [
    [
      'rule',
      'Reevaluate this row with rules',
      'Inspect shows the current rule match or nonmatch before Analyze.',
    ],
    [
      'model',
      'Select model reassessment',
      'Inspect shows valid cache hits and expected uncached model requests before Analyze.',
    ],
  ]) {
    if (kind === 'rule' && item.reviewState !== 'unreviewed') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.rerun = kind;
    button.textContent = label;
    button.title = description;
    button.addEventListener('click', async () => {
      if (hasDraft() || isBusy()) {
        showError('Apply or discard the open row edit before reassessment.');
        return;
      }
      if (!(await confirmDiscard(kind))) return;
      button.disabled = true;
      try {
        await selectRerun({
          configurationRevision: item.configurationRevision,
          contentRevision: item.contentRevision,
          id: item.id,
          kind,
          discardReviewedState: true,
        });
      } catch (error) {
        showError(error.message);
        button.disabled = false;
      }
    });
    actions.append(button);
  }
  return actions;
}
