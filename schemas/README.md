# Schemas

Milestone 2 defines two validation layers:

- `llm/*.schema.json` validates the JSON payloads produced by routers and roles.
- `artifacts/*.schema.json` validates canonical artifacts after the runtime adds
  run metadata, producer metadata, timestamps, refs, and commit refs.
- Project Index schemas validate the reusable project overview, command index,
  module index, document index, manifest, and build report consumed by Context
  Builder.

Markdown views are generated from canonical JSON and are not used for process
state or routing decisions.
