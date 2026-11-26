const settingFields = [
  ['source', 'source', 'source', 'load'],
  ['destination', 'destination', 'destination', 'save'],
  ['input', 'input', 'input path', 'load'],
  ['output', 'output', 'output path', 'save'],
  ['model', 'model', 'model', 'ai'],
  ['samples', 'sampleCount', 'samples', 'ai'],
  ['cacheDir', 'cacheDir', 'cache directory', 'ai'],
  ['reportFormats', 'reportFormats', 'report formats', 'save'],
  ['reportDir', 'reportDir', 'report directory', 'save'],
  ['force', 'force', 'replacement option', 'save'],
  ['noCache', 'noCache', 'cache option', 'ai'],
  ['preserve', 'preserveExistingNonUnknowns', 'preserve status', 'save'],
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

export function pendingSettings(applied, draft, stages) {
  const changed = settingFields
    .filter(([, key, , stage]) => {
      if (stages && !stages.includes(stage)) return false;
      if (key === 'input' && draft.source !== 'json') return false;
      if (key === 'output' && !['json', 'both'].includes(draft.destination)) return false;
      return settingChanged(applied, draft, key);
    })
    .map(([, , label]) => label);
  for (const role of ['source', 'destination']) {
    if (stages && !stages.includes(role === 'source' ? 'load' : 'save')) continue;
    const entered = draft[`${role}DatabaseConnection`];
    if (
      ['database', 'both'].includes(draft[role]) &&
      entered &&
      changedConnection(applied[`${role}DatabaseConnection`], entered)
    )
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
  let submittedLoad;
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
    draftDatabase.syncFields(appliedConnection());
    onChange();
  });
  return {
    readDraft,
    pending(...stages) {
      const setup = getSetup();
      if (!setup) return '';
      const draft = readDraft();
      const affected = [...conflicts].filter(
        (role) =>
          ['database', 'both'].includes(draft[role]) &&
          (!stages.length || stages.includes(role === 'source' ? 'load' : 'save'))
      );
      const changes = pendingSettings(setup, draft, stages.length ? stages : undefined);
      return [changes, ...affected.map((role) => `${role} database connection conflict`)]
        .filter(Boolean)
        .join(', ');
    },
    stageSubmission(stage) {
      const applied = getSetup();
      const draft = readDraft();
      const fields = settingFields.filter(([name]) => {
        const label = form.elements[name].closest('label');
        return label?.dataset.stage === stage && !label.hidden;
      });
      const body = Object.fromEntries(settingFields.map(([, key]) => [key, applied[key]]));
      for (const [, key] of fields) body[key] = draft[key];
      const role = stage === 'load' ? 'source' : stage === 'save' ? 'destination' : null;
      const connection =
        role && ['database', 'both'].includes(body[role]) && draft[`${role}DatabaseConnection`];
      if (connection) body[`${role}DatabaseConnection`] = connection;
      const confirmation =
        stage === 'load' ? this.discardConfirmation() : { discardReviewedState: false };
      return {
        body: { ...body, configurationRevision: applied.configurationRevision, ...confirmation },
        fields,
        role: connection ? role : null,
      };
    },
    get loading() {
      return Boolean(submittedLoad);
    },
    submitLoad(id) {
      const { body, fields, role } = this.stageSubmission('load');
      submittedLoad = { id, fields, role, loadRevision: getSetup().loadRevision };
      const source = body.source;
      if (source === 'database') return { source, connection: body.sourceDatabaseConnection };
      return {
        source,
        input: getSetup().practice ? body.input.trim() || 'Bundled example' : body.input,
      };
    },
    rejectLoad(id = submittedLoad?.id) {
      if (submittedLoad?.id === id) submittedLoad = undefined;
    },
    appliedConnection,
    discardConfirmation() {
      const setup = getSetup();
      return setup.analysis && form.elements.discardReviewedState.checked
        ? { discardReviewedState: true, expectedContentRevision: setup.contentRevision }
        : { discardReviewedState: false };
    },
    conflicted(role) {
      return conflicts.has(role);
    },
    get conflict() {
      if (!conflicts.size) return '';
      return `The ${[...conflicts].join(' and ')} database connection changed in another tab. Restore settings on the affected stage to review the current connection before re-entering credentials.`;
    },
    get role() {
      return databaseRole;
    },
    rebase(prior, next, acceptedRole) {
      for (const role of ['source', 'destination']) {
        const key = `${role}DatabaseConnection`;
        const active = role === databaseRole;
        if (role === acceptedRole) {
          delete roleDrafts[role];
          if (active) populateConnection(form, next[key]);
          continue;
        }
        if (prior[`${role}Revision`] === next[`${role}Revision`]) continue;
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
    refresh(prior, next, populate, accepted) {
      if (submittedLoad) {
        const receipt = next.lastSourceLoad;
        if (receipt?.operationId === submittedLoad.id) {
          if (receipt.sourceRevision === next.sourceRevision) accepted = submittedLoad;
          submittedLoad = undefined;
        } else if (
          next.loadRevision > submittedLoad.loadRevision ||
          (next.latestOperation?.operationId === submittedLoad.id &&
            next.latestOperation.state === 'failed')
        ) {
          submittedLoad = undefined;
        }
      }
      for (const role of ['source', 'destination']) {
        const revision = `${role}Revision`;
        if (prior && prior[revision] !== next[revision]) draftDatabase.invalidate(role);
      }
      if (populate) {
        const priorDraft = draftDatabase.read();
        conflicts.clear();
        roleDrafts = {};
        populateSettings(form, next);
        if (JSON.stringify(priorDraft) !== JSON.stringify(draftDatabase.read()))
          draftDatabase.invalidate();
      } else if (prior) {
        rebaseSettings(form, prior, next);
        this.rebase(prior, next, accepted?.role);
        for (const [name, key] of accepted?.fields ?? []) displaySetting(form, next, name, key);
      }
    },
    restoreConnection(role) {
      conflicts.delete(role);
      delete roleDrafts[role];
      draftDatabase.invalidate(role);
      if (databaseRole === role) populateConnection(form, getSetup()[`${role}DatabaseConnection`]);
    },
    restore(stage) {
      const applied = getSetup();
      for (const [name, key, , owner] of settingFields)
        if (stage === owner) displaySetting(form, applied, name, key);
      if (stage === 'load') form.elements.discardReviewedState.checked = false;
      const role = stage === 'load' ? 'source' : stage === 'save' ? 'destination' : null;
      if (role) this.restoreConnection(role);
    },
  };
}

export function stageSettingsActions(form, drafts, isBlocked, onRestore) {
  const restoreSettings = document.getElementById('restore-settings');
  const applySettings = document.getElementById('apply-settings');
  const databaseTest = document.getElementById('database-test');
  const settingsChangeStatus = document.getElementById('settings-change-status');
  const reload = document.getElementById('reload-source-connection');
  let currentStage = 'load';
  reload.addEventListener('click', () => {
    drafts.restoreConnection('source');
    onRestore();
  });
  restoreSettings.addEventListener('click', () => {
    drafts.restore(currentStage);
    onRestore();
    document.getElementById('status').textContent = 'Applied settings restored for this stage.';
  });
  return (next, stage) => {
    currentStage = stage;
    const blocked = isBlocked(next);
    restoreSettings.disabled = blocked;
    reload.disabled = blocked;
    document.getElementById('discard-label').hidden =
      !next.analysis ||
      !(drafts.pending('load') || next.sourceDraftPending) ||
      ['inspected', 'saved', 'error'].includes(next.state);

    databaseTest.disabled =
      blocked || drafts.conflicted(drafts.role) || next.practice || next.state === 'uncertain';
    const role = stage === 'load' ? 'source' : stage === 'save' ? 'destination' : null;
    const conflicted =
      role && ['database', 'both'].includes(form.elements[role].value) && drafts.conflicted(role);
    applySettings.disabled = blocked || conflicted;
    reload.hidden = !(stage === 'load' && conflicted);
    const changes = drafts.pending(stage);
    settingsChangeStatus.textContent = conflicted
      ? stage === 'load'
        ? 'The source connection changed in another tab. Review its current settings before re-entering credentials.'
        : drafts.conflict
      : stage === 'load' && changes
        ? 'Load source to use these settings. Your current review stays available until the new source loads.'
        : changes
          ? `Pending settings changes: ${changes}. Apply or restore this stage’s settings.`
          : '';
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
