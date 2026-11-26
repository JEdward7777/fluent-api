export function createPaidControls(getSetup, sync, start, selectRerun) {
  const paid = document.getElementById('paid');
  const humanLabel = document.getElementById('paid-human');
  const humanConsent = humanLabel.querySelector('input');
  const notice = document.getElementById('paid-notice');
  const reason = document.getElementById('paid-reason');
  const cancel = document.getElementById('cancel-selected');
  let paidReceipt;
  cancel.addEventListener('click', async () => {
    if (cancel.disabled) return;
    const current = getSetup();
    const estimate = current.paidEstimate;
    try {
      await selectRerun({
        operationId: crypto.randomUUID(),
        configurationRevision: current.configurationRevision,
        contentRevision: current.contentRevision,
        estimateRevision: current.estimateRevision,
        ...estimate.selection,
        cancel: true,
        confirmation: estimate.fingerprint,
      });
    } catch (error) {
      reason.textContent = error.message;
    }
  });
  humanConsent.addEventListener('change', () => sync(getSetup()));
  paid.addEventListener('click', async () => {
    if (paid.disabled) return;
    const estimate = getSetup().paidEstimate;
    paidReceipt ??= {
      operationId: crypto.randomUUID(),
      configurationRevision: getSetup().configurationRevision,
      paid: {
        fingerprint: estimate.fingerprint,
        maximumRequests: estimate.expectedUncachedRequests,
        replacementConfirmations: humanConsent.checked
          ? estimate.outstanding
              .filter((row) => row.human)
              .map((row) => row.replacementConfirmation)
          : [],
      },
    };
    await start('paid', paidReceipt);
  });
  return {
    resetReceipt() {
      paidReceipt = undefined;
    },
    resetConsent() {
      humanConsent.checked = false;
      paidReceipt = undefined;
    },
    update(next, available, refreshing) {
      const estimate = next.paidEstimate;
      if (paid.dataset.estimate !== estimate?.fingerprint) {
        paid.dataset.estimate = estimate?.fingerprint ?? '';
        humanConsent.checked = false;
        paidReceipt = undefined;
      }
      const humans = estimate?.outstanding.filter((row) => row.human) ?? [];
      const count = estimate?.expectedUncachedRequests ?? 0;
      const row = estimate?.selection?.kind === 'model' && estimate.outstanding[0];
      humanLabel.hidden = !count || !humans.length || Boolean(refreshing);
      humanConsent.disabled = humanLabel.hidden || !available;
      notice.hidden = Boolean(refreshing) || (!row && !humans.length);
      const entries = row ? 'this notice' : humans.map((item) => item.exampleNotice).join(' · ');
      const cost = estimate?.cost.reason ?? '';
      notice.textContent = [
        row && `Selected notice: ${row.exampleNotice}. ${count} fresh model requests. ${cost}`,
        humans.length &&
          `Running paid classification will replace the human review for ${entries} with the model result. Checking Revert confirmed leaves the review in place until you run classification.`,
      ]
        .filter(Boolean)
        .join(' ');
      const completed =
        next.selectedModelId &&
        estimate?.selection?.id === next.selectedModelId &&
        next.selectedPaid?.state === 'succeeded' &&
        !count;
      cancel.hidden = !row && !completed;
      cancel.disabled = cancel.hidden || !available;
      cancel.textContent = completed
        ? 'Return to loaded source estimate'
        : 'Cancel selected reassessment';
      const message = next.practice
        ? 'Offline practice cannot call the model.'
        : refreshing ||
          (!estimate
            ? 'Load a source for its current estimate.'
            : !count
              ? completed
                ? 'The selected reassessment is complete.'
                : 'No model requests are needed.'
              : !next.hasPaidCredential
                ? 'A model credential is required.'
                : !available
                  ? 'Wait for the current operation to finish.'
                  : humans.length && !humanConsent.checked
                    ? 'Confirm replacement of the selected human review.'
                    : '');
      reason.textContent = message;
      paid.disabled = Boolean(message);
    },
  };
}
