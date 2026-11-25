const settingFields = [
  ['source', 'source', 'source'],
  ['destination', 'destination', 'destination'],
  ['input', 'input', 'input path'],
  ['output', 'output', 'output path'],
  ['model', 'model', 'model'],
  ['samples', 'sampleCount', 'samples'],
  ['cacheDir', 'cacheDir', 'cache directory'],
  ['reportFormats', 'reportFormats', 'report formats'],
  ['reportDir', 'reportDir', 'report directory'],
  ['force', 'force', 'replacement option'],
  ['noCache', 'noCache', 'cache option'],
  ['preserve', 'preserveExistingNonUnknowns', 'preserve status'],
];
const optionalFields = ['source', 'destination', 'cacheDir', 'reportDir'];
const paths = ['input', 'output', 'cacheDir', 'reportDir'];
const connectionFields = [
  ['databaseHost', 'host', ''],
  ['databasePort', 'port', 5432],
  ['databaseName', 'database', ''],
  ['databaseUsername', 'username', ''],
  ['databaseTls', 'tls', 'verify-full'],
];

const reportFormats = (value) =>
  [...new Set(value.split(',').map((part) => part.trim()))].sort().reverse().join(',');

function displaySetting(form, applied, name, key) {
  const field = form.elements[name];
  if (field.type === 'checkbox') field.checked = applied[key];
  else field.value = key === 'reportFormats' ? reportFormats(applied[key]) : (applied[key] ?? '');
}

function settingChanged(applied, draft, key) {
  const expected = key === 'reportFormats' ? reportFormats(applied[key]) : applied[key];
  const value = draft[key];
  return value !== expected && !(paths.includes(key) && value?.trim() === expected);
}

const fixedPracticeFields = new Set([
  'source',
  'destination',
  'output',
  'model',
  'samples',
  'force',
  'noCache',
  'cacheDir',
  'reportFormats',
  'reportDir',
  'preserve',
]);

export function syncSettingsFields(form, locked, practice) {
  for (const field of form.elements) {
    field.disabled = locked || (practice && fixedPracticeFields.has(field.name));
  }
}

export function rebaseSettings(form, prior, next) {
  if (prior.configurationRevision === next.configurationRevision) return;
  const draft = readSettings(form, {});
  for (const [name, key] of settingFields) {
    if (prior[key] !== next[key] && !settingChanged(prior, draft, key))
      displaySetting(form, next, name, key);
  }
}

export function populateSettings(form, applied) {
  const fields = form.elements;
  for (const [name, key] of settingFields) displaySetting(form, applied, name, key);
  populateConnection(form, applied[`${form.elements.databaseRole.value}DatabaseConnection`]);
  fields.discardReviewedState.checked = false;
}

export function populateConnection(form, connection) {
  const fields = form.elements;
  fields.databaseMode.value = connection.mode;
  for (const [name, key, fallback] of connectionFields)
    fields[name].value = connection[key] ?? fallback;
  fields.databasePassword.value = connection.password ?? '';
  fields.databaseClearPassword.checked = Boolean(connection.clearPassword);
}

export function readSettings(form, databaseConnection) {
  const pairs = settingFields.map(([name, key]) => {
    const field = form.elements[name];
    const { value } = field;
    const typed =
      field.type === 'checkbox'
        ? field.checked
        : field.type === 'number'
          ? Number(value)
          : optionalFields.includes(key)
            ? value || null
            : value;
    return [key, typed];
  });
  return { ...Object.fromEntries(pairs), ...databaseConnection };
}

export function pendingSettings(applied, draft) {
  const changed = settingFields
    .filter(([, key]) => settingChanged(applied, draft, key))
    .map(([, , label]) => label);
  for (const role of ['source', 'destination']) {
    const entered = draft[`${role}DatabaseConnection`];
    if (entered && changedConnection(applied[`${role}DatabaseConnection`], entered))
      changed.push(`${role} database connection`);
  }
  return changed.join(', ');
}

export function changedConnection(current, entered) {
  return (
    entered.mode !== current.mode ||
    (entered.mode === 'session' &&
      (entered.password ||
        entered.clearPassword ||
        connectionFields.some(([, key]) => {
          const value = entered[key];
          return (typeof value === 'string' ? value.trim() : value) !== current[key];
        })))
  );
}

export function roleConnectionDrafts(form, draftDatabase, getSetup, onChange) {
  let databaseRole = 'source';
  let roleDrafts = {};
  const conflicts = new Set();
  const appliedConnection = () => getSetup()?.[`${databaseRole}DatabaseConnection`];
  const readDraft = () => {
    const connections = {};
    for (const [role, draft] of Object.entries({
      ...roleDrafts,
      [databaseRole]: draftDatabase.read(),
    })) {
      if (changedConnection(getSetup()[`${role}DatabaseConnection`], draft))
        connections[`${role}DatabaseConnection`] = draft;
    }
    return readSettings(form, connections);
  };
  form.elements.databaseRole.addEventListener('change', () => {
    roleDrafts[databaseRole] = draftDatabase.read();
    databaseRole = form.elements.databaseRole.value;
    populateConnection(form, roleDrafts[databaseRole] ?? appliedConnection());
    draftDatabase.invalidate();
    draftDatabase.syncFields(appliedConnection());
    onChange();
  });
  return {
    readDraft,
    appliedConnection,
    discardConfirmation() {
      const setup = getSetup();
      return setup.analysis && form.elements.discardReviewedState.checked
        ? { discardReviewedState: true, expectedContentRevision: setup.contentRevision }
        : { discardReviewedState: false };
    },
    get conflict() {
      if (!conflicts.size) return '';
      return `The ${[...conflicts].join(' and ')} database connection changed in another tab. Restore applied settings to discard local settings changes and review the current connection before re-entering credentials.`;
    },
    get role() {
      return databaseRole;
    },
    rebase(prior, next) {
      for (const role of ['source', 'destination']) {
        const key = `${role}DatabaseConnection`;
        if (prior[`${role}Revision`] === next[`${role}Revision`]) continue;
        const active = role === databaseRole;
        const draft = active ? draftDatabase.read() : roleDrafts[role];
        if (draft && changedConnection(prior[key], draft)) {
          if (prior[`${role}ConnectionRevision`] !== next[`${role}ConnectionRevision`])
            conflicts.add(role);
        } else if (draft) {
          delete roleDrafts[role];
          if (active) populateConnection(form, next[key]);
        }
      }
    },
    refresh(prior, next, populate) {
      const revision = `${databaseRole}Revision`;
      if (prior && prior[revision] !== next[revision]) draftDatabase.invalidate();
      if (populate) {
        const priorDraft = draftDatabase.read();
        conflicts.clear();
        roleDrafts = {};
        populateSettings(form, next);
        if (JSON.stringify(priorDraft) !== JSON.stringify(draftDatabase.read()))
          draftDatabase.invalidate();
      } else if (prior) {
        rebaseSettings(form, prior, next);
        this.rebase(prior, next);
      }
    },
    reset() {
      conflicts.clear();
      roleDrafts = {};
    },
  };
}

export function equivalentCliCommand(next) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [
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
}
