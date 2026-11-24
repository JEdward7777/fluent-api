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

export function populateSettings(form, applied) {
  const fields = form.elements;
  for (const [name, key] of settingFields) {
    const field = fields[name];
    if (field.type === 'checkbox') field.checked = applied[key];
    else field.value = key === 'reportFormats' ? reportFormats(applied[key]) : (applied[key] ?? '');
  }
  const connection = applied.databaseConnection;
  fields.databaseMode.value = connection.mode;
  for (const [name, key, fallback] of connectionFields)
    fields[name].value = connection[key] ?? fallback;
  fields.databasePassword.value = '';
  fields.databaseClearPassword.checked = false;
  fields.discardReviewedState.checked = false;
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
  return { ...Object.fromEntries(pairs), databaseConnection };
}

export function pendingSettings(applied, draft) {
  const changed = settingFields
    .filter(([, key]) => {
      const expected = key === 'reportFormats' ? reportFormats(applied[key]) : applied[key];
      const value = draft[key];
      return value !== expected && !(paths.includes(key) && value?.trim() === expected);
    })
    .map(([, , label]) => label);
  const entered = draft.databaseConnection;
  const current = applied.databaseConnection;
  if (
    entered.mode !== current.mode ||
    (entered.mode === 'session' &&
      connectionFields.some(([, key]) => {
        const value = entered[key];
        return (typeof value === 'string' ? value.trim() : value) !== current[key];
      }))
  )
    changed.push('database connection');
  if (entered.clearPassword) changed.push('clear retained password');
  else if (entered.password) changed.push('password entry');
  return changed.join(', ');
}
