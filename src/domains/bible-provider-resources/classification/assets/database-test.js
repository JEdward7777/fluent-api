import { changedConnection } from './settings-draft.js';

export function createDraftDatabaseTest(form, request, confirm, updateControls, appliedStatus) {
  const databaseFields = document.getElementById('session-database-fields');
  const databasePasswordState = document.getElementById('database-password-state');
  const result = document.getElementById('database-test-result');
  const generations = { source: 0, destination: 0 };
  const messages = { source: '', destination: '' };
  const draftResults = { source: '', destination: '' };
  const activeRole = () => form.elements.databaseRole.value;
  const showResult = () => {
    const role = activeRole();
    const applied = appliedStatus(role);
    result.textContent =
      messages[role] ||
      (applied === 'passed'
        ? 'Applied connection passed.'
        : applied === 'failed'
          ? 'Applied connection failed. Test again for connection details.'
          : '');
    result.dataset.state = result.textContent.includes('connection failed') ? 'error' : '';
  };
  let running = false;

  function syncFields(current) {
    showResult();
    const fields = form.elements;
    const selected = fields.databaseMode.value === 'session';
    databaseFields.hidden = !selected;
    for (const key of ['databaseHost', 'databasePort', 'databaseName', 'databaseUsername'])
      fields[key].required = selected;

    const retained = selected && current?.mode === 'session' && current.passwordRetained;
    const sameConnection =
      retained &&
      fields.databaseHost.value.trim() === current.host &&
      Number(fields.databasePort.value) === current.port &&
      fields.databaseName.value.trim() === current.database &&
      fields.databaseUsername.value.trim() === current.username &&
      fields.databaseTls.value === current.tls;
    const clearing = fields.databaseClearPassword.checked;
    fields.databasePassword.placeholder = sameConnection && !clearing ? '••••••••' : '';
    databasePasswordState.textContent = clearing
      ? 'Applying these settings clears the password.'
      : sameConnection
        ? 'Password retained for this connection. Enter a password to replace it.'
        : retained
          ? 'Re-enter the password for the changed connection.'
          : '';
  }

  function read() {
    const fields = form.elements;
    if (fields.databaseMode.value === 'environment') return { mode: 'environment' };
    return {
      mode: 'session',
      host: fields.databaseHost.value,
      port: Number(fields.databasePort.value),
      database: fields.databaseName.value,
      username: fields.databaseUsername.value,
      password: fields.databaseClearPassword.checked ? '' : fields.databasePassword.value,
      clearPassword: fields.databaseClearPassword.checked,
      tls: fields.databaseTls.value,
    };
  }

  function invalidate(role = activeRole()) {
    generations[role]++;
    messages[role] = '';
    draftResults[role] = '';
    showResult();
  }

  async function run(configurationRevision, role, applied) {
    if (running) return;
    const databaseConnection = read();
    if (databaseConnection.mode === 'session') {
      const invalid = [...databaseFields.querySelectorAll('input, select')].find(
        (field) => !field.checkValidity()
      );
      if (invalid) {
        invalid.reportValidity();
        return;
      }
    }
    const draft = changedConnection(applied, databaseConnection);
    const label = draft ? 'Draft connection' : 'Applied connection';
    const startedGeneration = generations[role];
    running = true;
    updateControls();
    messages[role] = `Testing ${label.toLowerCase()}…`;
    showResult();
    let test = 'passed';
    let outcome = draft
      ? role === 'source'
        ? 'Draft connection passed. Load source to use it.'
        : 'Draft connection passed. Apply destination settings to use it.'
      : 'Applied connection passed.';
    try {
      await request('database/test', 'POST', {
        configurationRevision,
        ...(draft ? { databaseConnection } : {}),
        role,
      });
    } catch (error) {
      test = 'failed';
      outcome = `${label} failed: ${error.message}`;
    }
    try {
      const confirmed = await confirm(configurationRevision, role);
      if (startedGeneration === generations[role]) {
        messages[role] = confirmed ? outcome : '';
        draftResults[role] = confirmed && draft ? test : '';
        showResult();
        if (!confirmed) return document.getElementById('status');
        if (test === 'failed' && activeRole() === role) return result;
      }
    } finally {
      running = false;
      updateControls();
    }
  }

  return {
    syncFields,
    read,
    draftStatus: (role) => draftResults[role],
    invalidate,
    run,
    get running() {
      return running;
    },
  };
}
