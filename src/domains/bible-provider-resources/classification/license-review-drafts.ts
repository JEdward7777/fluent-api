import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { LicenseClassification } from '../license-artifact.schemas';

import { reviewQuerySchema } from './license-workbench-review';

const envelope = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  epoch: z.string().uuid(),
  contentRevision: z.number().int().nonnegative(),
  mutationId: z.string().uuid(),
});

export const draftCommandSchema = z.discriminatedUnion('kind', [
  envelope
    .extend({
      kind: z.literal('patch'),
      status: z.enum(['unknown', 'allowed', 'forbidden']).optional(),
      reviewComment: z.string().max(2000).nullable().optional(),
      touched: z.boolean(),
    })
    .strict(),
  envelope.extend({ kind: z.literal('mark') }).strict(),
  envelope.extend({ kind: z.literal('mark-next'), query: reviewQuerySchema.strict() }).strict(),
  envelope.extend({ kind: z.literal('revert') }).strict(),
]);
export type DraftCommand = z.infer<typeof draftCommandSchema>;

interface Draft {
  status: LicenseClassification['status'];
  reviewComment: string | null;
  sequence: number;
}

export class LicenseReviewDrafts {
  readonly epoch = randomUUID();
  private readonly rows = new Map<string, Draft>();
  private readonly receipts = new Map<string, { fingerprint: string; ack: DraftAck }>();

  get size() {
    return this.rows.size;
  }

  values(row: LicenseClassification) {
    const draft = this.rows.get(row.normalizedText);
    return {
      status: draft?.status ?? row.status,
      reviewComment: draft ? draft.reviewComment : (row.reviewComment ?? null),
      reviewState: draft ? ('human_reviewed' as const) : row.reviewState,
      reviewedBy: draft ? null : row.reviewedBy,
      decisionAt: draft ? null : row.decisionAt,
      humanReviewedAt: draft ? null : row.humanReviewedAt,
      pending: Boolean(draft),
      sequence: draft?.sequence ?? null,
    };
  }

  apply(
    command: DraftCommand,
    row: LicenseClassification,
    revision: number,
    writable: boolean,
    navigate: (
      query: z.output<typeof reviewQuerySchema>,
      values: ReturnType<LicenseReviewDrafts['values']>
    ) => NonNullable<DraftAck['navigation']>
  ) {
    const current = this.values(row);
    const fingerprint = JSON.stringify([
      command.epoch,
      command.contentRevision,
      command.id,
      command.kind,
      command.kind === 'mark-next' && command.query,
      command.kind === 'patch' && [
        command.status,
        command.reviewComment === undefined ? [] : command.reviewComment,
        command.touched,
      ],
    ]);
    const receipt = this.receipts.get(command.mutationId);
    if (receipt?.fingerprint === fingerprint) return structuredClone(receipt.ack);
    const header = { id: command.id, mutationId: command.mutationId, epoch: this.epoch };
    if (
      receipt ||
      command.epoch !== this.epoch ||
      command.contentRevision !== revision ||
      !writable
    )
      return { ...header, conflict: true as const, contentRevision: revision, values: current };

    const navigation =
      command.kind === 'mark-next'
        ? navigate(command.query, {
            ...current,
            pending: true,
            reviewState: 'human_reviewed',
            reviewedBy: null,
            decisionAt: null,
            humanReviewedAt: null,
          })
        : undefined;
    let changed = false;
    if (command.kind === 'revert') {
      changed = this.rows.delete(row.normalizedText);
    } else {
      const status = command.kind === 'patch' ? (command.status ?? current.status) : current.status;
      const reviewComment =
        command.kind === 'patch' && command.reviewComment !== undefined
          ? command.reviewComment
          : current.reviewComment;
      changed =
        status !== current.status ||
        reviewComment !== current.reviewComment ||
        (!current.pending && (command.kind !== 'patch' || command.touched));
      if (changed)
        this.rows.set(row.normalizedText, { status, reviewComment, sequence: revision + 1 });
    }
    const ack: DraftAck = {
      ...header,
      conflict: false,
      ...(navigation && { navigation }),
      contentRevision: revision + Number(changed),
      values: this.values(row),
    };
    this.receipts.set(command.mutationId, { fingerprint, ack: structuredClone(ack) });
    return ack;
  }
}

interface DraftAck {
  navigation?: { nextEligibleId: string | null; remaining: number; page: number; total: number };
  id: string;
  mutationId: string;
  epoch: string;
  conflict: false;
  contentRevision: number;
  values: ReturnType<LicenseReviewDrafts['values']>;
}
