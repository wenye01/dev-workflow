"""Agent output validation using external JSON Schema files."""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema

# Schemas directory: <project_root>/schemas/
_SCHEMAS_DIR = Path(__file__).resolve().parent.parent / "schemas"

# Cache loaded schemas to avoid repeated file I/O
_schema_cache: dict[str, dict] = {}


def _load_schema(schema_name: str) -> dict:
    """Load a JSON Schema from the schemas/ directory.

    Args:
        schema_name: Schema filename without extension (e.g. "review-output").

    Returns:
        Parsed JSON Schema as a dict.

    Raises:
        FileNotFoundError: If the schema file does not exist.
    """
    if schema_name in _schema_cache:
        return _schema_cache[schema_name]

    schema_path = _SCHEMAS_DIR / f"{schema_name}.json"
    if not schema_path.exists():
        raise FileNotFoundError(f"Schema file not found: {schema_path}")

    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    _schema_cache[schema_name] = schema
    return schema


def validate_agent_output(
    raw: dict | None,
    schema_name: str,
) -> tuple[dict | None, list[str]]:
    """Validate agent output against an external JSON Schema file.

    Args:
        raw: The parsed dict from agent stdout (may be None).
        schema_name: Schema filename without extension (e.g. "review-output").

    Returns:
        (validated_data, errors) — data is None when validation fails.
    """
    if raw is None:
        return None, ["Agent returned no structured output"]

    schema = _load_schema(schema_name)

    validator = jsonschema.Draft7Validator(schema)
    errors = sorted(validator.iter_errors(raw), key=lambda e: list(e.path))

    if errors:
        messages = []
        for err in errors:
            path = ".".join(str(p) for p in err.absolute_path) or "(root)"
            messages.append(f"{path}: {err.message}")
        return None, messages

    return raw, []


def get_schema_path(schema_name: str) -> Path:
    """Return the Path to a JSON Schema file in the schemas/ directory.

    Args:
        schema_name: Schema filename without extension (e.g. "review-output").

    Returns:
        Absolute Path to the schema file.

    Raises:
        FileNotFoundError: If the schema file does not exist.
    """
    schema_path = _SCHEMAS_DIR / f"{schema_name}.json"
    if not schema_path.exists():
        raise FileNotFoundError(f"Schema file not found: {schema_path}")
    return schema_path


def list_schemas() -> list[str]:
    """List available schema names in the schemas/ directory."""
    if not _SCHEMAS_DIR.exists():
        return []
    return [p.stem for p in _SCHEMAS_DIR.glob("*.json")]


def clear_cache() -> None:
    """Clear the schema file cache (useful for testing)."""
    _schema_cache.clear()
