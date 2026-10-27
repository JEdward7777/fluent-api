import type { DblClient } from '@/lib/services/dbl/dbl.client';

import * as resourcesService from '@/domains/bible-provider-resources/bible-provider-resources.service';
import {
  getClassifications,
  getSyncGuidance,
} from '@/domains/bible-provider-resources/classification/license-classifications.service';
import { syncAudioAvailability, syncBooksFromDbl } from '@/domains/books/sync/dbl-book-sync';
import { syncLanguagesFromDbl } from '@/domains/languages/sync/dbl-language-sync';
import { logger } from '@/lib/logger';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { err, ErrorCode, ok } from '@/lib/types';

import { syncBiblesFromDbl } from './dbl-bible-sync';

async function syncCatalogSteps(
  client: DblClient,
  initialStatus: 'allowed' | { preserveExistingNonUnknowns: boolean },
  stepCount: number
) {
  logger.info(`Step 1/${stepCount}: Syncing languages from DBL...`);
  const languages = await syncLanguagesFromDbl(client);
  if (!languages.ok) return languages;
  logger.info({ message: 'Languages sync completed', data: languages.data });
  logger.info(`Step 2/${stepCount}: Syncing Bible catalog and text license facts...`);
  const bibles = await syncBiblesFromDbl(client, initialStatus);
  if (!bibles.ok) return bibles;
  logger.info({ message: 'Bibles and text license facts sync completed', data: bibles.data });
  if (bibles.data.licensePolicy?.newlyFlagged)
    logger.warn({
      message: 'New unclassified license notices require review',
      data: bibles.data.licensePolicy,
    });
  logger.info(`Step 3/${stepCount}: Syncing books from DBL...`);
  const books = await syncBooksFromDbl(client);
  if (!books.ok) return books;
  logger.info({ message: 'Books sync completed', data: books.data });
  logger.info(`Step 4/${stepCount}: Syncing audio availability from DBL...`);
  const audio = await syncAudioAvailability(client);
  if (!audio.ok) return audio;
  logger.info({ message: 'Audio availability sync completed', data: audio.data });
  return ok({
    languages: languages.data,
    bibles: bibles.data,
    books: books.data,
    audio: audio.data,
  });
}

export async function syncDblCatalog(
  client: DblClient = dblClient,
  preserveExistingNonUnknowns = false
) {
  const classifications = await getClassifications();
  if (!classifications.length) {
    logger.error(
      'Review required before any catalog writes. Import attested JSON: npm run db:classify:licenses -- --source=json --destination=database; or deliberately run npm run db:sync:dbl:license-phase-one.'
    );
    logger.info(await getSyncGuidance());
    return { ...err(ErrorCode.VALIDATION_ERROR), reviewRequired: true as const };
  }
  const result = await syncCatalogSteps(client, { preserveExistingNonUnknowns }, 4);
  if (result.ok) logger.info(await getSyncGuidance());
  return result;
}

/** Explicit compatibility command only. The sweep is last even after a partial catalog failure. */
export async function syncDblCatalogLicensePhaseOne(client: DblClient = dblClient) {
  let catalog: Awaited<ReturnType<typeof syncCatalogSteps>>;
  try {
    catalog = await syncCatalogSteps(client, 'allowed', 5);
  } catch (cause) {
    logger.error({ cause, message: 'Phase-1 catalog sync failed before the final safety sweep' });
    catalog = err(ErrorCode.INTERNAL_ERROR);
  }
  logger.info('Step 5/5: Applying transitional English all-rights-reserved sweep...');
  const sweep = await resourcesService.applyAllRightsReservedSweep();
  if (!sweep.ok) return sweep;
  logger.info({ message: 'English all-rights-reserved sweep completed', data: sweep.data });
  logger.debug({
    message: 'Distinct non-null DBL text notices not matched by the English sweep',
    notices: sweep.data.unmatchedNotices,
  });
  logger.info(await getSyncGuidance());
  if (!catalog.ok) return catalog;
  return ok({ ...catalog.data, sweep: sweep.data });
}
