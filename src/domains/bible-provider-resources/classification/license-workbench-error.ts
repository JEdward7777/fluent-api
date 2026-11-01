import { LicenseBootstrapRequiredError } from './license-workflow-freshness';
import { LicenseWriteUncertainError } from './license-write';

export function licenseWorkbenchBrowserError(error: unknown) {
  if (error instanceof LicenseBootstrapRequiredError) return error.message;
  if (error instanceof Error && 'code' in error && error.code === '42P01')
    return 'Configured database schema is missing. Check this connection and apply its migrations before Inspect.';
  if (error instanceof LicenseWriteUncertainError)
    return error.recovery.diverged
      ? 'Published file state diverged during compensation. Inspect the affected targets, retained recovery files and policy before retrying.'
      : 'Write failed; the database commit outcome may be uncertain. Inspect actual file targets and policy before retrying.';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('GEMINI_API_KEY'))
    return 'A nonempty GEMINI_API_KEY is required before reading any source';
  if (message.includes('Inspect inputs before')) return message;
  if (message.includes('Stale license')) return 'Inputs changed; inspect again before continuing';
  if (message.includes('not found'))
    return 'Selected JSON source was not found; check its path and inspect again';
  return 'Operation failed. Check selected inputs and server configuration, then try again.';
}
