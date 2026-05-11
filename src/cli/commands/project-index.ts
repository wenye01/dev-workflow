import type { Command } from 'commander';

import { addJsonOutputNote, failNotImplemented } from './shared.js';

export function registerProjectIndexCommand(program: Command): void {
  const projectIndex = program
    .command('project-index')
    .description(
      'Build and inspect reusable project overview and document index artifacts.',
    );

  addJsonOutputNote(projectIndex);

  projectIndex
    .command('build')
    .description(
      'Build a project overview, command index, module index, and document index.',
    )
    .requiredOption('--repo <path>', 'Git repository to scan')
    .option(
      '--out <path>',
      'Directory for generated project index artifacts',
      '.agentflow/project-index',
    )
    .option('--config <file>', 'Agentflow config file')
    .option('--force', 'Rebuild even when the existing index appears fresh')
    .action(() => failNotImplemented('project-index build'));

  projectIndex
    .command('show')
    .description('Read one generated project index artifact.')
    .requiredOption('--index-dir <path>', 'Project index directory')
    .requiredOption(
      '--name <name>',
      'Artifact name: manifest, overview, documents, commands, modules, or tree',
    )
    .action(() => failNotImplemented('project-index show'));
}
