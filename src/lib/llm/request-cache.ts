import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { logger } from '@/lib/logger';

import type { JsonValue } from './canonical-json';

import { hashCanonicalJson } from './canonical-json';

export interface LlmRequest {
  provider: string;
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  responseSchema: { [key: string]: JsonValue };
  settings: { [key: string]: JsonValue };
}

const entrySchema = z
  .object({
    version: z.literal(1),
    requestHash: z.string(),
    provider: z.string(),
    model: z.string(),
    response: z.string(),
    storedAt: z.string().datetime(),
  })
  .strict();

function defaultCacheDirectory() {
  if (process.platform === 'win32')
    return join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'fluent',
      'Cache',
      'llm'
    );
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'fluent', 'llm');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'fluent', 'llm');
}

export function llmRequestHash(request: LlmRequest) {
  return hashCanonicalJson({
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    responseSchema: request.responseSchema,
    settings: request.settings,
  });
}

/** Memory and atomic on-disk evidence cache. Credentials/transport never enter this contract. */
export function createRequestCache(cacheDir = defaultCacheDirectory()) {
  const memory = new Map<string, string>();
  const pathFor = (hash: string) =>
    join(cacheDir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json`);
  return {
    async read(request: LlmRequest): Promise<string | null> {
      const hash = llmRequestHash(request);
      if (memory.has(hash)) return memory.get(hash)!;
      let content: string;
      try {
        content = await readFile(pathFor(hash), 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        logger.warn({
          message: 'Ignoring corrupt LLM cache entry',
          context: { requestHash: hash },
        });
        return null;
      }
      const entry = entrySchema.safeParse(parsed);
      if (
        !entry.success ||
        entry.data.requestHash !== hash ||
        entry.data.provider !== request.provider ||
        entry.data.model !== request.model
      ) {
        logger.warn({
          message: 'Ignoring invalid LLM cache metadata',
          context: { requestHash: hash },
        });
        return null;
      }
      memory.set(hash, entry.data.response);
      return entry.data.response;
    },
    async write(request: LlmRequest, response: string) {
      const hash = llmRequestHash(request);
      const destination = pathFor(hash);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            requestHash: hash,
            provider: request.provider,
            model: request.model,
            response,
            storedAt: new Date().toISOString(),
          }),
          { mode: 0o600 }
        );
        await rename(temporary, destination);
        memory.set(hash, response);
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        });
      }
    },
  };
}
