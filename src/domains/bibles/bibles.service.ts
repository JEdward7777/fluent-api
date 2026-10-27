import type { DbTransaction } from '@/lib/types';

import { bibleKey } from '@/domains/bible-provider-resources/bible-provider-resources.identity';
import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Bible, BibleResponse, CreateBible, UpdateBible } from './bibles.types';

import * as repo from './bibles.repository';
import { createBibleSchema, updateBibleSchema } from './bibles.types';

// ─── Response mapping ─────────────────────────────────────────────────────────

type ProviderResource = NonNullable<
  Extract<Awaited<ReturnType<typeof resources.getById>>, { ok: true }>['data']
>;

function mapBibleResponse(
  bible: Bible,
  text: ProviderResource | null,
  audio: ProviderResource | null
) {
  return {
    id: bible.id,
    name: bible.name,
    abbreviation: bible.abbreviation,
    languageId: bible.languageId,
    hasAudio: bible.hasAudio,
    provider: bible.provider,
    ttsLicenseStatus: text?.ttsLicenseStatus ?? 'unknown',
    textBibleKey: bible.externalId
      ? bibleKey({ provider: bible.provider, externalId: bible.externalId })
      : null,
    selectedRecordingKey: audio ? bibleKey(audio) : null,
    updatedAt: bible.updatedAt?.toISOString() ?? null,
  } satisfies BibleResponse;
}
async function toBibleResponse(bible: Bible) {
  const text = bible.textResourceId ? await resources.getById(bible.textResourceId) : ok(null);
  if (!text.ok) return text;
  const audio = bible.audioResourceId ? await resources.getById(bible.audioResourceId) : ok(null);
  if (!audio.ok) return audio;
  return ok(mapBibleResponse(bible, text.data, audio.data));
}

async function toBibleResponses(bibles: Bible[]) {
  const textIds = new Set<number>();
  const recordingIds = new Set<number>();
  for (const bible of bibles) {
    if (bible.textResourceId !== null) textIds.add(bible.textResourceId);
    if (bible.audioResourceId !== null) recordingIds.add(bible.audioResourceId);
  }

  const [texts, recordings] = await Promise.all([
    resources.getByIds([...textIds]),
    resources.getByIds([...recordingIds]),
  ]);
  if (!texts.ok) return texts;
  if (!recordings.ok) return recordings;

  const textsById = new Map(texts.data.map((resource) => [resource.id, resource]));
  const recordingsById = new Map(recordings.data.map((resource) => [resource.id, resource]));
  return ok(
    bibles.map((bible) =>
      mapBibleResponse(
        bible,
        bible.textResourceId === null ? null : (textsById.get(bible.textResourceId) ?? null),
        bible.audioResourceId === null ? null : (recordingsById.get(bible.audioResourceId) ?? null)
      )
    )
  );
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function searchSourceBibles(query: string) {
  return repo.searchSourceBibles(query);
}

export async function getAllBibles(updatedAfter?: Date) {
  const result = await repo.getAll(updatedAfter);
  if (!result.ok) return result;
  return toBibleResponses(result.data);
}

export function getBibleRecordById(id: number, tx?: DbTransaction) {
  return repo.getById(id, tx);
}

export async function getBibleById(id: number) {
  const result = await repo.getById(id);
  if (!result.ok) return result;
  return toBibleResponse(result.data);
}

export async function getBiblesByLanguageId(languageId: number) {
  const result = await repo.getByLanguageId(languageId);
  if (!result.ok) return result;
  return toBibleResponses(result.data);
}

export async function createBible(data: CreateBible) {
  if (!createBibleSchema.safeParse(data).success) return err(ErrorCode.VALIDATION_ERROR);
  const result = await repo.create(data);
  if (!result.ok) return result;
  return toBibleResponse(result.data);
}

export async function updateBible(id: number, data: UpdateBible) {
  if (!updateBibleSchema.safeParse(data).success) return err(ErrorCode.VALIDATION_ERROR);
  const result = await repo.update(id, data);
  if (!result.ok) return result;
  return toBibleResponse(result.data);
}

export function deleteBible(id: number) {
  return repo.remove(id);
}
