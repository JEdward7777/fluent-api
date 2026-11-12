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
    databaseConnection: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('environment') }).strict(),
        z
          .object({
            mode: z.literal('session'),
            host: z
              .string()
              .trim()
              .max(253)
              .regex(/^[a-z0-9.-]+$/i)
              .refine((value) =>
                value
                  .split('.')
                  .every(
                    (label) =>
                      label.length > 0 &&
                      label.length <= 63 &&
                      /^[a-z0-9-]+$/i.test(label) &&
                      /^[a-z0-9]$/i.test(label[0]) &&
                      /^[a-z0-9]$/i.test(label[label.length - 1])
                  )
              ),
            port: z.number().int().min(1).max(65535),
            database: z.string().trim().min(1).max(128),
            username: z.string().trim().min(1).max(128),
            password: z.string().max(1024),
            clearPassword: z.boolean(),
            tls: z.enum(['verify-full', 'disable']),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export const operationSchema = z
  .object({
    operationId: z.string().uuid(),
    configurationRevision: z.number().int().positive(),
  })
  .strict();
