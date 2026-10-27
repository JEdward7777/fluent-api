import { syncDblCatalog } from '@/domains/bibles/sync/dbl-catalog-sync';
import { logger } from '@/lib/logger';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--preserve-existing-non-unknowns')) {
  logger.error(
    'Usage: npm run db:sync:dbl -- [--preserve-existing-non-unknowns] (invocation only; a later ordinary sync may overwrite preserved statuses)'
  );
  process.exit(1);
}
syncDblCatalog(undefined, args.includes('--preserve-existing-non-unknowns'))
  .then((result) => {
    if (!result.ok) logger.error({ message: 'DBL catalog sync failed', error: result.error });
    else logger.info({ message: 'DBL catalog sync completed successfully', data: result.data });
    process.exit(result.ok ? 0 : 'reviewRequired' in result ? 3 : 1);
  })
  .catch((cause: unknown) => {
    logger.error({ cause, message: 'Fatal error during DBL catalog sync' });
    process.exit(1);
  });
