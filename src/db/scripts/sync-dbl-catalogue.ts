import { syncDblCatalog } from '@/domains/bibles/sync/dbl-catalog-sync';
import { logger } from '@/lib/logger';

syncDblCatalog()
  .then((result) => {
    if (!result.ok) logger.error('DBL catalog sync failed', { error: result.error });
    else logger.info('DBL catalog sync completed successfully', { data: result.data });
    process.exit(result.ok ? 0 : 1);
  })
  .catch((cause: unknown) => {
    logger.error({ cause, message: 'Fatal error during DBL catalog sync' });
    process.exit(1);
  });
