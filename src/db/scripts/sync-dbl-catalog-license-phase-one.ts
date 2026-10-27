import { syncDblCatalogLicensePhaseOne } from '@/domains/bibles/sync/dbl-catalog-sync';
import { logger } from '@/lib/logger';

logger.warn(
  'Explicit transitional Phase-1 sync: new DBL resources start allowed, then the English all-rights-reserved sweep runs last.'
);
syncDblCatalogLicensePhaseOne()
  .then((result) => {
    if (!result.ok)
      logger.error({ message: 'Phase-1 DBL catalog sync failed', error: result.error });
    else logger.info({ message: 'Phase-1 DBL catalog sync completed', data: result.data });
    process.exit(result.ok ? 0 : 1);
  })
  .catch((cause: unknown) => {
    logger.error({ cause, message: 'Fatal error during Phase-1 DBL catalog sync' });
    process.exit(1);
  });
