"""Main workflow orchestrator entry point."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Ensure repo root is on sys.path for sibling imports
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.config import load_config
from scripts.engine import WorkflowEngine
from scripts.models import (
    ProgressArtifact,
    StageName,
    StageStatus,
    WorkflowInstance,
    WorkflowSpec,
    WorkflowStatus,
)


def cmd_start(args: argparse.Namespace) -> int:
    """Start a new development workflow from a specification."""
    spec_path = Path(args.spec).resolve()
    if not spec_path.exists():
        print(f"Error: spec file not found: {spec_path}", file=sys.stderr)
        return 1

    slug = args.slug
    if not slug:
        print("Error: --slug is required", file=sys.stderr)
        return 1

    project_path = Path(args.project).resolve() if args.project else Path.cwd()
    _ = project_path  # Used implicitly by workflow
    config_path = Path(args.config).resolve() if args.config else None

    # Load configuration
    config = load_config(config_path)

    # Read spec content
    spec_content = spec_path.read_text(encoding="utf-8")

    # Create workflow spec
    workflow_spec = WorkflowSpec(
        source_requirement=spec_content[:500],  # First 500 chars as summary
        spec_path=spec_path,
        acceptance_criteria=[],
        tasks=[],
    )

    # Create workflow instance
    instance = WorkflowInstance(
        slug=slug,
        spec=workflow_spec,
        status=WorkflowStatus.PENDING,
        current_stage=StageName.BOOTSTRAP,
        project_path=project_path,
        worktree_path=None,
        max_retries=config.workflow.max_retries,
    )

    # Create engine and persist initial state
    engine = WorkflowEngine(instance, config)
    engine.start()
    engine.persist()

    # Output result
    result = {
        "workflow_id": instance.id,
        "run_id": instance.run_id,
        "worktree_path": str(instance.worktree_path) if instance.worktree_path else None,
        "status": instance.status.value,
    }
    print(json.dumps(result, indent=2))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Display current workflow status."""
    # Find state file in .dev-workflow/run/{run_id}/state.json
    run_dir = Path.cwd() / ".dev-workflow" / "run"
    if args.workflow_id:
        # Try as run_id first, then as UUID prefix
        state_files = list(run_dir.glob(f"{args.workflow_id}/state.json"))
        if not state_files:
            state_files = list(run_dir.glob(f"{args.workflow_id[:8]}*/state.json"))
    else:
        state_files = list(run_dir.glob("*/state.json"))

    if not state_files:
        print("No workflow found.", file=sys.stderr)
        return 1

    # Use the most recent state file
    state_path = max(state_files, key=lambda p: p.stat().st_mtime)
    instance = WorkflowInstance.model_validate_json(state_path.read_text(encoding="utf-8"))

    if args.json:
        print(instance.model_dump_json(indent=2))
    else:
        print(f"Run ID:      {instance.run_id}")
        print(f"Workflow ID: {instance.id}")
        print(f"Status:      {instance.status.value}")
        print(f"Stage:       {instance.current_stage.value}")
        print(f"Created:     {instance.created_at}")
        print(f"Updated:     {instance.updated_at}")
        print("\nStage History:")
        for ex in instance.stage_executions:
            if ex.status == StageStatus.COMPLETED:
                status_icon = "✓"
            elif ex.status == StageStatus.FAILED:
                status_icon = "✗"
            else:
                status_icon = "→"
            print(f"  {status_icon} {ex.stage_name.value} (attempt {ex.retry_attempt + 1})")

        # Check for progress
        progress_path = state_path.parent / "progress.json"
        if progress_path.exists():
            progress = ProgressArtifact.model_validate_json(
                progress_path.read_text(encoding="utf-8")
            )
            print("\nProgress:")
            print(f"  Completed tasks: {len(progress.completed_tasks)}")
            print(f"  Current task:    {progress.current_task or 'none'}")
            if progress.blocked_reason:
                print(f"  Blocked:         {progress.blocked_reason}")

    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    """Resume an interrupted workflow."""
    from scripts.engine import restore_engine

    # Find state file in .dev-workflow/run/{id}/state.json
    run_dir = Path.cwd() / ".dev-workflow" / "run"
    state_files = list(run_dir.glob("*/state.json"))

    if not state_files:
        print("No interrupted workflow found.", file=sys.stderr)
        return 1

    state_path = max(state_files, key=lambda p: p.stat().st_mtime)

    try:
        config = load_config()
        engine = restore_engine(state_path, config)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    instance = engine.instance
    result = {
        "workflow_id": instance.id,
        "run_id": instance.run_id,
        "status": instance.status.value,
        "current_stage": instance.current_stage.value,
        "worktree_path": str(instance.worktree_path) if instance.worktree_path else None,
    }
    print(json.dumps(result, indent=2))
    return 0


def cmd_abort(args: argparse.Namespace) -> int:
    """Terminate a running workflow."""
    run_dir = Path.cwd() / ".dev-workflow" / "run"
    state_files = list(run_dir.glob("*/state.json"))

    if not state_files:
        print("No running workflow found.", file=sys.stderr)
        return 1

    state_path = max(state_files, key=lambda p: p.stat().st_mtime)

    instance = WorkflowInstance.model_validate_json(state_path.read_text(encoding="utf-8"))
    instance.status = WorkflowStatus.FAILED
    instance.updated_at = datetime.now()

    state_path.write_text(instance.model_dump_json(indent=2), encoding="utf-8")

    print(json.dumps({
        "workflow_id": instance.id,
        "run_id": instance.run_id,
        "status": "aborted",
        "worktree_path": str(instance.worktree_path) if instance.worktree_path else None,
    }, indent=2))
    return 0


def main() -> int:
    """Main entry point for the orchestrator CLI."""
    parser = argparse.ArgumentParser(
        prog="orchestrator",
        description="Multi-agent development workflow orchestrator",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose logging")
    parser.add_argument("-q", "--quiet", action="store_true", help="Suppress non-error output")

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # start
    start_parser = subparsers.add_parser("start", help="Start a new workflow")
    start_parser.add_argument("--spec", required=True, help="Path to specification document")
    start_parser.add_argument("--slug", required=True, help="Human-readable slug for the workflow (kebab-case)")
    start_parser.add_argument("--project", default=None, help="Target project root path")
    start_parser.add_argument("--config", default=None, help="Configuration file path")

    # status
    status_parser = subparsers.add_parser("status", help="Show workflow status")
    status_parser.add_argument("--workflow-id", default=None, help="Specific workflow ID")
    status_parser.add_argument("--json", action="store_true", help="Output as JSON")

    # resume
    resume_parser = subparsers.add_parser("resume", help="Resume interrupted workflow")
    resume_parser.add_argument("--workflow-id", default=None, help="Specific workflow ID")

    # abort
    abort_parser = subparsers.add_parser("abort", help="Terminate running workflow")
    abort_parser.add_argument("--workflow-id", default=None, help="Specific workflow ID")
    abort_parser.add_argument("--force", action="store_true", help="Kill running agent process")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    commands = {
        "start": cmd_start,
        "status": cmd_status,
        "resume": cmd_resume,
        "abort": cmd_abort,
    }

    handler = commands.get(args.command)
    if handler:
        return handler(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
