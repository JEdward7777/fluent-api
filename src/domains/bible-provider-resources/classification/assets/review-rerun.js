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
      button.disabled = true;
      try {
        await selectRerun({
          configurationRevision: item.configurationRevision,
          contentRevision: item.contentRevision,
          id: item.id,
          kind,
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
