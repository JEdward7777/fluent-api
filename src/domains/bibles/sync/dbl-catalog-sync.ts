import type { DblClient } from '@/lib/services/dbl/dbl.client';

import * as resourcesService from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { syncAudioAvailability, syncBooksFromDbl } from '@/domains/books/sync/dbl-book-sync';
import { syncLanguagesFromDbl } from '@/domains/languages/sync/dbl-language-sync';
import { logger } from '@/lib/logger';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { err, ErrorCode, ok } from '@/lib/types';

import { syncBiblesFromDbl } from './dbl-bible-sync';

async function syncCatalogSteps(
  client: DblClient,
  initialStatus: 'unknown' | 'allowed',
  stepCount: number
) {
  logger.info(`Step 1/${stepCount}: Syncing languages from DBL...`);
  const languages = await syncLanguagesFromDbl(client);
  if (!languages.ok) return languages;
  logger.info('Languages sync completed', { data: languages.data });
  logger.info(`Step 2/${stepCount}: Syncing Bible catalog and text license facts...`);
  const bibles = await syncBiblesFromDbl(client, initialStatus);
  if (!bibles.ok) return bibles;
  logger.info('Bibles and text license facts sync completed', { data: bibles.data });
  logger.info(`Step 3/${stepCount}: Syncing books from DBL...`);
  const books = await syncBooksFromDbl(client);
  if (!books.ok) return books;
  logger.info('Books sync completed', { data: books.data });
  logger.info(`Step 4/${stepCount}: Syncing audio availability from DBL...`);
  const audio = await syncAudioAvailability(client);
  if (!audio.ok) return audio;
  logger.info('Audio availability sync completed', { data: audio.data });
  return ok({
    languages: languages.data,
    bibles: bibles.data,
    books: books.data,
    audio: audio.data,
  });
}

export function syncDblCatalog(client: DblClient = dblClient) {
  return syncCatalogSteps(client, 'unknown', 4);
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
  logger.info('English all-rights-reserved sweep completed', { data: sweep.data });
  logger.debug('Distinct non-null DBL text notices not matched by the English sweep', {
    notices: sweep.data.unmatchedNotices,
  });
  if (!catalog.ok) return catalog;
  return ok({ ...catalog.data, sweep: sweep.data });
}
