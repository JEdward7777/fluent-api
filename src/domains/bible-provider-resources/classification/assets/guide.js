import { equivalentCliCommand } from './settings-draft.js';

const instructions = {
  load: 'Choose a source and load it to prepare its free evidence.',
  ai: 'Check the model, samples and request estimate before starting paid classification.',
  review: 'Open a notice to review its classification and evidence.',
  save: 'Choose a destination and inspect the proposed changes before saving.',
};
const names = { load: 'Load', ai: 'AI classification', review: 'Review', save: 'Save' };

// Disabling the submitting button may return focus to the body while the request runs.
export function trackActionFocus() {
  let version = 0;
  const moved = () => {
    version++;
  };
  for (const event of ['focusin', 'input', 'pointerdown', 'keydown'])
    document.addEventListener(event, moved, true);
  window.addEventListener('popstate', moved);
  return () => {
    const started = version;
    const opener = document.activeElement;
    return (error) => {
      if (
        started === version &&
        error?.getClientRects().length &&
        (document.activeElement === opener || document.activeElement === document.body)
      )
        error.focus();
    };
  };
}

function configureStageHelp(practice) {
  document.getElementById('operations-heading').textContent = practice
    ? 'Workflow modes'
    : 'What the selections mean';
  document.getElementById('alternatives-note').textContent = practice
    ? 'Practice uses saved JSON → scratch JSON. Database targets require a separate normal workbench launch.'
    : 'Both previews JSON and database destinations independently. Cross-storage sync preserves stronger destination decisions and omitted rows.';
  document.getElementById('inspect-help').textContent = practice
    ? 'Load reads the selected saved JSON or bundled example and copies it into a new private scratch directory. No model or database is used.'
    : 'Load reads selected files, database and request cache as needed.';
  document.getElementById('analysis-help').textContent = practice
    ? 'Practice analysis uses saved JSON evidence without model requests.'
    : 'Load applies rule matches and complete cached assessments. Missing samples stay unchanged and are counted below. This action sends zero model requests.';
}

export function createStageNavigation(
  form,
  { getSetup, pushStage, draftStatus, onVisit, syncRoleActions, hasAiDraft, onStage }
) {
  const links = [...document.querySelectorAll('[data-route]')];
  const nextLink = document.getElementById('stage-next');
  const statusLinks = [...document.querySelectorAll('.stage-links a:not(#back-results-top)')];
  const heading = document.getElementById('setup-heading');
  let stage = 'load';
  let initialized = false;
  let aiAvailable = false;
  let needsAi = false;

  const usesDatabase = (role) => ['database', 'both'].includes(form.elements[role].value);

  function display(next) {
    if (!next) return;
    const waiting = !next.analysis && new URL(location.href).searchParams.get('stage') === 'review';
    document.getElementById('shared-review-wait').hidden = !waiting;
    document.getElementById('shared-review').hidden = false;
    const role =
      stage === 'save'
        ? 'destination'
        : stage === 'load'
          ? 'source'
          : form.elements.databaseRole.value;
    const database = !next.practice && ['load', 'save'].includes(stage) && usesDatabase(role);
    const selector = form.elements.databaseRole;
    if (selector.value !== role) {
      selector.value = role;
      selector.dispatchEvent(new Event('change'));
    }
    for (const item of document.querySelectorAll('[data-stage]'))
      item.classList.toggle('stage-hidden', !item.dataset.stage.split(' ').includes(stage));
    for (const id of [
      'database-settings',
      'database-test',
      'database-test-result',
      'database-target',
    ])
      document.getElementById(id).classList.toggle('stage-hidden', !database);
    document.getElementById('database-target').textContent = next[`${role}DatabaseTarget`];
    document.getElementById('connection-heading').textContent =
      stage === 'save' ? 'Destination database connection' : 'Source database connection';
    document.getElementById('database-test').textContent = `Test ${role} connection`;
    form.elements.input.closest('label').hidden = form.elements.source.value !== 'json';
    form.elements.output.closest('label').hidden = !['json', 'both'].includes(
      form.elements.destination.value
    );
    form.classList.toggle('stage-hidden', stage === 'review');
    document.getElementById('stage-instructions').textContent = instructions[stage];
    heading.textContent = names[stage];
    document.title = `${names[stage]} · License workbench`;
    for (const link of links) {
      const enabled = link.dataset.route !== 'ai' || aiAvailable;
      link.setAttribute('aria-disabled', String(!enabled));
      if (enabled) link.href = `?stage=${link.dataset.route}`;
      else link.removeAttribute('href');
      if (link.dataset.route === stage) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    for (const id of ['paid', 'paid-reason'])
      document
        .getElementById(id)
        .classList.toggle(
          'stage-hidden',
          stage !== 'ai' && !(stage === 'load' && !aiAvailable && (next.analysis || next.practice))
        );
    const reviewReady = document.getElementById('review-ready');
    reviewReady.hidden = !next.analysis || stage === 'review';
    reviewReady.textContent = `Review available · ${next.analysis?.rows ?? 0} rows`;
    const saveReady = document.getElementById('save-ready');
    saveReady.hidden =
      stage === 'save' ||
      (!next.preview && !next.analysis?.pendingReviews && next.state !== 'uncertain');
    saveReady.textContent =
      next.state === 'uncertain'
        ? 'Check Save outcome'
        : next.analysis?.pendingReviews
          ? `Save · ${next.analysis.pendingReviews} pending`
          : 'View Save preview';
    for (const connectionRole of ['source', 'destination']) {
      const link = document.getElementById(`${connectionRole}-test-status`);
      const test = next[`${connectionRole}DatabaseTest`];
      const draft = draftStatus(connectionRole);
      const results = [
        test && test !== 'untested' && `applied ${test}`,
        draft && `draft ${draft}`,
      ].filter(Boolean);
      link.hidden = !results.length || next.practice || !usesDatabase(connectionRole);
      link.textContent = `${connectionRole === 'source' ? 'Source' : 'Destination'} connection · ${results.join(' · ')}`;
    }
    const target = { load: needsAi ? 'ai' : 'review', ai: 'review', review: 'save' }[stage];
    nextLink.hidden = !target || !next.analysis || next.sourceDraftPending;
    nextLink.href = `?stage=${target}`;
    nextLink.textContent = `Next → ${names[target] ?? ''}`;
    syncRoleActions(next, stage);
  }

  async function navigate(target, traversal = false) {
    if (!Object.hasOwn(names, target)) return;
    if (target === 'ai' && !aiAvailable) {
      if (!traversal) return;
      target = getSetup()?.analysis ? 'review' : 'load';
      const fallback = new URL(location.href);
      fallback.searchParams.set('stage', target);
      history.replaceState(history.state, '', fallback);
    }
    onVisit();
    const requested = new URL(location.href).searchParams.get('stage');
    if (target === stage && (!requested || requested === target)) {
      if (!traversal) onStage(stage);
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('stage', target);
    if (!traversal && !(await pushStage(url))) return;
    stage = target === 'review' && !getSetup().analysis ? 'load' : target;
    display(getSetup());
    heading.focus();
    onStage(stage);
  }
  for (const link of [...links, nextLink, ...statusLinks])
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      if (!link.hasAttribute('href')) return;
      const target = new URL(link.href).searchParams.get('stage');
      await navigate(target);
      if (link.id.endsWith('-test-status') && !link.hidden && stage === target) {
        const field = form.elements.databaseMode;
        (field.disabled ? document.getElementById('database-test-result') : field).focus();
      }
    });
  form.addEventListener('change', () => display(getSetup()));
  window.addEventListener('review-location', () =>
    navigate(new URL(location.href).searchParams.get('stage') ?? 'load', true)
  );
  return {
    navigate,
    get current() {
      return stage;
    },
    update(next) {
      const change = next.reassessmentSourceChange;
      const notice = document.getElementById('reassessment-source-change');
      notice.hidden = !change;
      if (change) {
        notice.textContent =
          change.outcome === 'retained'
            ? `After source reconciliation, “${change.notice}” is still selected. Review its new estimate before starting paid classification.`
            : `${change.outcome === 'replaced' ? 'Loading the new source' : 'Reconciling the source'} closed the reassessment for “${change.notice}”. Estimates now cover the loaded source until you select a row.`;
      }
      needsAi =
        !next.practice &&
        Boolean(
          next.paidEstimate?.expectedUncachedRequests ||
          (next.analysis && !next.paidEstimate && !next.sourceDraftPending) ||
          (next.latestOperation?.kind === 'paid' && next.latestOperation.state === 'running')
        );
      aiAvailable =
        needsAi ||
        (!next.practice && !next.sourceDraftPending && (next.selectedModelId || hasAiDraft()));
      document.getElementById('ai-state').textContent = needsAi
        ? ''
        : aiAvailable
          ? next.selectedModelId
            ? 'Selected reassessment'
            : 'Updating AI settings'
          : next.practice
            ? 'Offline practice cannot call the model.'
            : next.analysis
              ? 'No model requests are needed.'
              : 'Load a source for its estimate.';
      if (!initialized) {
        configureStageHelp(next.practice);
        const requested = new URL(location.href).searchParams.get('stage');
        stage =
          Object.hasOwn(names, requested) && (requested !== 'ai' || aiAvailable)
            ? requested
            : next.state === 'uncertain'
              ? 'save'
              : 'load';
        if (requested !== stage) history.replaceState(history.state, '', `?stage=${stage}`);
        initialized = true;
      }
      if (new URL(location.href).searchParams.get('stage') === 'review')
        stage = next.analysis ? 'review' : 'load';
      display(next);
    },
    validate() {
      for (const field of form.elements) {
        if (!field.name || !field.willValidate || field.closest('[hidden], .stage-hidden'))
          continue;
        if (!field.checkValidity()) {
          const status = document.getElementById('status');
          status.dataset.state = 'error';
          const name = field.getAttribute('aria-label') || field.name;
          status.textContent = `${name}: ${field.validationMessage}`;
          const details = field.closest('details');
          if (details) details.open = true;
          field.reportValidity();
          return false;
        }
      }
      return true;
    },
  };
}

export function renderSetupContext(form, next, draft) {
  document.getElementById('practice-banner').hidden = !next.practice;
  document.getElementById('cli-details').hidden = next.practice;
  if (next.practice) {
    for (const key of ['output', 'cacheDir', 'reportDir', 'reportFormats'])
      form.elements[key].value = next[key] ?? '';
    document.getElementById('practice-location').textContent = next.scratch
      ? `Scratch: ${next.scratch}. Original SHA-256: ${next.originalHash}. Restart with --practice for a fresh session; discard this directory when finished. Practice output is never imported into a real session automatically.`
      : 'Load allocates scratch. Restart with --practice for a fresh session; discard the scratch directory when finished. Practice output is never imported into a real session automatically.';
  }
  const loaded = next.loadedSource;
  const database = loaded?.databaseConnection;
  const loadedLabel =
    database?.mode === 'session'
      ? `database ${database.database} at ${database.host}:${database.port}`
      : 'environment database';
  document.getElementById('cli-form-note').textContent = loaded
    ? `Command for the displayed settings. Currently loaded: ${loaded.source === 'json' ? loaded.input : loadedLabel}.`
    : 'Command for the displayed settings. No source loaded yet.';
  document.getElementById('cli-connection-note').textContent = ['source', 'destination'].some(
    (role) =>
      ['database', 'both'].includes(draft[role]) &&
      (draft[`${role}DatabaseConnection`] ?? next[`${role}DatabaseConnection`]).mode === 'session'
  )
    ? 'The CLI command below does not transfer this session database or its password. The CLI uses its own environment database connection.'
    : 'The CLI uses its environment database connection.';
  document.getElementById('cli-command').textContent = equivalentCliCommand(draft);
}
