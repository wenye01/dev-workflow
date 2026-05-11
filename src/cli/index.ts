import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerDoctorCommand } from './commands/doctor.js';
import { registerProjectIndexCommand } from './commands/project-index.js';
import { registerResumeCommand } from './commands/resume.js';
import { registerRunCommand } from './commands/run.js';
import { registerToolCommand } from './commands/tool.js';
import { registerValidateCommand } from './commands/validate.js';

const VERSION = '0.0.0';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentflow')
    .description('Single-repository agent workflow CLI.')
    .version(VERSION)
    .showHelpAfterError();

  registerRunCommand(program);
  registerProjectIndexCommand(program);
  registerResumeCommand(program);
  registerValidateCommand(program);
  registerDoctorCommand(program);
  registerToolCommand(program);

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (isDirectCliInvocation()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify(
        {
          error: {
            code: 'AGENTFLOW_UNHANDLED_ERROR',
            message,
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}

function isDirectCliInvocation(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
