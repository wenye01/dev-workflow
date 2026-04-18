"""Main workflow orchestrator entry point."""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from datetime import datetime
from pathlib import Path

# Ensure repo root is on sys.path for sibling imports
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.config import WorkflowConfig, load_config
from scripts.engine import WorkflowEngine
from scripts.models import (
    ProgressArtifact,
    StageConfig,
    StageContext,
    StageExecution,
    StageName,
    StageOutput,
    StageStatus,
    Verdict,
    WorkflowInstance,
    WorkflowSpec,
    WorkflowStatus,
    get_run_state_dir,
)
from stages import get_stage

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Execution loop — the core missing piece
# ---------------------------------------------------------------------------


def _run_workflow(
    engine: WorkflowEngine,
    config: WorkflowConfig,
    spec_path: Path,
) -> int:
    """Main execution loop: iterate through stages until workflow completes or fails."""
    instance = engine.instance
    instance.status = WorkflowStatus.RUNNING
    engine.persist()

    max_iterations = 50  # Safety limit against infinite loops
    iteration = 0

    while instance.status not in (WorkflowStatus.COMPLETED, WorkflowStatus.FAILED):
        iteration += 1
        if iteration > max_iterations:
            logger.error("Workflow exceeded %d iterations — aborting.", max_iterations)
            instance.status = WorkflowStatus.FAILED
            engine.persist()
            break

        current_stage = instance.current_stage
        logger.info("=== Iteration %d: Stage %s ===", iteration, current_stage.value)

        # --- Instantiate stage ---
        stage = get_stage(current_stage)

        # --- Build context ---
        context = _build_stage_context(instance, spec_path, engine)

        # --- Per-stage config ---
        stage_cfg = config.get_stage_config(current_stage.value)
        stage_config = StageConfig(
            timeout_seconds=stage_cfg.timeout,
            agent_backend=config.get_agent_for_stage(current_stage.value),
        )

        # --- Validate input ---
        validation = stage.validate_input(context)
        if not validation.is_valid:
            logger.warning(
                "Stage %s input validation failed: %s", current_stage.value, validation.errors,
            )
            engine.add_stage_execution(StageExecution(
                workflow_id=instance.id,
                stage_name=current_stage,
                status=StageStatus.FAILED,
            ))
            engine.set_verdict(Verdict.FAIL)
            _trigger_transition(engine, current_stage, Verdict.FAIL)
            engine.persist()
            continue

        # --- Execute ---
        logger.info("Executing stage: %s", current_stage.value)
        output = stage.execute(context, stage_config)
        verdict = output.verdict or Verdict.FAIL
        logger.info("Stage %s verdict: %s", current_stage.value, verdict.value)

        # Record execution
        engine.add_stage_execution(StageExecution(
            workflow_id=instance.id,
            stage_name=current_stage,
            status=StageStatus.COMPLETED if verdict == Verdict.PASS else StageStatus.FAILED,
            completed_at=datetime.now(),
        ))

        # --- Post-execution hooks per stage ---
        if current_stage == StageName.BOOTSTRAP and verdict == Verdict.PASS:
            _update_worktree_path(instance, output)
            state_dir = get_run_state_dir(instance.project_path, instance.run_id)
            _generate_tasks_from_spec(spec_path, state_dir)

        if current_stage == StageName.IMPLEMENT:
            more_tasks = (output.output_data or {}).get("more_tasks", False)
            engine.set_tasks_complete(not more_tasks)

        # Extract issue category for review routing
        issue_category = None
        if current_stage == StageName.REVIEW and verdict == Verdict.FAIL:
            issue_category = _extract_review_category(output)

        # Set verdict on engine (drives conditional transitions)
        engine.set_verdict(verdict, issue_category)

        # --- Retry handling ---
        if verdict == Verdict.FAIL:
            if _has_max_retries_trigger(current_stage) and engine.retries_exhausted(
                current_stage.value,
            ):
                logger.error(
                    "Stage %s exhausted retries (%d)", current_stage.value, instance.max_retries,
                )
                _trigger_max_retries(engine, current_stage)
                engine.persist()
                break
            engine.increment_retry(current_stage.value)

        # --- Trigger state transition ---
        prev_stage = current_stage
        _trigger_transition(engine, current_stage, verdict)

        # When routing back to implement from review/test, inject fix tasks
        if (
            verdict == Verdict.FAIL
            and prev_stage in (StageName.REVIEW, StageName.WHITEBOX_TEST, StageName.BLACKBOX_TEST)
            and instance.current_stage == StageName.IMPLEMENT
        ):
            _inject_fix_tasks(instance, output)

        engine.persist()

    # --- Final output ---
    result = {
        "workflow_id": instance.id,
        "run_id": instance.run_id,
        "status": instance.status.value,
        "current_stage": instance.current_stage.value,
        "worktree_path": str(instance.worktree_path) if instance.worktree_path else None,
    }
    print(json.dumps(result, indent=2))
    return 0 if instance.status == WorkflowStatus.COMPLETED else 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_stage_context(
    instance: WorkflowInstance,
    spec_path: Path,
    engine: WorkflowEngine,
) -> StageContext:
    """Build StageContext for the current stage from instance + engine state."""
    return StageContext(
        workflow_id=instance.id,
        run_id=instance.run_id,
        spec_path=spec_path,
        project_path=instance.project_path or Path.cwd(),
        worktree_path=instance.worktree_path or Path.cwd(),
        current_stage=instance.current_stage,
        retry_count=engine.get_retry_count(instance.current_stage.value),
        stage_history=instance.stage_executions,
    )


def _trigger_transition(engine: WorkflowEngine, stage: StageName, verdict: Verdict) -> None:
    """Trigger the correct state machine transition after a stage completes."""
    if stage == StageName.BOOTSTRAP:
        if verdict == Verdict.PASS:
            engine.start_workflow()
        else:
            engine.bootstrap_failed()
    elif stage == StageName.IMPLEMENT:
        engine.implement_complete()
    elif stage == StageName.REVIEW:
        engine.review_complete()
    elif stage in (StageName.WHITEBOX_TEST, StageName.BLACKBOX_TEST):
        engine.test_complete()
    elif stage == StageName.FINISH:
        engine.finish_complete()


def _trigger_max_retries(engine: WorkflowEngine, stage: StageName) -> None:
    """Trigger max-retries transition for stages that support it."""
    if stage == StageName.REVIEW:
        engine.review_max_retries()
    elif stage == StageName.WHITEBOX_TEST:
        engine.test_max_retries()
    elif stage == StageName.BLACKBOX_TEST:
        engine.test_max_retries()
    else:
        # No dedicated trigger — force failure on the instance directly
        engine.instance.status = WorkflowStatus.FAILED


def _has_max_retries_trigger(stage: StageName) -> bool:
    """Check whether a stage has a dedicated max-retries transition."""
    return stage in (StageName.REVIEW, StageName.WHITEBOX_TEST, StageName.BLACKBOX_TEST)


def _update_worktree_path(instance: WorkflowInstance, output: StageOutput) -> None:
    """Propagate worktree_path from bootstrap result to the live instance."""
    if output.result_path and output.result_path.exists():
        try:
            data = json.loads(output.result_path.read_text(encoding="utf-8"))
            wt = data.get("worktree_path")
            if wt:
                instance.worktree_path = Path(wt)
                logger.info("Worktree path set: %s", wt)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("Could not read worktree path from bootstrap result: %s", exc)


def _extract_review_category(output: StageOutput) -> str:
    """Extract the primary issue category from review-result for state routing."""
    if output.result_path and output.result_path.exists():
        try:
            data = json.loads(output.result_path.read_text(encoding="utf-8"))
            issues = data.get("issues", [])
            if issues:
                return issues[0].get("category", "code_quality")
        except (json.JSONDecodeError, ValueError):
            pass
    return "code_quality"


def _inject_fix_tasks(instance: WorkflowInstance, output: StageOutput) -> None:
    """Inject fix tasks from review/test feedback so implement has work to do."""
    state_dir = get_run_state_dir(instance.project_path, instance.run_id)
    tasks_path = state_dir / "tasks.json"
    if not tasks_path.exists():
        return

    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))

    # Already have pending tasks? Nothing to inject.
    if any(t.get("status") == "pending" for t in tasks):
        return

    # Build fix task description from feedback issues
    fix_lines: list[str] = []
    if output.result_path and output.result_path.exists():
        try:
            data = json.loads(output.result_path.read_text(encoding="utf-8"))
            for issue in data.get("issues", []):
                desc = issue.get("description", "Unknown issue")
                loc = issue.get("location", "")
                fix_lines.append(f"- {desc}" + (f" ({loc})" if loc else ""))
        except (json.JSONDecodeError, ValueError):
            pass

    if not fix_lines:
        fix_lines = ["Fix issues identified in review/test feedback"]

    fix_task = {
        "id": f"fix-{len(tasks) + 1}",
        "title": "Fix review/test feedback",
        "description": "Address the following issues:\n" + "\n".join(fix_lines),
        "status": "pending",
        "priority": len(tasks),
    }
    tasks.append(fix_task)
    tasks_path.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info("Injected fix task: %s", fix_task["id"])


def _generate_tasks_from_spec(spec_path: Path, state_dir: Path) -> list[dict]:
    """Parse spec file and write tasks.json so the implement stage can find work."""
    content = spec_path.read_text(encoding="utf-8")
    tasks: list[dict] = []

    # 1. Markdown checkbox items: - [ ] Title
    checkbox = re.compile(r"^[\-\*]\s+\[[ xX]\]\s+(.+)$", re.MULTILINE)
    matches = checkbox.findall(content)
    if matches:
        for i, title in enumerate(matches):
            tasks.append({
                "id": f"task-{i + 1}",
                "title": title.strip(),
                "description": title.strip(),
                "status": "pending",
                "priority": i,
            })

    # 2. Numbered items under a ## Tasks heading
    if not tasks:
        in_tasks = False
        for line in content.split("\n"):
            if re.match(r"^##\s+(Tasks|Task\s+List)", line, re.IGNORECASE):
                in_tasks = True
                continue
            if in_tasks and re.match(r"^##\s", line):
                break
            if in_tasks:
                m = re.match(r"^(\d+)\.\s+(.+)$", line)
                if m:
                    tasks.append({
                        "id": f"task-{len(tasks) + 1}",
                        "title": m.group(2).strip(),
                        "description": m.group(2).strip(),
                        "status": "pending",
                        "priority": len(tasks),
                    })

    # 3. Fallback: single task from the whole spec
    if not tasks:
        summary = content.strip().split("\n")[0][:100]
        tasks.append({
            "id": "task-1",
            "title": f"Implement per specification: {summary}",
            "description": content,
            "status": "pending",
            "priority": 0,
        })

    state_dir.mkdir(parents=True, exist_ok=True)
    tasks_path = state_dir / "tasks.json"
    tasks_path.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info("Generated %d tasks from spec → %s", len(tasks), tasks_path)
    return tasks


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------


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
    config_path = Path(args.config).resolve() if args.config else None

    # Load configuration
    config = load_config(config_path)

    # Read spec content
    spec_content = spec_path.read_text(encoding="utf-8")

    # Create workflow spec
    workflow_spec = WorkflowSpec(
        source_requirement=spec_content[:500],
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

    # Run the execution loop
    return _run_workflow(engine, config, spec_path)


def cmd_status(args: argparse.Namespace) -> int:
    """Display current workflow status."""
    run_dir = Path.cwd() / ".dev-workflow" / "run"
    if args.workflow_id:
        state_files = list(run_dir.glob(f"{args.workflow_id}/state.json"))
        if not state_files:
            state_files = list(run_dir.glob(f"{args.workflow_id[:8]}*/state.json"))
    else:
        state_files = list(run_dir.glob("*/state.json"))

    if not state_files:
        print("No workflow found.", file=sys.stderr)
        return 1

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
                status_icon = "OK"
            elif ex.status == StageStatus.FAILED:
                status_icon = "XX"
            else:
                status_icon = "->"
            print(f"  {status_icon} {ex.stage_name.value} (attempt {ex.retry_attempt + 1})")

        progress_path = state_path.parent / "progress.json"
        if progress_path.exists():
            progress = ProgressArtifact.model_validate_json(
                progress_path.read_text(encoding="utf-8"),
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

    # Determine spec path
    spec_path = instance.spec.spec_path if instance.spec and instance.spec.spec_path else Path()
    if not spec_path.exists():
        candidates = list((Path.cwd() / ".dev-workflow").glob("*.md"))
        if candidates:
            spec_path = candidates[0]
        else:
            print("Error: Cannot find spec file for resume.", file=sys.stderr)
            return 1

    # Run the execution loop
    return _run_workflow(engine, config, spec_path)


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


def _setup_logging(verbose: bool, quiet: bool) -> None:
    """Configure logging based on CLI flags."""
    level = logging.DEBUG if verbose else (logging.WARNING if quiet else logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


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
    start_parser.add_argument(
        "--slug", required=True,
        help="Human-readable slug for the workflow (kebab-case)",
    )
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

    _setup_logging(getattr(args, "verbose", False), getattr(args, "quiet", False))

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
