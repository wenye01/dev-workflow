import type { Command } from 'commander';

export function failNotImplemented(command: string): void {
  const payload = {
    error: {
      code: 'AGENTFLOW_NOT_IMPLEMENTED',
      message: `${command} is scaffolded for Milestone 1 but not implemented yet.`,
    },
  };

  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 2;
}

export function addJsonOutputNote(command: Command): Command {
  return command.addHelpText(
    'after',
    '\nOutputs machine-readable JSON for successful command execution.',
  );
}
