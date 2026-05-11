import type { Command } from 'commander';

import { failNotImplemented } from './shared.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check local provider and configuration readiness.')
    .requiredOption('--config <file>', 'Agentflow config file')
    .action(() => failNotImplemented('doctor'));
}
