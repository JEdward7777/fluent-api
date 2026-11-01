const launchedToken = window.location.hash.slice(1);
if (launchedToken) window.sessionStorage.setItem('license-workbench-token', launchedToken);
const token = launchedToken || window.sessionStorage.getItem('license-workbench-token');
window.history.replaceState(null, '', window.location.pathname + window.location.search);
const status = document.getElementById('status');
const form = document.getElementById('setup');
const inspect = document.getElementById('inspect');
const analyze = document.getElementById('analyze');
const stop = document.getElementById('stop');
const inspection = document.getElementById('inspection');
let setup;
let dirty = false;

async function request(path, method = 'GET', body) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: {
      'x-workbench-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function render(next, populate = false) {
  setup = next;
  if (populate) {
    for (const key of [
      'source',
      'destination',
      'input',
      'output',
      'model',
      'cacheDir',
      'reportFormats',
      'reportDir',
    ])
      form.elements[key].value = next[key] ?? '';
    form.elements.samples.value = next.sampleCount;
    for (const key of ['force', 'noCache']) form.elements[key].checked = next[key];
    form.elements.preserve.checked = next.preserveExistingNonUnknowns;
    dirty = false;
  }
  form.hidden = false;
  document.getElementById('discard-label').hidden = !next.analysis;
  document.getElementById('database-target').textContent = next.databaseTarget;
  const step = ['inspected', 'analyzing'].includes(next.state)
    ? 'Analyze'
    : ['reviewing', 'previewing'].includes(next.state)
      ? 'Review'
      : ['previewed', 'saving'].includes(next.state)
        ? 'Preview changes'
        : next.state === 'saved'
          ? 'Save'
          : 'Choose inputs';
  for (const item of document.querySelectorAll('nav li')) {
    if (item.textContent === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  document.getElementById('cli-command').textContent = [
    'npm run db:classify:licenses -- --ui=cli',
    ...(next.source ? [`--source=${quote(next.source)}`] : []),
    ...(next.destination ? [`--destination=${quote(next.destination)}`] : []),
    `--input=${quote(next.input)}`,
    `--output=${quote(next.output)}`,
    `--model=${quote(next.model)}`,
    `--sample-count=${next.sampleCount}`,
    `--report-formats=${quote(next.reportFormats)}`,
    ...(next.reportDir ? [`--report-dir=${quote(next.reportDir)}`] : []),
    ...(next.cacheDir ? [`--cache-dir=${quote(next.cacheDir)}`] : []),
    ...(next.noCache ? ['--no-cache'] : []),
    ...(next.force ? ['--force'] : []),
    ...(next.preserveExistingNonUnknowns ? ['--preserve-existing-non-unknowns'] : []),
  ].join(' ');
  const busy = ['inspecting', 'analyzing', 'saving', 'reconfiguring'].includes(next.state);
  for (const field of form.elements) field.disabled = busy;
  inspect.disabled =
    busy ||
    dirty ||
    !next.readyForInspect ||
    (next.state !== 'configuring' && next.state !== 'error');
  analyze.disabled = busy || dirty || next.state !== 'inspected';
  stop.hidden = next.state !== 'analyzing';
  stop.disabled = next.state !== 'analyzing';
  inspection.hidden = !next.inspected;
  if (next.inspected) {
    const preflight = next.inspected.preflight;
    inspection.textContent = `Inspected ${next.inspected.inspectedAt}. ${preflight.distinctKeys} distinct keys; ${preflight.tableHits} table hits; ${preflight.ruleHits} rule hits; ${preflight.modelKeys} model keys. ${preflight.validCacheHits} valid cache hits; ${preflight.expectedUncachedRequests} expected requests, up to ${preflight.maximumAttempts} attempts. Cost unavailable: ${preflight.cost.reason}`;
  }
  if (next.analysis)
    status.textContent = `Analysis ready: ${next.analysis.rows} rows. Review controls follow in the next workbench step.`;
  else if (next.state === 'inspected')
    status.textContent = 'Inputs inspected. Review the request estimate, then start analysis.';
  else if (next.latestOperation?.state === 'failed')
    status.textContent = next.latestOperation.error;
  else if (busy)
    status.textContent = `${next.state}… You can reload this page without restarting the operation.`;
  else status.textContent = `Session ${next.state}. Apply settings, then Inspect inputs.`;
}
async function refresh() {
  render(await request('setup'));
  if (setup.activeOperationId) {
    const operation = await request(`operations/${encodeURIComponent(setup.activeOperationId)}`);
    if (operation.state === 'failed') status.textContent = operation.error;
    if (operation.state === 'running') window.setTimeout(refresh, 800);
  }
}
form.addEventListener('input', () => {
  dirty = true;
  inspect.disabled = true;
  analyze.disabled = true;
  status.textContent = 'Settings changed. Apply settings before inspecting.';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const values = form.elements;
    const discardReviewedState = Boolean(setup.analysis && values.discardReviewedState.checked);
    if (setup.analysis && !discardReviewedState) {
      status.textContent = 'Check the discard box before replacing reviewed decisions.';
      return;
    }
    status.textContent = 'Applying settings…';
    render(
      await request('setup', 'POST', {
        configurationRevision: setup.configurationRevision,
        discardReviewedState,
        source: values.source.value || null,
        destination: values.destination.value || null,
        input: values.input.value,
        output: values.output.value,
        model: values.model.value,
        sampleCount: Number(values.samples.value),
        cacheDir: values.cacheDir.value || null,
        reportFormats: values.reportFormats.value,
        reportDir: values.reportDir.value || null,
        force: values.force.checked,
        noCache: values.noCache.checked,
        preserveExistingNonUnknowns: values.preserve.checked,
      }),
      true
    );
  } catch (error) {
    status.textContent = error.message;
  }
});
async function start(kind) {
  try {
    await request(kind, 'POST', {
      operationId: crypto.randomUUID(),
      configurationRevision: setup.configurationRevision,
    });
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
}
inspect.addEventListener('click', () => start('inspect'));
analyze.addEventListener('click', () => start('analysis'));
stop.addEventListener('click', async () => {
  try {
    await request('stop', 'POST');
    status.textContent = 'Stop requested after the current key.';
  } catch (error) {
    status.textContent = error.message;
  }
});
if (!token)
  status.textContent =
    'Open the exact local URL printed by the workbench. Its fragment contains this session’s access token.';
else {
  try {
    render(await request('setup'), true);
    if (setup.activeOperationId) await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
}
