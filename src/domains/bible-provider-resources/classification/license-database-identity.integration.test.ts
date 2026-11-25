import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { license_classifications, licenseReviewStateEnum, ttsLicenseStatusEnum } from '@/db/schema';

import { createOwnedLicenseDatabaseAdapter } from './license-classifications.service';
import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseWorkflow } from './license-workflow';

const docker = promisify(execFile);
const containers: string[] = [];
const endpoints: string[] = [];

// This opt-in exercises real PostgreSQL backend lock visibility across independent clusters.
// All connections use ports allocated by these disposable containers.
describe.runIf(process.env.LICENSE_IDENTITY_POSTGRES_TEST === '1')(
  'postgreSQL classification target identity',
  () => {
    beforeAll(async () => {
      const statements = await generateMigration(
        generateDrizzleJson({}),
        generateDrizzleJson({
          license_classifications,
          licenseReviewStateEnum,
          ttsLicenseStatusEnum,
        })
      );
      for (let i = 0; i < 2; i++) {
        const name = `license-identity-${randomUUID()}`;
        containers.push(name);
        await docker('docker', [
          'run',
          '--detach',
          '--rm',
          '--name',
          name,
          '--publish',
          '127.0.0.1::5432',
          '-e',
          'POSTGRES_HOST_AUTH_METHOD=trust',
          'postgres:16-alpine',
        ]);
        const { stdout } = await docker('docker', ['port', name, '5432/tcp']);
        const host = stdout.trim();
        if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new Error('Unexpected disposable DB address');
        const admin = postgres(`postgres://postgres@${host}/postgres`, {
          max: 1,
          connect_timeout: 1,
        });
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              await admin`select 1`;
              break;
            } catch (error) {
              if (attempt === 89) throw error;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
          await admin.unsafe(statements.join('\n'));
          await admin.unsafe(`
          CREATE TABLE bibles (id int, provider text, external_id text, name text, abbreviation text);
          CREATE TABLE bible_provider_resources (provider text, external_id text, text_license_notice text, tts_license_status text);
          CREATE ROLE api_user LOGIN;
          CREATE ROLE alias_user LOGIN;
          GRANT USAGE ON SCHEMA public TO api_user, alias_user;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO api_user, alias_user;
        `);
        } finally {
          await admin.end();
        }
        endpoints.push(host);
      }
    }, 240000);
    afterAll(async () => {
      await Promise.all(containers.map((name) => docker('docker', ['rm', '--force', name])));
    }, 60000);

    it('keeps the source challenge on the Load backend when new connections route to the target clone', async () => {
      const f = await makeCommandFixture(false);
      const [a, b] = endpoints;
      let route = a;
      const connections: string[] = [];
      const proxy = createServer((incoming) => {
        connections.push(route);
        const [host, port] = route.split(':');
        const outgoing = createConnection({ host, port: Number(port) });
        incoming.pipe(outgoing).pipe(incoming);
        incoming.on('error', () => outgoing.destroy());
        outgoing.on('error', () => incoming.destroy());
        incoming.on('close', () => outgoing.destroy());
        outgoing.on('close', () => incoming.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
      const source = createOwnedLicenseDatabaseAdapter(
        `postgres://api_user@127.0.0.1:${address.port}/postgres?application_name=license-source-failover`,
        undefined,
        'source'
      );
      const target = createOwnedLicenseDatabaseAdapter(`postgres://api_user@${b}/postgres`);
      const admin = postgres(`postgres://postgres@${a}/postgres`, { max: 1 });
      const workflow = new LicenseWorkflow(
        { ...f.options, source: 'database', destination: 'database' },
        { apiKey: '', database: async () => source, destinationDatabase: async () => target }
      );
      try {
        await workflow.inspect(1);
        route = b;
        const preview = await workflow.preview(1, 1);
        expect(preview.plan.databaseProof?.mode).toBe('distinct');
        expect(preview.plan.replace).toBe(false);
        expect(connections).toEqual([a]);
        expect(
          await admin`SELECT state, xact_start FROM pg_stat_activity WHERE application_name = 'license-source-failover'`
        ).toEqual([{ state: 'idle', xact_start: null }]);
        const stopped =
          await admin`SELECT pg_terminate_backend(pid, 3000) AS stopped FROM pg_stat_activity
          WHERE application_name = 'license-source-failover' AND usename = 'api_user'`;
        expect(stopped).toEqual([{ stopped: true }]);
        await expect(
          workflow.save({
            previewToken: workflow.previewed!.token,
            operationId: 'lost-source',
            configurationRevision: 1,
            contentRevision: 1,
            agreeToReplace: false,
          })
        ).rejects.toThrow(/identity proof changed since preview/);
        expect(connections).toEqual([a, b]);
        const retry = await workflow.preview(1, 1);
        expect(retry.plan.databaseProof?.mode).toBe('unavailable');
        expect(retry.plan.replace).toBe(false);
        await workflow.save({
          previewToken: workflow.previewed!.token,
          operationId: 'safe-sync',
          configurationRevision: 1,
          contentRevision: 1,
          agreeToReplace: false,
        });
      } finally {
        await Promise.all([workflow.close(), admin.end(), f.cleanup()]);
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }, 20000);

    it('observes the challenge only on the source cluster, repeats it inside Save and rejects a changed proof', async () => {
      const f = await makeCommandFixture(false);
      const [a, b] = endpoints;
      const source = createOwnedLicenseDatabaseAdapter(`postgres://api_user@${a}/postgres`);
      const alias = createOwnedLicenseDatabaseAdapter(
        `postgres://alias_user@localhost:${a.split(':')[1]}/postgres`
      );
      const independent = createOwnedLicenseDatabaseAdapter(`postgres://api_user@${b}/postgres`);
      try {
        const initial = await source.loadSource!();
        const loadedChallenge = source.challenge!(initial.sourceMarker);
        const same = await alias.prove!(loadedChallenge);
        const distinct = await independent.prove!(loadedChallenge);
        expect(same.mode).toBe('same');
        expect(distinct.mode).toBe('distinct');
        expect(distinct.source).toEqual(distinct.target);
        expect(
          await independent.prove!(async () => {
            throw new Error('Probe denied');
          })
        ).toMatchObject({ mode: 'unavailable' });
        // Both targets have identical OIDs, empty policy and inventory. Only the writer's
        // actual session distinguishes the inspected target from the independently routed clone.
        let writer = independent;
        const rerouted = new LicenseWorkflow(
          { ...f.options, destination: 'database' },
          {
            apiKey: '',
            destinationDatabase: async () => ({
              ...independent,
              apply: (...args) => writer.apply(...args),
            }),
          }
        );
        await rerouted.inspect(1);
        await rerouted.preview(1, 1);
        writer = source;
        await expect(
          rerouted.save({
            previewToken: rerouted.previewed!.token,
            operationId: 'rerouted-clone',
            configurationRevision: 1,
            contentRevision: 1,
            agreeToReplace: false,
          })
        ).rejects.toThrow(/connection changed since preview/);
        expect((await source.load()).classifications).toHaveLength(0);
        expect((await independent.load()).classifications).toHaveLength(0);
        writer = independent;
        await rerouted.preview(1, 1);
        const restart = postgres(`postgres://postgres@${b}/postgres`, { max: 1 });
        try {
          const stopped =
            await restart`SELECT pg_terminate_backend(pid, 3000) AS stopped FROM pg_stat_activity
            WHERE usename = 'api_user' AND datname = current_database()`;
          expect(stopped).toEqual([{ stopped: true }]);
        } finally {
          await restart.end();
        }
        await expect(
          rerouted.save({
            previewToken: rerouted.previewed!.token,
            operationId: 'reconnected',
            configurationRevision: 1,
            contentRevision: 1,
            agreeToReplace: false,
          })
        ).rejects.toThrow(/connection changed since preview/);
        expect((await independent.load()).classifications).toHaveLength(0);
        await source.apply(f.artifact, true);
        const options = {
          ...f.options,
          source: 'database' as const,
          destination: 'database' as const,
        };
        const cli = new LicenseWorkflow(options, {
          ...f.dependencies,
          database: async () => source,
        });
        await cli.inspect(1);
        await cli.startAnalysis(1);
        expect((await cli.preview(1, 1)).plan.databaseProof?.mode).toBe('same');
        await cli.save({
          previewToken: cli.previewed!.token,
          operationId: 'one-adapter',
          configurationRevision: 1,
          contentRevision: 1,
          agreeToReplace: false,
        });
        const sync = new LicenseWorkflow(options, {
          apiKey: '',
          database: async () => source,
          destinationDatabase: async () => independent,
        });
        await sync.inspect(1);
        expect((await sync.preview(1, 1)).plan.databaseProof?.mode).toBe('distinct');
        // Leave the preview untouched beyond the ordinary 20-second pool
        // idle timeout. An operator reading the preview can still save it once.
        await new Promise((resolve) => setTimeout(resolve, 22000));
        await sync.save({
          previewToken: sync.previewed!.token,
          operationId: 'sync',
          configurationRevision: 1,
          contentRevision: 1,
          agreeToReplace: false,
        });
        expect((await independent.load()).classifications.length).toBe(
          f.artifact.classifications.length
        );
        const overwrite = new LicenseWorkflow(options, {
          apiKey: '',
          database: async () => source,
          destinationDatabase: async () => alias,
        });
        await overwrite.inspect(1);
        expect((await overwrite.preview(1, 1)).plan.replace).toBe(true);
        const original = source.challenge;
        source.challenge = independent.challenge;
        await expect(
          overwrite.save({
            previewToken: overwrite.previewed!.token,
            operationId: 'drift',
            configurationRevision: 1,
            contentRevision: 1,
            agreeToReplace: false,
          })
        ).rejects.toThrow(/changed since preview/);
        source.challenge = original;
        expect(overwrite.analyzed).toBeDefined();
        expect((await overwrite.preview(1, 1)).plan.databaseProof?.mode).toBe('same');
        await overwrite.save({
          previewToken: overwrite.previewed!.token,
          operationId: 'retry',
          configurationRevision: 1,
          contentRevision: 1,
          agreeToReplace: false,
        });
        const admin = postgres(`postgres://postgres@${a}/postgres`, { max: 1 });
        try {
          await admin.unsafe(`
            CREATE SCHEMA other;
            CREATE TABLE other.license_classifications (LIKE public.license_classifications INCLUDING ALL);
            GRANT USAGE ON SCHEMA other TO alias_user;
            GRANT SELECT ON other.license_classifications TO alias_user;
            ALTER ROLE alias_user SET search_path TO other, public;
          `);
          const differentRelation = await alias.prove!(
            source.challenge!((await source.loadSource!()).sourceMarker)
          );
          expect(differentRelation.mode).toBe('distinct');
          expect(differentRelation.target?.schema).toBe('other');
          await admin`ALTER ROLE alias_user RESET search_path`;
          await admin`REVOKE SELECT ON pg_catalog.pg_locks FROM PUBLIC`;
          const fallback = new LicenseWorkflow(options, {
            apiKey: '',
            database: async () => source,
            destinationDatabase: async () => alias,
          });
          await fallback.inspect(1);
          const preview = await fallback.preview(1, 1);
          expect(preview.plan.databaseProof?.mode).toBe('unavailable');
          expect(preview.plan.replace).toBe(false);
          await fallback.save({
            previewToken: fallback.previewed!.token,
            operationId: 'fallback',
            configurationRevision: 1,
            contentRevision: 1,
            agreeToReplace: false,
          });
          expect(await admin`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'`).toHaveLength(0);
          await admin`REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC`;
          const restricted = new LicenseWorkflow(options, {
            apiKey: '',
            database: async () => source,
            destinationDatabase: async () => independent,
          });
          expect((await restricted.inspect(1)).database?.sourceMarker).toBeUndefined();
          const conservative = await restricted.preview(1, 1);
          expect(conservative.plan.databaseProof?.mode).toBe('unavailable');
          expect(conservative.plan.replace).toBe(false);
          await restricted.save({
            previewToken: restricted.previewed!.token,
            operationId: 'no-source-marker',
            configurationRevision: 1,
            contentRevision: 1,
            agreeToReplace: false,
          });
        } finally {
          try {
            await admin`GRANT SELECT ON pg_catalog.pg_locks TO PUBLIC`;
            await admin`GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO PUBLIC`;
          } finally {
            await admin.end();
          }
        }
      } finally {
        await Promise.all([source.close!(), alias.close!(), independent.close!(), f.cleanup()]);
      }
    }, 60000);

    it('saves an edit from A to independent B and then to the verified physical A', async () => {
      const f = await makeCommandFixture(false);
      const [a, b] = endpoints;
      const sourceUrl = `postgres://api_user@${a}/postgres`;
      const copyUrl = `postgres://api_user@${b}/postgres`;
      const source = createOwnedLicenseDatabaseAdapter(sourceUrl, undefined, 'source');
      const copy = createOwnedLicenseDatabaseAdapter(copyUrl);
      let targetUrl = copyUrl;
      const options = {
        ...f.options,
        source: 'database' as const,
        destination: 'database' as const,
      };
      const dependencies = {
        apiKey: '',
        database: async () => source,
        destinationDatabase: async () => createOwnedLicenseDatabaseAdapter(targetUrl),
      };
      const workflow = new LicenseWorkflow(options, dependencies);
      try {
        await source.apply(f.artifact, true);
        await copy.apply(f.artifact, true);
        await workflow.inspect(1);
        const row = workflow.analyzed!.artifact.classifications[1];
        const key = row.normalizedText;
        workflow.editReview(
          {
            kind: 'disposition',
            normalizedText: key,
            status: row.status,
            reason: 'A new human decision',
            reviewedBy: 'Saved as reviewer',
          },
          1,
          1
        );
        const request = { configurationRevision: 1, contentRevision: 2, agreeToReplace: false };
        const first = await workflow.preview(1, 2);
        expect(first.plan.databaseProof?.mode).toBe('distinct');
        expect(first.plan.databaseChanges.metadataChanges).toEqual([key]);
        await workflow.save({
          ...request,
          previewToken: workflow.previewed!.token,
          operationId: 'save-copy',
        });
        const reviewer = async (adapter: typeof source) =>
          (await adapter.load()).classifications.find((item) => item.normalizedText === key)
            ?.reviewedBy;
        expect(await reviewer(copy)).toBe('Saved as reviewer');
        expect(await reviewer(source)).toBeNull();
        targetUrl = sourceUrl;
        await workflow.configureLoadedSettings(options, true, false);
        const second = await workflow.preview(1, 2);
        expect(second.plan.databaseProof?.mode).toBe('same');
        expect(second.plan.databaseChanges).toMatchObject({
          updated: [key],
          metadataChanges: [key],
          permissionChanges: [],
        });
        expect(second.plan.databaseArtifact?.classifications).toHaveLength(1);
        await workflow.save({
          ...request,
          previewToken: workflow.previewed!.token,
          operationId: 'save-source',
        });
        expect(await reviewer(source)).toBe('Saved as reviewer');
        const reloaded = new LicenseWorkflow(options, {
          ...dependencies,
          database: async () => createOwnedLicenseDatabaseAdapter(sourceUrl, undefined, 'source'),
        });
        try {
          await reloaded.inspect(1);
          const repeat = await reloaded.preview(1, 1);
          expect(repeat.plan.databaseChanges.updated).toEqual([]);
          expect(repeat.plan.databaseArtifact?.classifications).toEqual([]);
        } finally {
          await reloaded.close();
        }
      } finally {
        await Promise.all([workflow.close(), copy.close!(), f.cleanup()]);
      }
    }, 30000);
  }
);
