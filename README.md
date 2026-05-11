# agentflow

MVP-0 TypeScript CLI package for a single-repository agent workflow.

This package exposes the `agentflow` command. It does not expose a stable
TypeScript library API.

## Usage

```bash
agentflow --help
agentflow run --repo <path> --task <file> --config <file>
agentflow project-index build --repo <path> [--out <path>] [--config <file>] [--force]
agentflow project-index show --index-dir <path> --name <manifest|overview|documents|commands|modules|tree>
agentflow resume --run-id <run_id> --repo <path>
agentflow validate <artifact>
agentflow doctor --config <file>
```

`agentflow run` currently initializes through the Milestone 5 Context Builder:
it builds or reuses Project Index artifacts, writes selected context, source
slices, and Planner/Generator/Evaluator role inputs, then stops before Planner
runtime.

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
