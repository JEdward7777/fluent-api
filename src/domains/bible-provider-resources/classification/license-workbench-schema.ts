import { z } from 'zod';

import type { LicenseCommandOptions } from './license-command-options';

const path = z.string().trim().min(1);
export const databaseConnectionSchema = z.discriminatedUnion('mode', [
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
]);

export const setupSchema = z
  .object({
    configurationRevision: z.number().int().positive(),
    expectedContentRevision: z.number().int().nonnegative().optional(),
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
    sourceDatabaseConnection: databaseConnectionSchema.optional(),
    destinationDatabaseConnection: databaseConnectionSchema.optional(),
    databaseConnection: databaseConnectionSchema.optional(),
  })
  .strict();
export const estimateSettingsSchema = setupSchema
  .pick({
    configurationRevision: true,
    model: true,
    sampleCount: true,
    noCache: true,
    cacheDir: true,
  })
  .extend({
    contentRevision: z.number().int().nonnegative(),
    estimateRevision: z.number().int().nonnegative(),
    reassessmentScopeRevision: z.number().int().nonnegative().optional(),
    loadRevision: z.number().int().nonnegative(),
  });
export const operationSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedContentRevision: z.number().int().nonnegative().optional(),
    discardReviewedState: z.boolean().optional(),
    configurationRevision: z.number().int().positive(),
  })
  .strict();

export const inspectOperationSchema = operationSchema.extend({
  sourceSettings: z
    .discriminatedUnion('source', [
      z.object({ source: z.literal('json'), input: path }).strict(),
      z
        .object({ source: z.literal('database'), connection: databaseConnectionSchema.optional() })
        .strict(),
    ])
    .optional(),
});

export const paidOperationSchema = operationSchema
  .pick({ operationId: true, configurationRevision: true })
  .extend({
    paid: z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        maximumRequests: z.number().int().positive(),
        replacementConfirmations: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
      })
      .strict(),
  })
  .strict();

export function changedAiSettings(
  current: LicenseCommandOptions,
  next: Pick<LicenseCommandOptions, 'model' | 'sampleCount' | 'noCache' | 'cacheDir'>
) {
  return (
    current.model !== next.model ||
    current.sampleCount !== next.sampleCount ||
    current.noCache !== next.noCache ||
    current.cacheDir !== next.cacheDir
  );
}

export function applyLicenseWorkbenchOptions(
  current: LicenseCommandOptions,
  body: z.infer<typeof setupSchema>
): LicenseCommandOptions {
  return {
    ...current,
    source: body.source ?? undefined,
    destination: body.destination ?? undefined,
    input: body.input,
    output: body.output,
    model: body.model,
    sampleCount: body.sampleCount,
    force: body.force,
    noCache: body.noCache,
    cacheDir: body.cacheDir ?? undefined,
    reportFormats: body.reportFormats,
    reportDir: body.reportDir ?? undefined,
    preserveExistingNonUnknowns: body.preserveExistingNonUnknowns,
  };
}
