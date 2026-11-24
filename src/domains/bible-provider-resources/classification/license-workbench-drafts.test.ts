import { readdir, readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import {
  recordHumanLicenseDecision,
  reviseLicenseArtifact,
  serializeLicenseArtifact,
} from '../license-artifact';
import { makeCommandFixture } from './license-command.test-fixtures';
import { startLicenseWorkbenchServer } from './license-workbench-server';

it.each([
  { priorHuman: false, next: 'analyze' },
  { priorHuman: false, next: 'load' },
  { priorHuman: true, next: 'load' },
])(
  'acknowledges drafts across reloads, retries and conflicting tabs without publishing or analyzing (prior human review $priorHuman, next $next)',
  async ({ priorHuman, next }) => {
    const fixture = await makeCommandFixture();
    const row = fixture.artifact.classifications.find((candidate) => candidate.source === 'rule')!;
    const sourceBytes = priorHuman
      ? serializeLicenseArtifact(
          recordHumanLicenseDecision(
            fixture.artifact,
            row.normalizedText,
            row.status,
            { reviewComment: 'Prior human comment' },
            'Prior reviewer',
            '2026-01-01T00:00:00.000Z'
          )
        ).bytes
      : fixture.sourceBytes;
    await writeFile(fixture.input, sourceBytes);
    const server = await startLicenseWorkbenchServer(
      fixture.options,
      0,
      false,
      undefined,
      fixture.dependencies
    );
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (route: string, body?: unknown) =>
      fetch(`${base}/api/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: base,
          'x-workbench-token': new URL(server.url).hash.slice(1),
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    try {
      const stale = {
        kind: 'mark',
        id: '0'.repeat(64),
        mutationId: crypto.randomUUID(),
        epoch: crypto.randomUUID(),
        contentRevision: 42,
      };
      const unloaded = await call('review/draft', stale);
      expect(unloaded.status).toBe(409);
      expect(await unloaded.json()).toEqual({
        id: stale.id,
        mutationId: stale.mutationId,
        conflict: true,
        epoch: null,
        contentRevision: 0,
        values: null,
      });
      const op = crypto.randomUUID();
      expect((await call('inspect', { operationId: op, configurationRevision: 1 })).status).toBe(
        202
      );
      await expect.poll(async () => (await (await call('setup')).json()).state).toBe('inspected');
      const list = await (await call('review')).json();
      const { id, status } = list.rows.find(
        (candidate: { normalizedText: string }) => candidate.normalizedText === row.normalizedText
      );
      const before = await (await call(`review/${id}`)).json();
      expect(before.reviewState).toBe(priorHuman ? 'human_reviewed' : 'unreviewed');
      if (priorHuman)
        expect(
          (
            await call('preview', {
              configurationRevision: before.configurationRevision,
              contentRevision: list.contentRevision,
            })
          ).status
        ).toBe(200);
      const envelope = {
        id,
        epoch: list.epoch,
        contentRevision: list.contentRevision,
        mutationId: crypto.randomUUID(),
      };
      const draft = (payload: object) => call('review/draft', payload);
      const noop = await (
        await draft({ ...envelope, kind: 'patch', status, touched: false })
      ).json();
      expect(noop.values.pending).toBe(false);
      expect(Boolean((await (await call('setup')).json()).preview)).toBe(priorHuman);
      const command = {
        ...envelope,
        mutationId: crypto.randomUUID(),
        kind: 'patch',
        status,
        reviewComment: 'Local edit',
        touched: true,
      };
      // The first request's response is discarded. Recover the acknowledgement by replay.
      expect((await draft(command)).status).toBe(200);
      const ack = await (await draft(command)).json();
      expect(ack).toMatchObject({
        contentRevision: list.contentRevision + 1,
        values: {
          pending: true,
          reviewState: 'human_reviewed',
          reviewedBy: null,
          decisionAt: null,
          reviewComment: 'Local edit',
        },
      });
      expect(await (await call(`review/${id}`)).json()).toMatchObject(ack.values);
      expect(await (await call('setup')).json()).toMatchObject({
        preview: null,
        analysis: { pendingReviews: 1 },
      });
      for (const concurrent of [
        { ...command, reviewComment: 'Different payload' },
        { ...command, mutationId: crypto.randomUUID(), reviewComment: 'Second tab' },
        {
          ...command,
          mutationId: crypto.randomUUID(),
          epoch: crypto.randomUUID(),
          contentRevision: ack.contentRevision,
        },
      ]) {
        const conflict = await draft(concurrent);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({
          conflict: true,
          contentRevision: ack.contentRevision,
          values: ack.values,
        });
      }
      const revert = await (
        await draft({
          ...envelope,
          kind: 'revert',
          contentRevision: ack.contentRevision,
          mutationId: crypto.randomUUID(),
        })
      ).json();
      expect(revert.values).toMatchObject({
        status,
        pending: false,
        reviewState: before.reviewState,
        reviewedBy: before.reviewedBy,
        reviewComment: before.reviewComment,
      });
      expect(await (await draft(command)).json()).toEqual(ack);
      const mark = await (
        await draft({
          ...envelope,
          kind: 'mark',
          contentRevision: revert.contentRevision,
          mutationId: crypto.randomUUID(),
        })
      ).json();
      expect(mark.values).toMatchObject({ status, pending: true });
      expect((await (await call(`review/${id}`)).json()).sequence).toBe(mark.contentRevision);
      expect(await readFile(fixture.input, 'utf8')).toBe(sourceBytes);
      expect(await readdir(fixture.dir)).toEqual(['input.json']);
      expect(fixture.dependencies.transport).not.toHaveBeenCalled();
      expect(fixture.dependencies.database).not.toHaveBeenCalled();
      if (!priorHuman) {
        const cleared = await (
          await draft({
            ...envelope,
            kind: 'revert',
            mutationId: crypto.randomUUID(),
            contentRevision: mark.contentRevision,
          })
        ).json();
        expect(cleared.conflict).toBe(false);
        expect(await (await call('setup')).json()).toMatchObject({
          state: 'inspected',
          preview: null,
        });
      }
      if (next === 'analyze') {
        const analyzeId = crypto.randomUUID();
        expect(
          (await call('analysis', { operationId: analyzeId, configurationRevision: 1 })).status
        ).toBe(202);
        await expect
          .poll(async () => (await (await call('setup')).json()).latestOperation)
          .toMatchObject({ operationId: analyzeId, state: 'succeeded' });
      } else {
        const setup = await (await call('setup')).json();
        const selected = Object.fromEntries(
          [
            'source',
            'destination',
            'output',
            'model',
            'sampleCount',
            'force',
            'noCache',
            'cacheDir',
            'reportFormats',
            'reportDir',
            'preserveExistingNonUnknowns',
            'configurationRevision',
          ].map((key) => [key, setup[key]])
        );
        const replacement = reviseLicenseArtifact(fixture.artifact, (artifact) => {
          artifact.classifications = [];
          artifact.catalog = [];
        });
        const input = `${fixture.dir}/replacement.json`;
        await writeFile(input, serializeLicenseArtifact(replacement).bytes);
        expect(
          (
            await call('setup', {
              ...selected,
              input,
              discardReviewedState: priorHuman,
              ...(priorHuman ? { expectedContentRevision: mark.contentRevision } : {}),
            })
          ).status
        ).toBe(200);
        const selectedSetup = await (await call('setup')).json();
        const loadId = crypto.randomUUID();
        expect(
          (
            await call('inspect', {
              operationId: loadId,
              configurationRevision: selectedSetup.configurationRevision,
              discardReviewedState: priorHuman,
              ...(priorHuman ? { expectedContentRevision: mark.contentRevision } : {}),
            })
          ).status
        ).toBe(202);
        await expect
          .poll(async () => (await (await call('setup')).json()).latestOperation)
          .toMatchObject({ operationId: loadId, state: 'succeeded' });
        const current = await (await call('review')).json();
        expect(current.epoch).not.toBe(list.epoch);
        const conflict = await draft(command);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({
          conflict: true,
          epoch: current.epoch,
          contentRevision: current.contentRevision,
          values: null,
        });
      }
      expect(JSON.stringify(ack)).not.toMatch(/mock-key|normalizedText|samples|requestHash/);
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  }
);
