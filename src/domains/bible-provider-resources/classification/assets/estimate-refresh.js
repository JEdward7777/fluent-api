export function olderSetup(setup, next) {
  return (
    setup &&
    (next.loadRevision < setup.loadRevision ||
      next.configurationRevision < setup.configurationRevision ||
      next.estimateRevision < setup.estimateRevision ||
      next.reassessmentScopeRevision < setup.reassessmentScopeRevision ||
      (next.loadRevision === setup.loadRevision &&
        (next.contentRevision < setup.contentRevision ||
          (next.configurationRevision === setup.configurationRevision &&
            next.stateRevision < setup.stateRevision))))
  );
}

// Only one free refresh is submitted at a time. Edits made during its round trip
// retain their own generation, even if the user types an earlier value again.
export function createEstimateRefresh({
  getSetup,
  read,
  restoreAi,
  dirty,
  request,
  render,
  available,
  sync,
}) {
  const edits = new Map();
  const fieldNames = {
    model: 'Model',
    sampleCount: 'Samples',
    cacheDir: 'Cache directory',
    noCache: 'Ignore cached requests',
  };
  const describe = (value) => (value === null ? 'the default cache directory' : String(value));
  const conflicts = (next) =>
    [...edits].filter(([key, edit]) => edit.base !== next[key] && edit.value !== next[key]);
  let error = '';
  let generation = 0;
  let editScope;
  let discarded;
  const scopeNotice = document.getElementById('ai-scope-change');
  const scopeOf = (next) =>
    JSON.stringify([next.loadRevision, next.selectedModelId, next.reassessmentScopeRevision]);
  function scopeLabel(next) {
    const id = next.selectedModelId ?? next.paidEstimate?.selection?.id;
    if (!id) {
      if (next.loadedSource?.source === 'database') return 'the loaded database';
      const path = next.loadedSource?.input;
      return path ? `the loaded source “${path}”` : 'the loaded source';
    }
    const notice =
      next.paidEstimate?.outstanding?.find((row) => row.id === id)?.exampleNotice ??
      (next.selectedPaid?.selectedModel?.id === id
        ? next.selectedPaid.selectedModel.notice
        : undefined) ??
      (next.reassessmentSourceChange?.id === id ? next.reassessmentSourceChange.notice : undefined);
    return notice ? `“${notice}”` : `row ${id}`;
  }
  // A new selection, even a return to the same row, closes the earlier form edits.
  // Restore only AI fields before rebasing the rest of the settings form.
  function rebase(next) {
    const prior = getSetup();
    if (prior && scopeOf(prior) !== scopeOf(next)) {
      generation++;
      error = '';
      if (edits.size) {
        discarded = editScope.label;
        edits.clear();
        restoreAi(next);
      }
      editScope = undefined;
    }
    scopeNotice.hidden = !discarded;
    if (discarded) {
      const message = `The selection changed. Pending AI settings for ${discarded} were cleared. The current estimate is for ${scopeLabel(next)}.`;
      if (scopeNotice.textContent !== message) scopeNotice.textContent = message;
    }
    return edits;
  }
  let running = false;
  let selecting = false;
  let timer;
  const retry = document.getElementById('retry-estimate');
  function needed(next) {
    return (
      next?.analysis &&
      ['inspected', 'reviewing', 'saved', 'previewed'].includes(next.state) &&
      !next.practice &&
      !next.sourceDraftPending &&
      (edits.size > 0 || !next.paidEstimate)
    );
  }
  function schedule() {
    window.clearTimeout(timer);
    if (!running && !error && needed(getSetup()) && available() && !conflicts(getSetup()).length)
      timer = window.setTimeout(refresh, 220);
  }
  function change(name) {
    const key = name === 'samples' ? 'sampleCount' : name;
    const value = read()[key];
    const current = getSetup();
    if (!edits.size)
      editScope = {
        key: scopeOf(current),
        label: scopeLabel(current),
        revision: current.reassessmentScopeRevision,
      };
    discarded = undefined;
    scopeNotice.hidden = true;
    const prior = edits.get(key);
    edits.set(key, {
      base: prior ? prior.base : getSetup()[key],
      value: key === 'cacheDir' && value !== null ? value.trim() : value,
    });
    generation++;
    error = '';
    sync();
    schedule();
  }
  async function refresh() {
    const current = getSetup();
    if (running || !needed(current) || !available() || conflicts(current).length) return;
    if (edits.size && editScope.key !== scopeOf(current)) return;
    const submitted = new Map(edits);
    const { model, sampleCount, cacheDir, noCache } = {
      ...current,
      ...Object.fromEntries([...submitted].map(([key, edit]) => [key, edit.value])),
    };
    if (
      !/^google:[^\s:]+$/.test(model) ||
      !Number.isInteger(sampleCount) ||
      sampleCount < 2 ||
      (cacheDir !== null && !cacheDir.trim())
    ) {
      error = 'Enter a google:model name, at least two samples and a valid cache directory.';
      sync();
      return;
    }
    const started = generation;
    running = true;
    sync();
    try {
      const next = await request('ai/estimate', 'POST', {
        configurationRevision: current.configurationRevision,
        contentRevision: current.contentRevision,
        loadRevision: current.loadRevision,
        estimateRevision: current.estimateRevision,
        reassessmentScopeRevision: submitted.size
          ? editScope.revision
          : current.reassessmentScopeRevision,
        model,
        sampleCount,
        cacheDir,
        noCache,
      });
      if (!olderSetup(getSetup(), next)) {
        for (const [key, edit] of submitted) {
          const latest = edits.get(key);
          if (latest === edit) edits.delete(key);
          else if (latest) edits.set(key, { ...latest, base: next[key] });
        }
        render(next);
      }
    } catch (failure) {
      try {
        const latest = await request('setup');
        render(latest);
        // An unchanged scope can rebase disjoint settings after a revision conflict.
        if (
          started === generation &&
          current.configurationRevision === latest.configurationRevision &&
          current.contentRevision === latest.contentRevision &&
          current.estimateRevision === latest.estimateRevision
        )
          error = failure.message;
      } catch {
        if (started === generation) error = 'The session could not be reached.';
      }
    } finally {
      running = false;
      sync();
      schedule();
    }
  }
  retry.addEventListener('click', () => {
    const current = getSetup();
    if (retry.hidden || (edits.size && editScope.key !== scopeOf(current))) return;
    for (const [key, edit] of conflicts(current)) edits.set(key, { ...edit, base: current[key] });
    error = '';
    sync();
    schedule();
  });
  return {
    async select(body) {
      if (!available() || edits.size || running || selecting || error || dirty())
        throw new Error('Wait for the current request estimate.');
      selecting = true;
      sync();
      try {
        const next = await request('review/rerun', 'POST', body);
        if (olderSetup(getSetup(), next))
          throw Object.assign(new Error('The review changed. Select reassessment again.'), {
            requestRejected: true,
          });
        discarded = undefined;
        render(next);
        return next;
      } catch (failure) {
        if (failure.status === 409) {
          try {
            render(await request('setup'));
          } catch {
            // Keep the rejection visible until the next session read succeeds.
          }
        }
        throw failure;
      } finally {
        selecting = false;
        sync();
        schedule();
      }
    },
    change,
    schedule,
    rebase,
    get edited() {
      return edits.size > 0;
    },
    get running() {
      return running || selecting;
    },
    get blocked() {
      return edits.size > 0 || running || Boolean(error);
    },
    message() {
      const current = getSetup();
      const changed = conflicts(current);
      retry.hidden = !error && !changed.length;
      retry.textContent = changed.length ? 'Use my conflicting settings' : 'Retry estimate';
      if (changed.length) {
        const values = changed.map(
          ([key, edit]) =>
            `${fieldNames[key]} changed to ${describe(current[key])} in the session. Your form shows ${describe(edit.value)}.`
        );
        return `AI settings changed in another tab. ${values.join(' ')} Enter the session value to keep it, or choose Use my conflicting settings.`;
      }
      if (error) return `Estimate unavailable. ${error}`;
      if (needed(getSetup()) || running) return 'Preparing the current request estimate…';
      return '';
    },
  };
}
