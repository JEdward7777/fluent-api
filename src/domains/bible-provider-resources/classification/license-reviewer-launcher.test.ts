import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const launcherTest = it.skipIf(process.platform === 'win32');
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const podman = `#!/usr/bin/env bash
printf '%s\\0' podman "$@" END >> "$LAUNCH_LOG"
[[ "$1" == --remote=false ]] || exit 99
shift
case "$1" in
  --version) printf 'podman version %s\\n' "$MOCK_PODMAN_VERSION" ;;
  network) printf '%s\\n' "$MOCK_NETWORK_DRIVER" ;;
  build) exit "$MOCK_BUILD_EXIT" ;;
  run) exit "$MOCK_RUN_EXIT" ;;
  *) exit 99 ;;
esac
`;
const docker = `#!/usr/bin/env bash
printf '%s\\0' docker "$@" END >> "$LAUNCH_LOG"
if [[ "$1" == version ]]; then printf '29.1.3\\n'; fi
if [[ "$1" == network ]]; then printf 'bridge\\n'; fi
`;

async function launcherFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'license-launcher-')));
  temporary.push(root);
  const api = join(root, 'checkout with spaces');
  const json = join(api, 'docs/features/tts-license-ingestion/reference');
  const reports = join(api, '.temp/license-reports');
  const bin = join(root, 'bin');
  const log = join(root, 'calls');
  await Promise.all([mkdir(json, { recursive: true }), mkdir(bin)]);
  await Promise.all([
    copyFile('license-reviewer.sh', join(api, 'license-reviewer.sh')),
    writeFile(join(bin, 'podman'), podman, { mode: 0o755 }),
    writeFile(join(bin, 'docker'), docker, { mode: 0o755 }),
    writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" "$MOCK_HOST_OS"\n', { mode: 0o755 }),
    writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "%s\\n" "$MOCK_HOST_UID"\n', {
      mode: 0o755,
    }),
  ]);
  return {
    root,
    api,
    json,
    reports,
    launch: async (args: string[], environment: NodeJS.ProcessEnv = {}) => {
      await writeFile(log, '');
      const launched = spawnSync('bash', [join(api, 'license-reviewer.sh'), ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          LAUNCH_LOG: log,
          HOME: root,
          MOCK_PODMAN_VERSION: '5.3.0',
          MOCK_NETWORK_DRIVER: 'bridge',
          MOCK_HOST_UID: '1234',
          MOCK_HOST_OS: 'Linux',
          MOCK_BUILD_EXIT: '0',
          MOCK_RUN_EXIT: '0',
          ...environment,
        },
      });
      const calls = (await readFile(log, 'utf8'))
        .split('END\0')
        .filter(Boolean)
        .map((call) => call.slice(0, -1).split('\0'));
      return { ...launched, calls };
    },
  };
}

launcherTest(
  'automatically uses local Podman with mapped rootless ownership and loopback-only web',
  async () => {
    const fixture = await launcherFixture();
    await writeFile(join(fixture.api, '.env'), 'GOOGLE_AI_MODEL=google:fixture\n');
    const launched = await fixture.launch(['--port', '8767', '--', '--source=json'], {
      DATABASE_URL: 'postgres://fixture:secret@invalid/fixture',
      CONTAINER_HOST: 'ssh://would-select-a-remote-engine',
    });
    expect(launched.status).toBe(0);
    const [version, build, run] = launched.calls;
    expect(version).toEqual(['podman', '--remote=false', '--version']);
    expect(build).toEqual([
      'podman',
      '--remote=false',
      'build',
      '-f',
      'Dockerfile.license-reviewer',
      '--ignorefile',
      'Dockerfile.license-reviewer.dockerignore',
      '-t',
      'localhost/fluent-license-reviewer:latest',
      '.',
    ]);
    expect(run.slice(0, 3)).toEqual(['podman', '--remote=false', 'run']);
    expect(run).toEqual(
      expect.arrayContaining([
        '--rm',
        '--init',
        '--sig-proxy=true',
        '--stop-timeout=120',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--userns=keep-id:uid=1000,gid=1000',
        '--user=1000:1000',
        '--network=pasta',
        '127.0.0.1:8767:8767',
        `${fixture.json}:/app/docs/features/tts-license-ingestion/reference:z`,
        `${fixture.reports}:/reports:z`,
        'fluent-license-reviewer-model-cache:/cache',
        'LICENSE_REVIEWER_CONTAINER=1',
        'LICENSE_REVIEWER_ENGINE=Podman',
        'LICENSE_REVIEWER_UI=web',
        'LICENSE_REVIEWER_PORT=8767',
        `LICENSE_REVIEWER_HOST_REPORTS=${fixture.reports}`,
        'HOME=/tmp',
        'XDG_CACHE_HOME=/cache',
        'NODE_ENV=production',
      ])
    );
    expect(run.slice(run.indexOf('--env-file'), run.indexOf('--env-file') + 2)).toEqual([
      '--env-file',
      '.env',
    ]);
    expect(run.slice(run.indexOf('DATABASE_URL') - 1, run.indexOf('DATABASE_URL') + 1)).toEqual([
      '--env',
      'DATABASE_URL',
    ]);
    expect(run.join(' ')).not.toContain('secret');
    expect(run.slice(-3)).toEqual([
      'localhost/fluent-license-reviewer:latest',
      'dist/src/db/scripts/classify-licenses.js',
      '--source=json',
    ]);
    expect(run).not.toContain('--pod');
    expect(run).not.toContain('--tty');
  }
);

launcherTest(
  'keeps CLI unpublished, validates existing bridges and preserves caller-owned custom mounts',
  async () => {
    const fixture = await launcherFixture();
    const reports = join(fixture.root, 'private report dir');
    const externalJson = join(fixture.root, 'custom JSON');
    await mkdir(externalJson);
    const launched = await fixture.launch(
      ['--runtime=podman', '--ui=cli', '--network=review-db', '--', '--yes'],
      {
        MOCK_HOST_UID: '0',
        LICENSE_REVIEWER_UID: '1234',
        LICENSE_REVIEWER_GID: '2345',
        LICENSE_REVIEWER_REPORT_DIR: reports,
        LICENSE_REVIEWER_JSON_DIR: externalJson,
      }
    );
    expect(launched.status).toBe(0);
    expect(launched.calls[1]).toEqual([
      'podman',
      '--remote=false',
      'network',
      'inspect',
      '--format',
      '{{.Driver}}',
      '--',
      'review-db',
    ]);
    const run = launched.calls.at(-1)!;
    expect(run).toEqual(
      expect.arrayContaining([
        '--network=review-db',
        '--userns=host',
        '--user=1234:2345',
        '--interactive',
        `${reports}:/reports`,
        `${externalJson}:/app/docs/features/tts-license-ingestion/reference`,
      ])
    );
    expect(run).not.toContain('--tty');
    expect(run).not.toContain('--publish');
    expect(run).not.toContain('--env-file');
    expect(run.join(' ')).not.toContain(':U');
  }
);

launcherTest(
  'rejects unsafe networks, foreign bridge drivers and ambiguous bind paths before build',
  async () => {
    const fixture = await launcherFixture();
    for (const network of ['host', 'container:fluent-db', 'pasta', 'slirp4netns', 'none']) {
      const launched = await fixture.launch(['--runtime=podman', `--network=${network}`]);
      expect(launched.stderr).toContain('Select an existing bridge network');
      expect(launched.calls).toHaveLength(1);
    }
    const wrongDriver = await fixture.launch(['--runtime=podman', '--network=macvlan-db'], {
      MOCK_NETWORK_DRIVER: 'macvlan',
    });
    expect(wrongDriver.status).toBe(1);
    expect(wrongDriver.calls).toHaveLength(2);
    const colonPath = await fixture.launch(['--runtime=podman'], {
      LICENSE_REVIEWER_REPORT_DIR: join(fixture.root, 'path:colon'),
    });
    expect(colonPath.stderr).toContain('cannot contain a colon');
    expect(colonPath.calls).toHaveLength(1);
  }
);

launcherTest(
  'propagates build and occupied-port failures without retrying or starting other services',
  async () => {
    const fixture = await launcherFixture();
    const failedBuild = await fixture.launch([], { MOCK_BUILD_EXIT: '2' });
    expect(failedBuild.status).toBe(2);
    expect(failedBuild.calls).toHaveLength(2);
    const failedRun = await fixture.launch([], { MOCK_RUN_EXIT: '125' });
    expect(failedRun.status).toBe(125);
    expect(failedRun.calls).toHaveLength(3);
    expect(failedRun.calls[2]).toContain('127.0.0.1:8766:8766');
  }
);

launcherTest(
  'retains Docker Compose selection, publication, and forwarding for an older Podman',
  async () => {
    const fixture = await launcherFixture();
    const automatic = await fixture.launch(['--', '--practice'], { MOCK_PODMAN_VERSION: '5.2.0' });
    expect(automatic.status).toBe(0);
    expect(automatic.calls.map((call) => call[0])).toEqual([
      'podman',
      'docker',
      'docker',
      'docker',
    ]);
    expect(automatic.calls.at(-1)).toEqual([
      'docker',
      'compose',
      '-f',
      'compose.license-reviewer.yaml',
      'run',
      '--rm',
      '--build',
      '--no-deps',
      '--service-ports',
      'reviewer',
      '--practice',
    ]);
    const forced = await fixture.launch(['--runtime=docker', '--ui=cli']);
    expect(forced.calls.map((call) => call[0])).toEqual(['docker', 'docker']);
    expect(forced.calls.at(-1)).not.toContain('--service-ports');
    const unsupported = await fixture.launch(['--runtime=podman'], {
      MOCK_PODMAN_VERSION: '5.2.0',
    });
    expect(unsupported.stderr).toContain('Linux Podman 5.3 or later');
    expect(unsupported.calls).toHaveLength(1);
    const desktop = await fixture.launch([], { MOCK_HOST_OS: 'Darwin' });
    expect(desktop.status).toBe(0);
    expect(desktop.calls.map((call) => call[0])).toEqual(['docker', 'docker', 'docker']);
  }
);
