// Commit the destination form after typing settles. A later edit owns its field
// even when its value is identical to an earlier, still unacknowledged edit.
export function createSaveSettings({ getSetup, drafts, form, request, render, sync, available }) {
  let timer;
  let running = false;
  let error = '';
  let generation = 0;
  const edits = new Map();
  let revision;
  const retry = document.getElementById('retry-save-settings');
  const current = document.getElementById('current-save-settings');
  const dirty = () => drafts.pending('save');
  const conflict = () =>
    Boolean(dirty() && revision !== undefined && revision !== getSetup().destinationRevision);
  function message() {
    if (conflict() || (dirty() && drafts.conflicted('destination')))
      return 'Destination settings changed in another tab. Review the current destination before continuing.';
    if (error) return error;
    if (
      dirty() &&
      ['json', 'both'].includes(form.elements.destination.value) &&
      !form.elements.output.value.trim()
    )
      return 'Enter the output JSON path.';
    return '';
  }
  function schedule() {
    clearTimeout(timer);
    const changes = dirty();
    if (!running && !changes) {
      edits.clear();
      revision = undefined;
    }
    const reason = message();
    retry.disabled = current.disabled = running || !available();
    retry.hidden = !error || conflict();
    current.hidden = !conflict() && !drafts.conflicted('destination');
    if (!running && changes && !reason && available()) timer = setTimeout(commit, 350);
  }
  function change(name) {
    if (!edits.size) revision = getSetup().destinationRevision;
    edits.set(name, ++generation);
    error = '';
    schedule();
  }
  async function commit() {
    if (running || !dirty() || message() || !available()) return;
    const invalid = [...form.elements].find(
      (field) =>
        field.name &&
        field.willValidate &&
        !field.closest('[hidden], .stage-hidden') &&
        !field.checkValidity()
    );
    if (invalid) {
      error = `Check ${invalid.labels?.[0]?.firstChild?.textContent.trim() || invalid.name}. ${invalid.validationMessage}`;
      sync();
      return;
    }
    const submission = drafts.stageSubmission('save');
    const started = generation;
    const version = getSetup().destinationRevision;
    running = true;
    sync();
    try {
      const next = await request('setup', 'POST', submission.body);
      revision = next.destinationRevision;
      const fields = submission.fields.filter(([name]) => (edits.get(name) ?? 0) <= started);
      const keepConnection = [...edits].some(
        ([name, gen]) => name.startsWith('database') && gen > started
      );
      render(next, {
        ...submission,
        fields,
        role: keepConnection ? null : submission.role,
        keepConnection: keepConnection && submission.role,
        keepFields: new Set(
          submission.fields
            .filter(([name]) => (edits.get(name) ?? 0) > started)
            .map(([, key]) => key)
        ),
      });
      for (const [name, gen] of edits) if (gen <= started) edits.delete(name);
    } catch (failure) {
      if (generation === started)
        error = `Destination settings could not be prepared. ${failure.message}`;
      try {
        render(await request('setup'));
      } catch {
        error = 'Session status unavailable. Recheck the destination settings before saving.';
      }
      if (getSetup().destinationRevision !== version) revision = version;
    } finally {
      running = false;
      sync();
      schedule();
    }
  }
  retry.addEventListener('click', () => {
    error = '';
    schedule();
    sync();
  });
  current.addEventListener('click', () => {
    drafts.restore('save');
    edits.clear();
    revision = undefined;
    error = '';
    render(getSetup());
  });
  return {
    change,
    schedule,
    message,
    get running() {
      return running;
    },
  };
}
