export function createPaidControls(getSetup, sync, start) {
  const paid = document.getElementById('paid');
  const humanLabel = document.getElementById('paid-human');
  const humanConsent = humanLabel.querySelector('input');
  let paidReceipt;
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
    update(next, available) {
      const estimate = next.paidEstimate;
      if (paid.dataset.estimate !== estimate?.fingerprint) {
        paid.dataset.estimate = estimate?.fingerprint ?? '';
        humanConsent.checked = false;
        paidReceipt = undefined;
      }
      const humans = estimate?.outstanding.filter((row) => row.human) ?? [];
      paid.hidden = next.practice || !estimate?.expectedUncachedRequests;
      humanLabel.hidden = paid.hidden || !humans.length;
      humanConsent.disabled = !available;
      humanLabel.querySelector('span').textContent =
        `Replace my selected human review with the paid result for ${humans
          .map((row) => row.exampleNotice)
          .join(', ')}`;
      paid.disabled =
        paid.hidden ||
        !next.hasPaidCredential ||
        !available ||
        (humans.length > 0 && !humanConsent.checked);
    },
  };
}
