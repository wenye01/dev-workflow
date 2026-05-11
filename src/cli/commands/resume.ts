import type { Command } from 'commander';

import { failNotImplemented } from './shared.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .description('Resume an existing run by run id.')
    .requiredOption('--run-id <run_id>', 'Run id to resume')
    .requiredOption('--repo <path>', 'Git repository path')
    .action(() => failNotImplemented('resume'));
}
