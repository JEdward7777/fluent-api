import { config } from 'dotenv';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

import { licenseApiKey } from '@/domains/bible-provider-resources/classification/license-api-key';
import { runLicenseCommand } from '@/domains/bible-provider-resources/classification/license-command';
import {
  LICENSE_WORKBENCH_HELP,
  parseLicenseWorkbenchLaunch,
} from '@/domains/bible-provider-resources/classification/license-workbench-launch';
import { startLicenseWorkbenchServer } from '@/domains/bible-provider-resources/classification/license-workbench-server';

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
let terminal: ReturnType<typeof createInterface> | undefined;
const io = {
  write: (message: string) => {
    process.stdout.write(`${message}\n`);
  },
  ask: async (question: string) => {
    terminal ??= createInterface({ input: process.stdin, output: process.stdout });
    return terminal.question(question);
  },
};
try {
  const args = process.argv.slice(2);
  // Help and practice stay keyless and do not read local configuration.
  if (!args.includes('--help') && !args.includes('-h') && !args.includes('--practice'))
    config({ quiet: true });
  const parsed = parseLicenseWorkbenchLaunch(args, interactive, {
    GOOGLE_AI_MODEL: process.env.GOOGLE_AI_MODEL,
  });
  if (parsed.kind === 'help') io.write(LICENSE_WORKBENCH_HELP);
  else if (parsed.kind === 'web') {
    const workbench = await startLicenseWorkbenchServer(
      parsed.options,
      parsed.port,
      'practice' in parsed && parsed.practice,
      parsed.localProxyUrl
    );
    io.write(`Open ${workbench.url}`);
    io.write(
      'Loopback only. Ctrl+C stops the local workbench. Use only a local port forward or the explicitly configured loopback CodeServer proxy.'
    );
    if (interactive) {
      const command =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
      try {
        await promisify(execFile)(command, [workbench.url]);
      } catch {
        io.write('Automatic browser opening was unavailable; open the printed local URL yourself.');
      }
    }
    process.once('SIGINT', () => {
      void workbench.close().then(() => {
        process.exitCode = 0;
      });
    });
    process.once('SIGTERM', () => {
      void workbench.close().then(() => {
        process.exitCode = 0;
      });
    });
  } else {
    const apiKey = licenseApiKey();
    if (!apiKey) throw new Error('A nonempty GOOGLE_AI_API_KEY is required');
    const options = parsed.options;
    while (!options.source) {
      const source = (
        await io.ask('Source: json (ordinary review/import) or database (maintenance/export)? ')
      )
        .trim()
        .toLowerCase();
      if (source === 'json' || source === 'database') options.source = source;
    }
    while (!options.destination) {
      const destination = (
        await io.ask('Destination: json (review/export), database (maintenance/import), or both? ')
      )
        .trim()
        .toLowerCase();
      if (destination === 'json' || destination === 'database' || destination === 'both')
        options.destination = destination;
    }
    const exit = await runLicenseCommand(options, {
      apiKey,
      interactive,
      io,
      openReport: async (path) => {
        const command =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
        await promisify(execFile)(command, [path]);
      },
    });
    terminal?.close();
    // The lazy database adapter owns the application's pool; this developer entry exits explicitly.
    process.exit(exit);
  }
} catch (error) {
  io.write(`${error instanceof Error ? error.message : String(error)}\n${LICENSE_WORKBENCH_HELP}`);
  terminal?.close();
  process.exitCode = 1;
}
