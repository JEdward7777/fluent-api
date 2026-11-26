const path = document.getElementById('report-path');
const format = document.getElementById('report-format');
const status = document.getElementById('report-target');
const exportButton = document.getElementById('report-write');
const actions = document.getElementById('report-actions');
const exportedFile = document.getElementById('report-exported-file');
const confirmation = document.getElementById('report-confirm');
const confirmationPath = document.getElementById('report-confirm-path');
const view = document.getElementById('report-dialog');
const download = document.getElementById('report-download');
const current = document.getElementById('current-report');
let previewKey = '';
let currentViewToken;
let blocked = false;
let generation = 0;
let attempt;
let message = '';
let suggestedPath = '';
let exportedReport;

function suggestPath(directory) {
  if (!directory || (path.value && path.value !== suggestedPath)) return;
  const extension = format.value === 'html' ? 'html' : 'md';
  suggestedPath = `${directory.replace(/\/$/, '')}/license-impact.${extension}`;
  path.value = suggestedPath;
}

function unavailable() {
  if (blocked) return 'Finish the current operation or resolve pending changes before exporting.';
  if (!previewKey) return 'Create a current preview before exporting a report.';
  if (!path.value.trim()) return 'Enter a report path before exporting.';
  return '';
}

function renderControls() {
  const reason = unavailable();
  exportButton.disabled = Boolean(attempt || reason);
  path.disabled = format.disabled = attempt?.step === 'writing';
  const text =
    attempt?.step === 'checking'
      ? 'Checking report target…'
      : attempt?.step === 'writing'
        ? 'Exporting report…'
        : attempt?.step === 'confirming'
          ? 'Confirm whether to overwrite the existing report.'
          : reason || message;
  if (status.textContent !== text) status.textContent = text;
}

function finish(text, restoreFocus = false) {
  attempt = undefined;
  message = text;
  const wasConfirming = confirmation.open;
  if (wasConfirming) confirmation.close();
  renderControls();
  if (
    restoreFocus &&
    !exportButton.disabled &&
    (wasConfirming || document.activeElement === document.body)
  )
    exportButton.focus();
}

export function invalidateReportSelection() {
  generation++;
  if (attempt?.step === 'confirming') {
    finish('The report selection or preview changed. Choose Export report again.', true);
  }
}

export function renderReportControls(next, workflowBlocked, viewToken) {
  const nextKey = ['saved', 'previewed'].includes(next.state) ? (next.preview?.token ?? '') : '';
  const nextBlocked = Boolean(workflowBlocked || next.activeOperationId);
  const previousPath = path.value;
  suggestPath(next.reportDir);
  const changed = nextKey !== previewKey || nextBlocked !== blocked || previousPath !== path.value;
  previewKey = nextKey;
  blocked = nextBlocked;
  if (changed) invalidateReportSelection();
  if (currentViewToken !== viewToken) current.open = false;
  currentViewToken = viewToken;
  current.hidden = !viewToken;
  current.querySelector('summary').textContent = next.preview?.saved
    ? 'View report from completed Save'
    : 'View report, results and impact';
  renderControls();
}

function isCurrent(pending) {
  return (
    attempt === pending &&
    pending.generation === generation &&
    pending.selection.path === path.value.trim() &&
    pending.selection.format === format.value &&
    !unavailable()
  );
}

export function initReportControls(request, getSetup, recover, token, settingsPending) {
  function changeSelection() {
    message = '';
    invalidateReportSelection();
    renderControls();
  }
  path.addEventListener('input', changeSelection);
  format.addEventListener('change', () => {
    suggestPath(getSetup()?.reportDir);
    changeSelection();
  });

  const cancel = () => {
    if (attempt?.step === 'confirming') finish('Export canceled.', true);
  };
  document.getElementById('report-cancel').addEventListener('click', cancel);
  confirmation.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });

  async function write(pending, overwrite) {
    if (settingsPending() || !isCurrent(pending)) {
      if (attempt === pending)
        finish('The report selection or preview changed. Choose Export report again.', true);
      return;
    }
    pending.step = 'writing';
    if (confirmation.open) confirmation.close();
    renderControls();
    try {
      const result = await request('report/export', 'POST', {
        planId: pending.plan.id,
        operationId: crypto.randomUUID(),
        agreeToOverwrite: overwrite,
      });
      exportedReport = result;
      exportedFile.textContent = `Last export: ${result.format} report · ${result.displayPath}`;
      actions.hidden = false;
      finish(`Exported ${result.format} report.`, pending.restoreFocus);
    } catch (error) {
      await recover(error.message);
      finish(
        `${error.message} Choose Export report to check the target again.`,
        pending.restoreFocus
      );
    }
  }

  document.getElementById('report-confirm-write').addEventListener('click', () => {
    if (attempt?.step === 'confirming') void write(attempt, true);
  });
  exportButton.addEventListener('click', async () => {
    if (settingsPending() || exportButton.disabled) return;
    const { configurationRevision, contentRevision } = getSetup();
    const selection = {
      previewToken: getSetup().preview.token,
      configurationRevision,
      contentRevision,
      path: path.value.trim(),
      format: format.value,
    };
    const pending = {
      generation,
      selection,
      step: 'checking',
      restoreFocus: document.activeElement === exportButton,
    };
    attempt = pending;
    renderControls();
    try {
      const plan = await request('report/inspect', 'POST', selection);
      if (!isCurrent(pending)) {
        finish('The report selection or preview changed. Choose Export report again.');
        return;
      }
      pending.plan = plan;
      if (plan.existed) {
        pending.step = 'confirming';
        confirmationPath.textContent = plan.displayPath;
        confirmation.showModal();
        renderControls();
      } else await write(pending, false);
    } catch (error) {
      if (!isCurrent(pending)) {
        finish('The report selection or preview changed. Choose Export report again.');
        return;
      }
      await recover(error.message);
      finish(error.message, pending.restoreFocus);
    }
  });

  document.getElementById('report-close').addEventListener('click', () => view.close());
  function openReport(fields, target) {
    const form = document.createElement('form');
    form.action = './report-view';
    form.method = 'POST';
    form.target = target;
    form.hidden = true;
    for (const [name, value] of Object.entries({ token, ...fields })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.requestSubmit();
    form.remove();
  }
  const openCurrent = () => {
    if (current.open && !current.hidden)
      openReport({ id: currentViewToken, current: 'true' }, 'current-report-frame');
  };
  current.addEventListener('toggle', openCurrent);
  document.getElementById('report-open').addEventListener('click', () => {
    if (!exportedReport) return;
    view.showModal();
    openReport({ id: exportedReport.operationId }, 'license-report-frame');
  });
  async function downloadReport(control, endpoint, filename, feedback) {
    control.disabled = true;
    try {
      const blob = await request(endpoint, 'GET', undefined, 'blob');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      feedback.textContent = `Download failed: ${error.message}`;
    } finally {
      control.disabled = false;
    }
  }
  download.addEventListener('click', () => {
    if (exportedReport)
      void downloadReport(
        download,
        `report/${exportedReport.operationId}`,
        exportedReport.filename,
        status
      );
  });
  const currentDownload = document.getElementById('current-download');
  currentDownload.addEventListener('click', () => {
    const type = document.getElementById('current-format').value;
    if (!current.hidden)
      void downloadReport(
        currentDownload,
        `current-report/${currentViewToken}/${type}`,
        `license-impact.${type === 'html' ? 'html' : 'md'}`,
        document.getElementById('current-report-status')
      );
  });
}
