import { config } from 'dotenv';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

import { runLicenseCommand } from '@/domains/bible-provider-resources/classification/license-command';
import {
  LICENSE_COMMAND_HELP,
  parseLicenseCommandOptions,
} from '@/domains/bible-provider-resources/classification/license-command-options';

// Load credentials without importing the application's DB/auth environment schema.
config({ quiet: true });
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
  const parsed = parseLicenseCommandOptions(process.argv.slice(2), interactive);
  if (parsed.help) io.write(LICENSE_COMMAND_HELP);
  else {
    if (!process.env.GEMINI_API_KEY?.trim())
      throw new Error('A nonempty GEMINI_API_KEY is required');
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
      apiKey: process.env.GEMINI_API_KEY,
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
  io.write(`${error instanceof Error ? error.message : String(error)}\n${LICENSE_COMMAND_HELP}`);
  terminal?.close();
  process.exitCode = 1;
}
