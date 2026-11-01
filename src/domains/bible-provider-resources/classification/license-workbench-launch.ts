import { parseArgs } from 'node:util';

import { LICENSE_COMMAND_HELP, parseLicenseCommandOptions } from './license-command-options';

export const LICENSE_WORKBENCH_HELP = `${LICENSE_COMMAND_HELP}

Browser workbench: npm run db:classify:licenses -- [--ui=web] [--port=8766]
With both stdin and stdout on a terminal, no UI flag opens browser setup. Non-terminal
invocations use the CLI unless --ui=web is explicit. --ui=cli retains terminal review.
Browser setup never reads inputs or spends model requests before Inspect inputs; Start analysis
is separate and may call Gemini and write the request cache. Save publishes policy/artifacts.
CLI --plan-only with a database source may call Gemini and write cache, reports, or JSON;
it never commits classification policy. --yes and --plan-only select CLI automation.
--open-report stays in CLI. Browser mode cannot use --yes, --plan-only or --open-report.
--practice will use an offline JSON-to-JSON scratch copy; it cannot attest or target a DB.
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
      practice: { type: 'boolean' },
    },
  });
  const ui = values.ui;
  if (ui !== undefined && ui !== 'cli' && ui !== 'web')
    throw new Error('Select --ui=web or --ui=cli');
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--ui' || arg === '--port') {
      index++;
      continue;
    }
    if (arg === '--practice' || arg.startsWith('--ui=') || arg.startsWith('--port=')) continue;
    remaining.push(arg);
  }
  if (
    ui === 'web' &&
    remaining.some((arg) => ['--yes', '--plan-only', '--open-report'].includes(arg))
  )
    throw new Error('Browser mode uses its own confirmation actions; use --ui=cli for automation');
  if (values.practice)
    throw new Error(
      'Offline --practice is being prepared; no workbench or real workflow was started'
    );
  const web =
    ui === 'web' ||
    (ui === undefined &&
      interactive &&
      !remaining.includes('--yes') &&
      !remaining.includes('--plan-only') &&
      !remaining.includes('--open-report'));
  if (!web && values.port !== undefined) throw new Error('--port applies only to browser mode');
  const parsed = parseLicenseCommandOptions(remaining, web || interactive);
  if (parsed.help) return { kind: 'help' as const };
  if (!web) return { kind: 'cli' as const, options: parsed.options };
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isSafeInteger(port) || (values.port !== undefined && port < 1) || port > 65535)
    throw new Error('--port must be an integer from 1 to 65535');
  return { kind: 'web' as const, options: parsed.options, port };
}
