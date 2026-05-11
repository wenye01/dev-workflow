import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

export type SchemaValidationClassification =
  | 'invalid_json'
  | 'schema_not_found'
  | 'payload_schema_invalid'
  | 'project_index_schema_invalid'
  | 'canonical_schema_invalid';

export interface NormalizedSchemaError {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
  readonly schemaPath: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export class SchemaValidationError extends Error {
  readonly code: string;
  readonly classification: SchemaValidationClassification;
  readonly schemaId?: string;
  readonly errors: readonly NormalizedSchemaError[];

  constructor(options: {
    readonly classification: SchemaValidationClassification;
    readonly message: string;
    readonly schemaId?: string;
    readonly errors?: readonly NormalizedSchemaError[];
  }) {
    super(options.message);
    this.name = 'SchemaValidationError';
    this.code = `AGENTFLOW_${options.classification.toUpperCase()}`;
    this.classification = options.classification;
    this.schemaId = options.schemaId;
    this.errors = options.errors ?? [];
  }
}

export interface LoadedJsonSchema {
  readonly id: string;
  readonly filePath: string;
  readonly schema: Record<string, unknown>;
}

export class JsonSchemaValidator {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(schemas: readonly LoadedJsonSchema[]) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
    });

    for (const loadedSchema of schemas) {
      this.ajv.addSchema(loadedSchema.schema, loadedSchema.id);
    }

    for (const loadedSchema of schemas) {
      const validator = this.ajv.getSchema(loadedSchema.id);
      if (!validator) {
        throw new SchemaValidationError({
          classification: 'schema_not_found',
          schemaId: loadedSchema.id,
          message: `Schema could not be compiled: ${loadedSchema.id}`,
        });
      }
      this.validators.set(loadedSchema.id, validator);
    }
  }

  assertValid(
    schemaId: string,
    value: unknown,
    classification: Exclude<
      SchemaValidationClassification,
      'invalid_json' | 'schema_not_found'
    >,
  ): void {
    const validator = this.validators.get(schemaId);
    if (!validator) {
      throw new SchemaValidationError({
        classification: 'schema_not_found',
        schemaId,
        message: `Schema is not registered: ${schemaId}`,
      });
    }

    if (!validator(value)) {
      throw new SchemaValidationError({
        classification,
        schemaId,
        message: `Schema validation failed for ${schemaId}`,
        errors: normalizeAjvErrors(validator.errors ?? []),
      });
    }
  }

  schemaIds(): readonly string[] {
    return [...this.validators.keys()].sort();
  }
}

export function parseJsonObject(source: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SchemaValidationError({
      classification: 'invalid_json',
      message:
        error instanceof Error
          ? `Invalid JSON: ${error.message}`
          : 'Invalid JSON input.',
    });
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new SchemaValidationError({
      classification: 'invalid_json',
      message: 'Artifact JSON must be a single object.',
    });
  }

  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAjvErrors(
  errors: readonly ErrorObject[],
): readonly NormalizedSchemaError[] {
  return errors.map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'Schema validation failed.',
    schemaPath: error.schemaPath,
    params: error.params as Readonly<Record<string, unknown>>,
  }));
}
