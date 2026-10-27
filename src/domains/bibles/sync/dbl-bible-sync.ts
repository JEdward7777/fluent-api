import type { DblClient } from '@/lib/services/dbl/dbl.client';
import type { Result } from '@/lib/types';

import { runInTransaction } from '@/db/transaction';
import * as resourcesService from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { normalizeIso6393Code } from '@/domains/languages/import/iso';
import * as languagesRepository from '@/domains/languages/languages.repository';
import { dblClient } from '@/lib/services/dbl/dbl.client';

import type { DblBibleUpsertInput } from '../bibles.repository';

import * as biblesRepository from '../bibles.repository';

export interface DblBibleSyncSummary {
  totalBibles: number;
  skippedMissingLanguage: number;
  inserted: number;
  updated: number;
  licenseFacts: { inserted: number; updated: number; distinctNotices: number; nullNotices: number };
}

interface DblCatalogRow extends DblBibleUpsertInput {
  textLicenseNotice: string | null;
}

/**
 * Acquires the catalog visible to the configured DBL key without writing data.
 * Bibles without a corresponding valid language in the DB are skipped.
 *
 * Note: `syncLanguagesFromDbl` should generally be called BEFORE this
 * to ensure the languages table is fully populated.
 */
export async function acquireDblBibleCatalog(client: DblClient = dblClient) {
  const biblesResult = await client.getBibles({ includeFullDetails: true });
  if (!biblesResult.ok) return biblesResult;
  const allBibles = biblesResult.data;

  const [languagesResult, existingResult] = await Promise.all([
    languagesRepository.getAll(),
    biblesRepository.getAll(),
  ]);
  if (!languagesResult.ok) return languagesResult;
  if (!existingResult.ok) return existingResult;

  const langCodeToId = new Map<string, number>();
  for (const lang of languagesResult.data) {
    if (lang.langCodeIso6393) {
      langCodeToId.set(lang.langCodeIso6393, lang.id);
    }
  }

  const rows: DblCatalogRow[] = [];
  const seenAbbreviations = new Set<string>();
  const seenNames = new Set<string>();
  let skippedMissingLanguage = 0;

  // Pre-populate with existing DB bibles to prevent collisions with seed/existing data.
  // Also build an externalId→existing-row map so we can reuse stored abbreviations
  // for Bibles we've already synced (avoids ever-growing suffixes on re-sync).
  const existingByExternalId = new Map<string, { abbreviation: string; name: string }>();
  for (const b of existingResult.data) {
    if (b.abbreviation) seenAbbreviations.add(b.abbreviation.toLowerCase());
    if (b.name) seenNames.add(b.name.toLowerCase());
    if (b.externalId && b.provider === 'dbl') {
      existingByExternalId.set(b.externalId, {
        abbreviation: b.abbreviation,
        name: b.name,
      });
    }
  }

  for (const bible of allBibles) {
    if (!bible.language) {
      skippedMissingLanguage++;
      continue;
    }

    const code = normalizeIso6393Code(bible.language.id);
    if (!code) {
      skippedMissingLanguage++;
      continue;
    }

    const languageId = langCodeToId.get(code);
    if (!languageId) {
      skippedMissingLanguage++;
      continue;
    }

    // If this Bible was already synced, reuse its stored abbreviation and name
    // to avoid regenerating collision suffixes on every re-sync.
    const existing = existingByExternalId.get(bible.id);
    const hasAudio = !!(bible.audioBibles && bible.audioBibles.length > 0);
    const textLicenseNotice = bible.copyright?.trim() || null;
    if (existing) {
      rows.push({
        languageId,
        name: existing.name,
        abbreviation: existing.abbreviation,
        provider: 'dbl',
        externalId: bible.id,
        hasAudio,
        textLicenseNotice,
      });
      continue;
    }

    const rawAbbrev = (bible.abbreviationLocal || bible.abbreviation || 'BIBLE').trim();
    // Cap base at 40 chars to leave room for the collision suffix
    const baseAbbrev = rawAbbrev.slice(0, 40);
    let abbrev = rawAbbrev.slice(0, 50);
    let counter = 1;

    while (seenAbbreviations.has(abbrev.toLowerCase())) {
      abbrev = `${baseAbbrev}-${bible.id.slice(0, 6)}${counter > 1 ? `-${counter}` : ''}`.slice(
        0,
        50
      );
      counter++;
    }
    seenAbbreviations.add(abbrev.toLowerCase());

    const baseName = (bible.name || bible.nameLocal || abbrev).trim();
    let name = baseName;
    counter = 1;

    while (seenNames.has(name.toLowerCase())) {
      name = `${baseName} (${abbrev})`;
      if (seenNames.has(name.toLowerCase())) {
        name = `${baseName} (${abbrev}-${counter})`;
        counter++;
      }
    }
    seenNames.add(name.toLowerCase());

    rows.push({
      languageId,
      name,
      abbreviation: abbrev,
      provider: 'dbl',
      externalId: bible.id,
      hasAudio,
      textLicenseNotice,
    });
  }

  return {
    ok: true as const,
    data: { rows, totalBibles: allBibles.length, skippedMissingLanguage },
  };
}

/** Reused acquisition is read-only; all provider facts and Bible rows commit together. */
export async function persistDblBibleCatalog(
  catalog: Extract<Awaited<ReturnType<typeof acquireDblBibleCatalog>>, { ok: true }>['data'],
  initialStatus: 'unknown' | 'allowed'
): Promise<Result<DblBibleSyncSummary>> {
  return runInTransaction(async (tx) => {
    const facts = await resourcesService.upsertDblTextFacts(
      catalog.rows.map((row) => ({
        externalId: row.externalId,
        textLicenseNotice: row.textLicenseNotice,
        displayName: row.name,
      })),
      initialStatus,
      tx
    );
    if (!facts.ok) return facts;
    const bibles = await biblesRepository.upsertFromDbl(
      catalog.rows.map(({ textLicenseNotice: _notice, ...row }) => row),
      tx
    );
    if (!bibles.ok) return bibles;
    const notices = catalog.rows.map((row) => row.textLicenseNotice);
    return {
      ok: true as const,
      data: {
        totalBibles: catalog.totalBibles,
        skippedMissingLanguage: catalog.skippedMissingLanguage,
        ...bibles.data,
        licenseFacts: {
          ...facts.data,
          distinctNotices: new Set(notices.filter((notice) => notice !== null)).size,
          nullNotices: notices.filter((notice) => notice === null).length,
        },
      },
    };
  });
}

/** Ordinary sync never opts into Phase-1 optimism implicitly. Derived policy is wired in the next slice. */
export async function syncBiblesFromDbl(
  client: DblClient = dblClient,
  initialStatus: 'unknown' | 'allowed' = 'unknown'
): Promise<Result<DblBibleSyncSummary>> {
  const catalog = await acquireDblBibleCatalog(client);
  if (!catalog.ok) return catalog;
  return persistDblBibleCatalog(catalog.data, initialStatus);
}
