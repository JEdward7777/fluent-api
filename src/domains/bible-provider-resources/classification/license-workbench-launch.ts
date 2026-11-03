import { parseArgs } from 'node:util';

import { LICENSE_COMMAND_HELP, parseLicenseCommandOptions } from './license-command-options';

export const LICENSE_WORKBENCH_HELP = `${LICENSE_COMMAND_HELP}

Browser workbench: npm run db:classify:licenses -- [--ui=web] [--port=8766]
For a loopback CodeServer proxy, add --local-proxy-url=http://localhost:8454/proxy/8766/
with the proxy port matching --port. This explicitly permits that local Host and Origin.
With both stdin and stdout on a terminal, no UI flag opens browser setup. Non-terminal
invocations use the CLI unless --ui=web is explicit. --ui=cli retains terminal review.
Browser setup never reads inputs or spends model requests before Inspect inputs; Start analysis
is separate and may call Gemini and write the request cache. Save publishes policy/artifacts.
CLI --plan-only with a database source may call Gemini and write cache, reports, or JSON;
it never commits classification policy. --yes and --plan-only select CLI automation.
--open-report stays in CLI. Browser mode cannot use --yes, --plan-only or --open-report.
--practice opens offline JSON-to-JSON review. Optional --input=PATH selects saved JSON;
without it, Inspect copies the bundled example. Practice creates a private scratch folder
only after Inspect, saves incomplete JSON there, and never attests or targets a DB.
Use --ui=web in non-terminal practice. Practice rejects CLI automation and real-target flags.
JSON→JSON reviews saved evidence; database→JSON exports a candidate; JSON→database
imports reviewed policy (nonempty replacement needs --force); database→database maintains
policy. --destination=both writes both targets with the existing compensation protocol.
The local server binds 127.0.0.1. For a container, choose --port=8766 and forward
container 127.0.0.1:8766 to local 127.0.0.1:8766 using an IDE Ports panel or SSH
local tunnel. Do not use a public forwarded domain. Ctrl+C stops new work and waits for
active writes; forced process death can leave an uncertain commit requiring target inspection.
Examples:
  npm run db:classify:licenses -- --ui=web --source=json
  npm run db:classify:licenses -- --ui=cli --source=json --destination=json
  npm run db:classify:licenses -- --source=database --destination=json --yes
`;

export function parseLicenseWorkbenchLaunch(args: string[], interactive: boolean) {
  // Help does not validate unrelated options or initialize credentials, files, or a server.
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' as const };
  const { values } = parseArgs({
    args,
    strict: false,
    options: {
      ui: { type: 'string' },
      port: { type: 'string' },
      'local-proxy-url': { type: 'string' },
      practice: { type: 'boolean' },
    },
  });
  const ui = values.ui;
  if (ui !== undefined && ui !== 'cli' && ui !== 'web')
    throw new Error('Select --ui=web or --ui=cli');
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--ui' || arg === '--port' || arg === '--local-proxy-url') {
      index++;
      continue;
    }
    if (
      arg === '--practice' ||
      arg.startsWith('--ui=') ||
      arg.startsWith('--port=') ||
      arg.startsWith('--local-proxy-url=')
    )
      continue;
    remaining.push(arg);
  }
  if (
    !values.practice &&
    ui === 'web' &&
    remaining.some((arg) => ['--yes', '--plan-only', '--open-report'].includes(arg))
  )
    throw new Error('Browser mode uses its own confirmation actions; use --ui=cli for automation');
  if (values.practice) {
    if (
      ui === 'cli' ||
      remaining.some((arg) =>
        /^--(?:yes|plan-only|open-report|output|report-dir|cache-dir|source|destination|force|reviewer|review-reason|model|sample-count|no-cache|report-formats|preserve-existing-non-unknowns)(?:=|$)/.test(
          arg
        )
      )
    )
      throw new Error(
        'Practice accepts only --input, --port, --local-proxy-url and --ui=web; it cannot select real targets, automation or reviewers'
      );
    if (!interactive && ui !== 'web')
      throw new Error('Non-terminal practice requires explicit --ui=web');
    const parsed = parseLicenseCommandOptions(remaining, true);
    if (parsed.help) return { kind: 'help' as const };
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isSafeInteger(port) || (values.port !== undefined && port < 1) || port > 65535)
      throw new Error('--port must be an integer from 1 to 65535');
    const localProxyUrl = parseLocalProxyUrl(values['local-proxy-url'], port);
    const inputSelected = remaining.some((arg) => arg === '--input' || arg.startsWith('--input='));
    return {
      kind: 'web' as const,
      options: { ...parsed.options, input: inputSelected ? parsed.options.input : '' },
      port,
      localProxyUrl,
      practice: true as const,
    };
  }
  const web =
    ui === 'web' ||
    (ui === undefined &&
      interactive &&
      !remaining.includes('--yes') &&
      !remaining.includes('--plan-only') &&
      !remaining.includes('--open-report'));
  if (!web && (values.port !== undefined || values['local-proxy-url'] !== undefined))
    throw new Error('--port and --local-proxy-url apply only to browser mode');
  const parsed = parseLicenseCommandOptions(remaining, web || interactive);
  if (parsed.help) return { kind: 'help' as const };
  if (!web) return { kind: 'cli' as const, options: parsed.options };
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isSafeInteger(port) || (values.port !== undefined && port < 1) || port > 65535)
    throw new Error('--port must be an integer from 1 to 65535');
  return {
    kind: 'web' as const,
    options: parsed.options,
    port,
    localProxyUrl: parseLocalProxyUrl(values['local-proxy-url'], port),
  };
}

function parseLocalProxyUrl(value: string | boolean | undefined, port: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('--local-proxy-url requires a URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--local-proxy-url must be a loopback HTTP CodeServer proxy URL');
  }
  if (
    port === 0 ||
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/proxy/${port}/` ||
    url.href !== value
  )
    throw new Error(
      '--local-proxy-url must be http://localhost:LOCAL_PORT/proxy/WORKBENCH_PORT/ matching --port'
    );
  return value;
}
