export function createDraftDatabaseTest(form, request, confirm, updateControls) {
  const databaseFields = document.getElementById('session-database-fields');
  const databasePasswordState = document.getElementById('database-password-state');
  const result = document.getElementById('database-test-result');
  let generation = 0;
  let running = false;

  function syncFields(current) {
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

  function invalidate() {
    generation++;
    result.textContent = '';
  }

  async function run(configurationRevision, role) {
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
    const startedGeneration = generation;
    running = true;
    updateControls();
    result.textContent = 'Testing the entered connection…';
    let outcome = 'Entered connection passed. Apply settings to use it for review.';
    try {
      await request('database/test', 'POST', { configurationRevision, databaseConnection, role });
    } catch (error) {
      outcome = `Entered connection: ${error.message}`;
    }
    try {
      const confirmed = await confirm(configurationRevision, role);
      if (startedGeneration === generation) {
        const unchanged = JSON.stringify(databaseConnection) === JSON.stringify(read());
        result.textContent = confirmed && unchanged ? outcome : '';
      }
    } finally {
      running = false;
      updateControls();
    }
  }

  return {
    syncFields,
    read,
    invalidate,
    run,
    get running() {
      return running;
    },
  };
}
