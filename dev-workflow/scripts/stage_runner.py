"""Independent stage runner for testing and development."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Ensure repo root is on sys.path for sibling imports
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.config import load_config
from scripts.models import StageConfig, StageContext, StageName
from stages import get_stage, list_stages


def cmd_run(args: argparse.Namespace) -> int:
    """Run a single stage independently."""
    stage_name_str = args.stage_name
    worktree_path = Path(args.worktree).resolve()
    spec_path = Path(args.spec).resolve()
    config_path = Path(args.config).resolve() if args.config else None

    # Resolve stage name
    try:
        stage_name = StageName(stage_name_str)
    except ValueError:
        print(f"Error: Unknown stage '{stage_name_str}'.", file=sys.stderr)
        print(f"Available: {[s.value for s in StageName]}", file=sys.stderr)
        return 2

    # Load config
    config = load_config(config_path)
    stage_config_data = config.get_stage_config(stage_name_str)
    stage_config = StageConfig(
        timeout_seconds=stage_config_data.timeout,
        agent_backend=config.get_agent_for_stage(stage_name_str),
    )

    # Build context
    context = StageContext(
        workflow_id="standalone",
        run_id=args.run_id or "standalone",
        spec_path=spec_path,
        worktree_path=worktree_path,
        current_stage=stage_name,
    )

    # Get stage and execute
    stage = get_stage(stage_name)

    # Validate input
    validation = stage.validate_input(context)
    if not validation.is_valid:
        print("Validation errors:", file=sys.stderr)
        for err in validation.errors:
            print(f"  - {err}", file=sys.stderr)
        return 2

    # Execute
    output = stage.execute(context, stage_config)

    # Output result
    result = {
        "stage": output.stage_name.value,
        "verdict": output.verdict.value if output.verdict else None,
        "error": output.error_message,
        "artifacts": {k: str(v) for k, v in output.artifacts.items()},
    }
    print(json.dumps(result, indent=2))

    return 0 if output.verdict and output.verdict.value == "pass" else 1


def cmd_list(args: argparse.Namespace) -> int:
    """List all registered stages."""
    stages = list_stages()
    print("Registered stages:")
    for name, cls_name in stages:
        print(f"  {name:20s} → {cls_name}")
    return 0


def main() -> int:
    """Main entry point for the stage runner CLI."""
    parser = argparse.ArgumentParser(
        prog="stage_runner",
        description="Independent stage runner for development and testing",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("-q", "--quiet", action="store_true")

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # run
    run_parser = subparsers.add_parser("run", help="Run a single stage")
    run_parser.add_argument("stage_name", help="Stage to run (bootstrap, implement, review, etc.)")
    run_parser.add_argument("--worktree", required=True, help="Path to worktree")
    run_parser.add_argument("--spec", required=True, help="Path to specification")
    run_parser.add_argument("--run-id", default=None, dest="run_id", help="Run ID for state directory")
    run_parser.add_argument("--config", default=None, help="Configuration file path")

    # list
    subparsers.add_parser("list", help="List registered stages")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    commands = {
        "run": cmd_run,
        "list": cmd_list,
    }

    handler = commands.get(args.command)
    if handler:
        return handler(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
