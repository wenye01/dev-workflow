import type { RuntimeError, SchemaId } from "../contracts/index.js";
import type { SchemaRegistry, SchemaValidationOutcome } from "../ports/index.js";

export type SchemaValidator =
  | ((payload: unknown) => boolean | SchemaValidationOutcome)
  | ((payload: unknown) => Promise<boolean | SchemaValidationOutcome>);

export class InMemorySchemaRegistry implements SchemaRegistry {
  private readonly validators = new Map<SchemaId, SchemaValidator>();

  constructor(entries: Iterable<readonly [SchemaId, SchemaValidator]> = []) {
    for (const [schemaId, validator] of entries) {
      this.register(schemaId, validator);
    }
  }

  register(schemaId: SchemaId, validator: SchemaValidator): this {
    this.validators.set(schemaId, validator);
    return this;
  }

  async validate(input: { schema_id: SchemaId; payload: unknown }): Promise<SchemaValidationOutcome> {
    const validator = this.validators.get(input.schema_id);
    if (validator === undefined) {
      return {
        ok: false,
        error: {
          code: "SCHEMA_NOT_FOUND",
          message: `Schema not found: ${input.schema_id}.`
        }
      };
    }

    try {
      const result = await validator(input.payload);
      if (typeof result === "boolean") {
        return result ? { ok: true } : invalidPayload(input.schema_id);
      }

      return isSchemaValidationOutcome(result) ? result : invalidPayload(input.schema_id);
    } catch (error) {
      return invalidPayload(input.schema_id, error instanceof Error ? error.message : undefined);
    }
  }
}

function invalidPayload(schemaId: SchemaId, detail?: string): { ok: false; error: RuntimeError } {
  return {
    ok: false,
    error: {
      code: "SCHEMA_VALIDATION_FAILED",
      message: `Payload failed schema validation for ${schemaId}.`,
      ...(detail === undefined ? {} : { details: { reason: detail } })
    }
  };
}

function isSchemaValidationOutcome(value: unknown): value is SchemaValidationOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return true;
  }

  if (value.ok !== false || !("error" in value)) {
    return false;
  }

  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}
