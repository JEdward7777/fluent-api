type LicenseReportFormat = 'markdown' | 'html';

export function selectLicenseReportFormats(
  value = 'markdown',
  options: { interactive?: boolean; yes?: boolean; openReport?: boolean } = {}
): LicenseReportFormat[] {
  const tokens = [...new Set(value.split(',').map((token) => token.trim()))];
  if (!tokens.length || tokens.some((token) => !['markdown', 'html', 'none'].includes(token)))
    throw new Error('Report formats must be markdown, html, markdown,html, or none');
  if (tokens.includes('none') && tokens.length !== 1)
    throw new Error('Report format none cannot be combined with another format');
  const formats: LicenseReportFormat[] =
    tokens[0] === 'none' ? [] : tokens.map((token) => (token === 'markdown' ? 'markdown' : 'html'));
  if (options.openReport && (!options.interactive || options.yes || !formats.includes('html')))
    throw new Error('Opening a report requires HTML and an interactive run without --yes');
  return formats;
}

export function escapeReportHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Entity escaping keeps literal notices readable while preventing Markdown/HTML execution. */
export function escapeReportMarkdown(value: string): string {
  return escapeReportHtml(value)
    .replace(/[\\`*_[\]{}()#!|~]/g, (character) => `&#${character.codePointAt(0)};`)
    .replace(/\r?\n/g, '<br>');
}
