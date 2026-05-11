import type { Command } from 'commander';

import { addJsonOutputNote, failNotImplemented } from './shared.js';

export function registerToolCommand(program: Command): void {
  const tool = program
    .command('tool')
    .description('Read-only tools intended for agent skill integrations.');

  addJsonOutputNote(tool);

  tool
    .command('state')
    .description('Read run state and optionally one unit state.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .option('--unit <unit_id>', 'Unit id')
    .action(() => failNotImplemented('tool state'));

  const artifact = tool
    .command('artifact')
    .description('Read artifact content or index.');

  artifact
    .command('get')
    .description('Read one artifact by ref.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .requiredOption('--ref <artifact_ref>', 'Artifact ref under .agentflow')
    .action(() => failNotImplemented('tool artifact get'));

  artifact
    .command('index')
    .description('Read the artifact index.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(() => failNotImplemented('tool artifact index'));

  const context = tool
    .command('context')
    .description('Read generated context artifacts.');

  context
    .command('get')
    .description('Read a named context artifact.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .requiredOption(
      '--name <name>',
      'Context name: repo-context, commands, or worktree-status',
    )
    .action(() => failNotImplemented('tool context get'));

  const roleCatalog = tool
    .command('role-catalog')
    .description('Inspect configured roles.');

  roleCatalog
    .command('list')
    .description('List role catalog entries.')
    .requiredOption('--config <file>', 'Agentflow config file')
    .action(() => failNotImplemented('tool role-catalog list'));

  const provider = tool
    .command('provider')
    .description('Inspect provider capabilities.');

  provider
    .command('capabilities')
    .description('List provider capabilities derived from config.')
    .requiredOption('--config <file>', 'Agentflow config file')
    .action(() => failNotImplemented('tool provider capabilities'));

  const worktree = tool
    .command('worktree')
    .description('Inspect the run worktree.');

  worktree
    .command('status')
    .description('Read worktree status.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(() => failNotImplemented('tool worktree status'));

  worktree
    .command('diff-summary')
    .description('Read a summary of worktree changes.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(() => failNotImplemented('tool worktree diff-summary'));
}
