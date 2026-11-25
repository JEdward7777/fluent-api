import type { Hono } from 'hono';

import { z } from 'zod';

import type { LicenseWorkbenchSession } from './license-workbench-session';

export function registerSourceReconciliation(app: Hono, session: LicenseWorkbenchSession) {
  app.post('/api/source/reconcile', async (c) => {
    const parsed = z
      .union([
        z.object({}).strict(),
        z
          .object({
            token: z.string().uuid(),
            choices: z.record(z.string(), z.enum(['working', 'source', 'source-with-mark'])),
          })
          .strict(),
      ])
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text('Invalid source reconciliation request', 400);
    try {
      return c.json(
        await session.reconcileSource('token' in parsed.data ? parsed.data : undefined)
      );
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Reconciliation failed', 409);
    }
  });
}
