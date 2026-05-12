# agentflow

MVP-0 TypeScript CLI package for a single-repository agent workflow.

This package exposes the `agentflow` command. It does not expose a stable
TypeScript library API.

## Usage

```bash
agentflow --help
agentflow run --repo <path> --task <file>
agentflow project-index build --repo <path> [--out <path>] [--force]
agentflow project-index show --index-dir <path> --name <manifest|overview|documents|commands|modules|tree>
agentflow resume --run-id <run_id> --repo <path>
agentflow validate <artifact>
agentflow doctor [--repo <path>]
```

Configuration is loaded from built-in defaults, then
`~/.agentflow/settings.json`, then the project-local
`.agentflow/settings.json`. Project settings override global settings. Default
settings are not written to disk.

`agentflow run` currently initializes through the Milestone 8 Planner pipeline:
it builds or reuses Project Index artifacts, writes selected context, source
slices, Planner/Generator/Evaluator role inputs, and now materializes the
Planner Package, Acceptance Contract, Batch Schedule, run state, and unit
state. Generator runtime is not implemented yet.

## Development

```bash
nvm use
npm install
npm test
npm run test:context
npm run build
npm pack
```

## Cross-platform checks

GitHub Actions includes a `Cross Platform` workflow for Ubuntu, macOS, and
Windows. It only runs when manually triggered with `workflow_dispatch` or
externally triggered with `repository_dispatch` type `cross-platform-test`.
