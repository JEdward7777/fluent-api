import { z } from 'zod';

const path = z.string().trim().min(1);
export const setupSchema = z
  .object({
    configurationRevision: z.number().int().positive(),
    discardReviewedState: z.boolean(),
    source: z.enum(['json', 'database']).nullable(),
    destination: z.enum(['json', 'database', 'both']).nullable(),
    input: path,
    output: path,
    model: z.string().regex(/^google:[^\s:]+$/),
    sampleCount: z.number().int().min(2),
    force: z.boolean(),
    noCache: z.boolean(),
    cacheDir: path.nullable(),
    reportFormats: z.enum(['none', 'markdown', 'html', 'markdown,html']),
    reportDir: path.nullable(),
    preserveExistingNonUnknowns: z.boolean(),
  })
  .strict();
export const operationSchema = z
  .object({
    operationId: z.string().uuid(),
    configurationRevision: z.number().int().positive(),
  })
  .strict();
