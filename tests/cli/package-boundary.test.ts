import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageJson {
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string>;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
}

async function readPackageJson(): Promise<PackageJson> {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  return JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageJson;
}

describe('package boundary', () => {
  it('exposes the CLI bin', async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.bin).toEqual({
      agentflow: './dist/cli/index.js',
    });
  });

  it('does not expose a public library API', async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.exports).toEqual({});
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.module).toBeUndefined();
    expect(packageJson.types).toBeUndefined();
  });
});
