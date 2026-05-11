import type { Command } from 'commander';

import { failNotImplemented } from './shared.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate an agentflow artifact.')
    .argument('<artifact>', 'Artifact file to validate')
    .action(() => failNotImplemented('validate'));
}
