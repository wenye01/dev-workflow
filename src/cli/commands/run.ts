import type { Command } from 'commander';

import { failNotImplemented } from './shared.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Start a new agentflow run for one git repository.')
    .requiredOption('--repo <path>', 'Git repository path')
    .requiredOption('--task <file>', 'Task markdown file')
    .requiredOption('--config <file>', 'Agentflow config file')
    .action(() => failNotImplemented('run'));
}
