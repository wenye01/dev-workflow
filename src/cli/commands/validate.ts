import { readFile } from 'node:fs/promises';

import type { Command } from 'commander';

import { SchemaRegistry } from '../../schemas/registry.js';
import {
  SchemaValidationError,
  parseJsonObject,
} from '../../schemas/validator.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate an agentflow artifact.')
    .argument('<artifact>', 'Artifact file to validate')
    .option('--schema <schema_id>', 'Explicit schema id to validate against')
    .action(async (artifact: string, options: { schema?: string }) => {
      try {
        const registry = SchemaRegistry.load();
        const raw = await readFile(artifact, 'utf8');
        const value = parseJsonObject(raw);
        const schemaId = options.schema ?? registry.schemaIdForCanonical(value);

        registry.assertBySchemaId(schemaId, value);

        console.log(
          JSON.stringify(
            {
              status: 'valid',
              artifact,
              schema_id: schemaId,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        process.exitCode = 2;
        console.error(JSON.stringify(formatValidationError(error), null, 2));
      }
    });
}

function formatValidationError(error: unknown): Record<string, unknown> {
  if (error instanceof SchemaValidationError) {
    return {
      error: {
        code: error.code,
        classification: error.classification,
        schema_id: error.schemaId,
        message: error.message,
        errors: error.errors,
      },
    };
  }

  return {
    error: {
      code: 'AGENTFLOW_VALIDATE_FAILED',
      classification: 'validation_failed',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
