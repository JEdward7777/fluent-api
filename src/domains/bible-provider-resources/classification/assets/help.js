// Every form label has a purpose explanation. Keep descriptions beside the controls they explain.
const help = [
  [
    '#setup [name="source"]',
    'Choose saved JSON evidence or the configured database to load. Practice reads saved JSON or its bundled example only.',
  ],
  [
    '#setup [name="destination"]',
    'Choose the JSON file, database, or both as independent destinations. Practice saves scratch JSON only.',
  ],
  [
    '#setup [name="databaseMode"]',
    {
      source:
        'Choose the environment or a session connection. Apply source settings, then Load to read the selected database.',
      destination:
        'Choose the environment or a session connection. Apply destination settings to use this database for preview and Save. The loaded source stays in place.',
    },
  ],
  [
    '#setup [name="databaseHost"]',
    {
      source:
        'Hostname or IP address of the source PostgreSQL server. Test checks connectivity. Load reads the source and freshness checks can read it again.',
      destination:
        'Hostname or IP address of the destination PostgreSQL server. Test checks connectivity, preview reads the target, and Save writes the confirmed changes.',
    },
  ],
  ['#setup [name="databasePort"]', 'TCP port for PostgreSQL, usually 5432.'],
  [
    '#setup [name="databaseName"]',
    {
      source: 'Name of the PostgreSQL database to load as the review source.',
      destination: 'Name of the PostgreSQL database to preview and save as the destination.',
    },
  ],
  [
    '#setup [name="databaseUsername"]',
    'Database login name. Your browser may offer to remember this field.',
  ],
  [
    '#setup [name="databasePassword"]',
    'Dots indicate a retained password. Enter a password to replace it. A blank field retains the password when the connection details and TLS setting stay the same.',
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
    'Local path to the saved JSON source, read when you load the source. Practice can use the bundled example.',
  ],
  [
    '#setup [name="output"]',
    'Local path for the reviewed JSON output. The target is checked before Save; practice writes only inside its private scratch directory.',
  ],
  [
    '#setup [name="model"]',
    'Model used for new database keys or explicitly selected row reassessment. Free preparation estimates outstanding requests.',
  ],
  [
    '#setup [name="samples"]',
    'Number of model votes for each selected model key. Free preparation applies complete cached votes and estimates missing samples.',
  ],
  [
    '#setup [name="cacheDir"]',
    'Directory for reusable model request results. Free preparation reads this cache for complete assessments.',
  ],
  [
    '#setup [name="reportFormats"]',
    'Report formats for the equivalent CLI command. In the workbench, choose a format and path when exporting a report.',
  ],
  [
    '#setup [name="reportDir"]',
    'Directory for reports produced by the equivalent CLI command. In the workbench, Export uses the report path you enter.',
  ],
  [
    '#setup [name="noCache"]',
    'Skip cached samples when preparing evidence and estimating outstanding requests.',
  ],
  [
    '#setup [name="preserve"]',
    'Forecast later sync while preserving existing non-unknown resource statuses. This run choice does not change resource cache or durable license policy.',
  ],
  [
    '#setup [name="discardReviewedState"]',
    'Authorize replacing the current working review when you load the newly selected source.',
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
  ['#report-format', 'Choose HTML or Markdown for the exported report.'],
  ['#report-path', 'Enter the destination path on the machine running the reviewer.'],
  [
    '#save-replacement-agreement',
    'Agree to replace policy at the inspected database target for this exact preview. Save cannot be canceled.',
  ],
  [
    '.review-editor [name="status"]',
    'Choose a named human decision for this notice. Confirming the same status records a new human review event.',
  ],
  [
    '.review-editor [name="reason"]',
    'Give the rationale for a human decision, including why any automatic all-rights-reserved decision is overridden.',
  ],
  [
    '.review-editor [name="reviewedBy"]',
    'Name the person who makes this exact row decision. Its event time is recorded by the server.',
  ],
  [
    '.review-editor [name="note"]',
    'Optional note for an unknown classification. Updating only this note leaves the review event unchanged.',
  ],
  [
    '.review-editor input[type="checkbox"]',
    'Acknowledge the warning before overriding an automatic all-rights-reserved decision.',
  ],
  [
    '.review-editor [name="editKind"][value="disposition"]',
    'Record the decision and reason under your name and mark the entry human-reviewed, even if the decision stays the same.',
  ],
  [
    '.review-editor [name="editKind"][value="unknown-note"]',
    'Change only the follow-up note. Apply or undo any decision, reason or reviewer name edits first.',
  ],
];

function describe(control, description, index) {
  const action = control.closest('.action-help');
  const label = action ?? control.closest('label');
  if (!label) return;
  const id = `field-help-${index}`;
  if (label.classList.contains('field-help-label')) {
    if (label.getAttribute('aria-describedby') === id && label.dataset.help !== description) {
      label.dataset.help = description;
      document.getElementById(id).textContent = description;
    }
    return;
  }
  if (!document.getElementById(id)) {
    const accessible = document.createElement('span');
    accessible.id = id;
    accessible.className = 'visually-hidden';
    accessible.textContent = description;
    document.body.append(accessible);
  }
  label.classList.add('field-help-label');
  label.dataset.help = description;
  if (!action) {
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
  }
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
    if (!action && event.pointerType === 'touch') {
      alignTooltip();
      label.classList.add('help-touch-open');
    }
  });
  label.addEventListener('pointerenter', () => {
    alignTooltip();
    label.classList.remove('help-dismissed');
  });
  if (!action)
    label.addEventListener('pointerleave', () => label.classList.remove('help-dismissed'));
  label.addEventListener('focusin', () => {
    alignTooltip();
    label.classList.remove('help-dismissed');
  });
  label.addEventListener('field-help-position', alignTooltip);
}

function initFieldHelp() {
  const roleSelector = document.getElementById('setup').elements.databaseRole;
  const update = () => {
    const role = roleSelector.value;
    for (const [index, [selector, description]] of help.entries()) {
      const control = document.querySelector(selector);
      if (control) {
        describe(control, typeof description === 'string' ? description : description[role], index);
      }
    }
  };
  update();
  roleSelector.addEventListener('change', update);
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
      if (document.activeElement?.matches('label.field-help-label')) document.activeElement.blur();
    }
  });
  const repositionOpenHelp = () => {
    for (const label of document.querySelectorAll('.field-help-label'))
      if (label.matches(':hover, :focus-visible, :has(> button:focus-visible), .help-touch-open'))
        label.dispatchEvent(new Event('field-help-position'));
  };
  window.addEventListener('scroll', repositionOpenHelp, true);
  window.addEventListener('resize', repositionOpenHelp);
  window.visualViewport?.addEventListener('scroll', repositionOpenHelp);
  window.visualViewport?.addEventListener('resize', repositionOpenHelp);
}

initFieldHelp();
