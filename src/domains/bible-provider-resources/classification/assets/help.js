// Every form label has a purpose explanation. Keep descriptions beside the controls they explain.
const help = [
  [
    '#setup [name="source"]',
    'Choose saved JSON evidence or the configured database to inspect. Practice reads saved JSON or its bundled example only.',
  ],
  [
    '#setup [name="destination"]',
    'Choose where a reviewed result would be saved: a JSON file, the configured database, or both. Practice saves incomplete scratch JSON only.',
  ],
  [
    '#setup [name="databaseMode"]',
    'Use the server environment connection or enter a connection held only for this workbench session. Switching connections requires Apply and a new Inspect.',
  ],
  [
    '#setup [name="databaseHost"]',
    'Hostname or IP address of the PostgreSQL server. Connection is attempted only at Test or Inspect.',
  ],
  ['#setup [name="databasePort"]', 'TCP port for PostgreSQL, usually 5432.'],
  [
    '#setup [name="databaseName"]',
    'PostgreSQL database name. The selected identity is shown before Inspect or Save.',
  ],
  [
    '#setup [name="databaseUsername"]',
    'Database login name. Your browser may offer to remember this field.',
  ],
  [
    '#setup [name="databasePassword"]',
    'Masked database password. It stays only in server session memory after Apply and is never shown again. A blank field retains it only if the other connection fields are unchanged.',
  ],
  [
    '#setup [name="databaseClearPassword"]',
    'Remove any password retained by this server session when applying the settings.',
  ],
  [
    '#setup [name="databaseTls"]',
    'Verified TLS checks the server certificate and hostname. Disable TLS only for a trusted local connection.',
  ],
  [
    '#setup [name="input"]',
    'Local path to the saved JSON source, read when you inspect inputs. Practice can use the bundled example.',
  ],
  [
    '#setup [name="output"]',
    'Local path for the reviewed JSON output. The target is checked before Save; practice writes only inside its private scratch directory.',
  ],
  [
    '#setup [name="model"]',
    'Gemini provider and model ID used only when analysis needs new model inference. Saved evidence and practice do not call the model.',
  ],
  [
    '#setup [name="samples"]',
    'Number of model votes requested for each key that needs new inference. Saved evidence and practice make no model requests.',
  ],
  [
    '#setup [name="cacheDir"]',
    'Directory for reusable model request results. It matters only when actual model inference is needed; practice does not use it.',
  ],
  [
    '#setup [name="reportFormats"]',
    'Optional report formats for analysis output. A separately inspected report can also be exported after preview.',
  ],
  [
    '#setup [name="reportDir"]',
    'Local directory for reports produced during normal analysis. Practice does not write reports.',
  ],
  [
    '#setup [name="noCache"]',
    'Request fresh model results instead of using cached requests when new inference is needed. Practice makes no model requests.',
  ],
  [
    '#setup [name="force"]',
    'Permit replacement of an existing destination database table after the required preview and Save agreement.',
  ],
  [
    '#setup [name="preserve"]',
    'Forecast later sync while preserving existing non-unknown resource statuses. This run choice does not change resource cache or durable license policy.',
  ],
  [
    '#setup [name="discardReviewedState"]',
    'Confirm that applying changed settings will discard this session’s unsaved review and require inspection again.',
  ],
  [
    '#review-filter [name="search"]',
    'Filter saved classification evidence by notice text, Bible, or identity. Searching does not run analysis.',
  ],
  [
    '#review-filter [name="status"]',
    'Show classifications with the selected decision, or show all decisions.',
  ],
  [
    '#review-filter [name="source"]',
    'Show classifications by their saved decision source: table, rule, model, or manual review.',
  ],
  [
    '#attestation [name="reviewedBy"]',
    'Name the person who personally reviewed this exact evidence and preview. This name becomes part of the attestation.',
  ],
  [
    '#attestation [name="reviewReason"]',
    'Explain why this exact review is being attested. Changing attestation changes JSON bytes and requires another preview.',
  ],
  [
    '#attestation [name="responsibility"]',
    'Confirm personal review of this exact evidence before signing its review hash.',
  ],
  [
    '#report-format',
    'Select HTML or Markdown for a separate report export. This does not Save policy or reviewed JSON.',
  ],
  ['#report-path', 'Local target path for a separate report. Inspect this target before export.'],
  ['#report-overwrite', 'Agree to replace the inspected report file at this exact path.'],
  [
    '#save-replacement-agreement',
    'Agree to replace policy at the inspected database target for this exact preview. Save cannot be canceled.',
  ],
  [
    '.review-editor [name="status"]',
    'Choose the human classification decision for this notice. Applying it invalidates the previous preview and attestation.',
  ],
  [
    '.review-editor [name="reason"]',
    'Give the rationale for a human decision, including why any automatic all-rights-reserved decision is overridden.',
  ],
  [
    '.review-editor [name="note"]',
    'Explain why an unknown classification is retained. Leave blank to use the decision reason when applying an unknown decision.',
  ],
  [
    '.review-editor input[type="checkbox"]',
    'Acknowledge the warning before overriding an automatic all-rights-reserved decision.',
  ],
];

function describe(control, description, index) {
  const label = control.closest('label');
  if (!label || label.classList.contains('field-help-label')) return;
  const id = `field-help-${index}`;
  if (!document.getElementById(id)) {
    const accessible = document.createElement('span');
    accessible.id = id;
    accessible.className = 'visually-hidden';
    accessible.textContent = description;
    document.body.append(accessible);
  }
  label.classList.add('field-help-label');
  label.dataset.help = description;
  label.tabIndex = 0;
  label.setAttribute('aria-describedby', id);
  const labelName = [...label.childNodes]
    .filter(
      (child) =>
        child.nodeType === Node.TEXT_NODE ||
        (child.nodeType === Node.ELEMENT_NODE && child.nodeName === 'SPAN')
    )
    .map((child) => child.textContent)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby'))
    control.setAttribute('aria-label', labelName);
  control.setAttribute(
    'aria-describedby',
    [control.getAttribute('aria-describedby'), id].filter(Boolean).join(' ')
  );
  const alignTooltip = () => {
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const bounds = label.getBoundingClientRect();
    if (bounds.bottom <= viewportTop || bounds.top >= viewportBottom) {
      label.classList.add('help-dismissed');
      label.classList.remove('help-touch-open');
      return;
    }
    const tooltipWidth = Math.min(400, viewportWidth - 32);
    label.style.setProperty('--help-width', `${tooltipWidth}px`);
    label.classList.remove('help-align-above');
    label.classList.add('help-measuring');
    const tooltipStyle = getComputedStyle(label, '::before');
    const tooltipHeight = Number.parseFloat(tooltipStyle.height);
    label.classList.remove('help-measuring');
    const left = Math.min(
      Math.max(bounds.left, viewportLeft + 16),
      viewportLeft + viewportWidth - tooltipWidth - 16
    );
    label.style.setProperty('--help-left', `${left - bounds.left}px`);
    label.classList.toggle(
      'help-align-above',
      bounds.bottom + tooltipHeight + 8 > viewportBottom &&
        bounds.top - tooltipHeight >= viewportTop + 8
    );
  };
  label.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') {
      alignTooltip();
      label.classList.add('help-touch-open');
    }
  });
  label.addEventListener('pointerenter', () => {
    alignTooltip();
    label.classList.remove('help-dismissed');
  });
  label.addEventListener('pointerleave', () => label.classList.remove('help-dismissed'));
  label.addEventListener('focusin', () => {
    alignTooltip();
    label.classList.remove('help-dismissed');
  });
  label.addEventListener('field-help-position', alignTooltip);
}

function initFieldHelp() {
  const update = () => {
    for (const [index, [selector, description]] of help.entries()) {
      const control = document.querySelector(selector);
      if (control) describe(control, description, index);
    }
  };
  update();
  new MutationObserver(update).observe(document.getElementById('review-detail'), {
    childList: true,
    subtree: true,
  });
  document.addEventListener('pointerdown', (event) => {
    for (const label of document.querySelectorAll('.help-touch-open'))
      if (!label.contains(event.target)) label.classList.remove('help-touch-open');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      for (const label of document.querySelectorAll('.field-help-label')) {
        label.classList.remove('help-touch-open');
        label.classList.add('help-dismissed');
      }
      if (document.activeElement?.matches('.field-help-label')) document.activeElement.blur();
    }
  });
  const repositionOpenHelp = () => {
    for (const label of document.querySelectorAll('.field-help-label'))
      if (label.matches(':hover, :focus-visible, .help-touch-open'))
        label.dispatchEvent(new Event('field-help-position'));
  };
  window.addEventListener('scroll', repositionOpenHelp, true);
  window.addEventListener('resize', repositionOpenHelp);
  window.visualViewport?.addEventListener('scroll', repositionOpenHelp);
  window.visualViewport?.addEventListener('resize', repositionOpenHelp);
}

initFieldHelp();
