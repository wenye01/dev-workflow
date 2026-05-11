# agentflow

MVP-0 TypeScript CLI package for a single-repository agent workflow.

This package exposes the `agentflow` command. It does not expose a stable
TypeScript library API.

## Usage

```bash
agentflow --help
agentflow run --repo <path> --task <file> --config <file>
agentflow resume --run-id <run_id> --repo <path>
agentflow validate <artifact>
agentflow doctor --config <file>
```

## Development

```bash
npm install
npm test
npm run build
npm pack
```
