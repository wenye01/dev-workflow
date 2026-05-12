import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/cli/index.js';

describe('agentflow CLI', () => {
  it('provides top-level help with MVP-0 commands', () => {
    const help = createProgram().helpInformation();

    expect(help).toContain('Usage: agentflow [options] [command]');
    expect(help).toContain('run');
    expect(help).toContain('project-index');
    expect(help).toContain('resume');
    expect(help).toContain('validate');
    expect(help).toContain('doctor');
    expect(help).toContain('tool');
  });

  it('configures run command required options', () => {
    const run = createProgram().commands.find(
      (command) => command.name() === 'run',
    );

    expect(
      run?.options
        .filter((option) => option.mandatory)
        .map((option) => option.long),
    ).toEqual(['--repo', '--task']);
    expect(run?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        '--repo',
        '--task',
        '--project-index-dir',
        '--force-project-index',
        '--run-id',
      ]),
    );
  });
});
