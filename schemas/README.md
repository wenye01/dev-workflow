# Schemas

Milestone 2 defines two validation layers:

- `llm/*.schema.json` validates the JSON payloads produced by routers and roles.
- `artifacts/*.schema.json` validates canonical artifacts after the runtime adds
  run metadata, producer metadata, timestamps, refs, and commit refs.

Markdown views are generated from canonical JSON and are not used for process
state or routing decisions.
