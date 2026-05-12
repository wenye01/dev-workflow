import type { Command } from 'commander';

import { Finalizer } from '../../reporting/finalizer.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .description('Resume an existing run by run id.')
    .requiredOption('--run-id <run_id>', 'Run id to resume')
    .requiredOption('--repo <path>', 'Git repository path')
    .action(
      async (options: {
        readonly runId: string;
        readonly repo: string;
      }) => {
        try {
          const result = await new Finalizer().resume({
            repoPath: options.repo,
            runId: options.runId,
          });
          if (result.status !== 'finalized') {
            process.exitCode = result.status === 'resume_ready' ? 0 : 2;
          }
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          process.exitCode = 2;
          console.error(
            JSON.stringify(
              {
                error: {
                  code: 'AGENTFLOW_RESUME_FAILED',
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              null,
              2,
            ),
          );
        }
      },
    );
}
