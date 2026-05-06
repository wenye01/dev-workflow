"""Main workflow orchestrator entry point."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.config import WorkflowConfig, load_config
from scripts.engine import WorkflowEngine
from scripts.issue_tracker import close_validated_issues
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


def _resolve_project_path(project: str | None) -> Path:
    """Resolve the target project root for workflow state and config."""
    return Path(project).resolve() if project else Path.cwd()


def _resolve_config_path(project_path: Path, config: str | None) -> Path | None:
    """Prefer an explicit config path, otherwise use the target project's config file."""
    if config:
        return Path(config).resolve()
    return project_path / ".dev-workflow" / "config.yml"


def _get_run_root(project_path: Path) -> Path:
    """Get the workflow state root under the target project."""
    return project_path / ".dev-workflow" / "run"


def _run_workflow(engine: WorkflowEngine, config: WorkflowConfig, spec_path: Path) -> int:
    """Main execution loop: iterate through stages until workflow completes or fails."""
    instance = engine.instance
    instance.status = WorkflowStatus.RUNNING
    engine.persist()

    max_iterations = 50
    iteration = 0

    while instance.status not in (WorkflowStatus.COMPLETED, WorkflowStatus.FAILED):
        iteration += 1
        if iteration > max_iterations:
            logger.error("Workflow exceeded %d iterations, aborting.", max_iterations)
            instance.status = WorkflowStatus.FAILED
            engine.persist()
            break

        current_stage = instance.current_stage
        logger.info("=== Iteration %d: Stage %s ===", iteration, current_stage.value)

        stage = get_stage(current_stage)
        context = _build_stage_context(instance, spec_path, engine)
        stage_cfg = config.get_stage_config(current_stage.value)
        stage_config = StageConfig(
            timeout_seconds=stage_cfg.timeout,
            agent_backend=config.get_agent_for_stage(current_stage.value),
            agent_model=config.get_model_for_stage(current_stage.value),
        )

        validation = stage.validate_input(context)
        if not validation.is_valid:
            logger.warning("Stage %s input validation failed: %s", current_stage.value, validation.errors)
            engine.add_stage_execution(StageExecution(
                workflow_id=instance.id,
                stage_name=current_stage,
                status=StageStatus.FAILED,
                retry_attempt=engine.get_retry_count(current_stage.value),
            ))
            engine.set_verdict(Verdict.FAIL)
            _trigger_transition(engine, current_stage, Verdict.FAIL)
            engine.persist()
            continue

        context = context.model_copy(update={"agent_context": stage.build_agent_context(context)})

        logger.info("Executing stage: %s", current_stage.value)
        logger.info("  worktree_path: %s", context.worktree_path)
        logger.info("  retry_count: %d", context.retry_count)
        output = stage.execute(context, stage_config)
        verdict = output.verdict or Verdict.FAIL
        logger.info("Stage %s verdict: %s", current_stage.value, verdict.value)
        if output.error_message:
            logger.info("  error_message: %s", output.error_message)
        if output.output_data:
            logger.info("  output_data: %s", json.dumps(output.output_data, default=str)[:500])
        logger.info("  result_path: %s", output.result_path)

        execution = StageExecution(
            workflow_id=instance.id,
            stage_name=current_stage,
            status=StageStatus.COMPLETED if verdict == Verdict.PASS else StageStatus.FAILED,
            completed_at=datetime.now(),
            retry_attempt=engine.get_retry_count(current_stage.value),
        )
        if output.result_path:
            execution.agent_result_path = output.result_path
        engine.add_stage_execution(execution)

        output_validation = stage.validate_output(output, context.worktree_path)
        output_is_valid = output_validation.is_valid
        if not output_validation.is_valid:
            logger.error("Stage %s output validation failed: %s", current_stage.value, output_validation.errors)
            output.verdict = Verdict.FAIL
            verdict = Verdict.FAIL
            execution.status = StageStatus.FAILED

        if (
            output_is_valid
            and current_stage == StageName.REVIEW
            and verdict == Verdict.FAIL
            and _should_force_review_pass_after_loop_limit(instance, config)
        ):
            reason = _review_loop_limit_reason(instance, config)
            logger.warning("Forcing review pass because review loop limit was reached: %s", reason)
            output.verdict = Verdict.PASS
            output.output_data["forced_pass_reason"] = reason
            verdict = Verdict.PASS
            execution.status = StageStatus.COMPLETED

        if current_stage == StageName.BOOTSTRAP and verdict == Verdict.PASS:
            _update_worktree_path(instance, output)
        if current_stage == StageName.IMPLEMENT and verdict == Verdict.PASS:
            more_tasks = (output.output_data or {}).get("more_tasks", False)
            all_tasks_done = not more_tasks
            engine.set_tasks_complete(all_tasks_done)
            engine.set_skip_review_after_implement(
                all_tasks_done
                and _is_review_backed_implement(output)
                and _should_skip_review_after_review_fix(instance, config)
            )
        elif current_stage != StageName.IMPLEMENT:
            engine.set_skip_review_after_implement(False)

        engine.set_verdict(verdict)
        if current_stage == StageName.ADJUDICATE and verdict == Verdict.PASS:
            next_stage = (output.output_data or {}).get("next_stage")
            if next_stage:
                engine.set_adjudicate_target(StageName(next_stage))

        if current_stage in (StageName.REVIEW, StageName.WHITEBOX_TEST, StageName.BLACKBOX_TEST) and verdict == Verdict.PASS:
            state_dir = get_run_state_dir(instance.project_path, instance.run_id)
            close_validated_issues(state_dir / "issues.json", current_stage)

        if current_stage == StageName.FINISH and verdict == Verdict.PASS:
            pr_url = (output.output_data or {}).get("pr_url")
            if isinstance(pr_url, str) and pr_url.strip():
                instance.pr_url = pr_url.strip()

        if verdict == Verdict.FAIL:
            if _has_max_retries_trigger(current_stage) and engine.retries_exhausted(current_stage.value):
                logger.error("Stage %s exhausted retries (%d)", current_stage.value, instance.max_retries)
                _trigger_max_retries(engine, current_stage)
                engine.persist()
                break
            engine.increment_retry(current_stage.value)

        transitioned = _trigger_transition(engine, current_stage, verdict)

        if not transitioned and instance.status == WorkflowStatus.RUNNING:
            engine.persist()
            raise RuntimeError(
                f"State machine stuck: no transition matched for stage={current_stage.value} verdict={verdict.value}.",
            )

        engine.persist()

    result = {
        "workflow_id": instance.id,
        "run_id": instance.run_id,
        "status": instance.status.value,
        "current_stage": instance.current_stage.value,
        "worktree_path": str(instance.worktree_path) if instance.worktree_path else None,
    }
    print(json.dumps(result, indent=2))
    return 0 if instance.status == WorkflowStatus.COMPLETED else 1


def _build_stage_context(instance: WorkflowInstance, spec_path: Path, engine: WorkflowEngine) -> StageContext:
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


def _trigger_transition(engine: WorkflowEngine, stage: StageName, verdict: Verdict) -> bool:
    if stage == StageName.BOOTSTRAP:
        if verdict == Verdict.PASS:
            return bool(engine.start_workflow())
        return bool(engine.bootstrap_failed())
    elif stage == StageName.IMPLEMENT:
        if verdict == Verdict.FAIL:
            return bool(engine.implement_failed())
        return bool(engine.implement_complete())
    elif stage == StageName.REVIEW:
        return bool(engine.review_complete())
    elif stage == StageName.ADJUDICATE:
        if verdict == Verdict.FAIL:
            return bool(engine.adjudicate_failed())
        return bool(engine.adjudicate_complete())
    elif stage in (StageName.WHITEBOX_TEST, StageName.BLACKBOX_TEST):
        return bool(engine.test_complete())
    elif stage == StageName.FINISH:
        if verdict == Verdict.FAIL:
            return bool(engine.finish_failed())
        return bool(engine.finish_complete())
    return False


def _trigger_max_retries(engine: WorkflowEngine, stage: StageName) -> None:
    if stage == StageName.REVIEW:
        engine.review_max_retries()
    elif stage == StageName.WHITEBOX_TEST:
        engine.test_max_retries()
    elif stage == StageName.BLACKBOX_TEST:
        engine.test_max_retries()
    else:
        engine.instance.status = WorkflowStatus.FAILED


def _has_max_retries_trigger(stage: StageName) -> bool:
    return stage in (StageName.REVIEW, StageName.WHITEBOX_TEST, StageName.BLACKBOX_TEST)


def _is_review_backed_implement(output: StageOutput) -> bool:
    return (output.output_data or {}).get("source_stage") == StageName.REVIEW.value


def _should_skip_review_after_review_fix(
    instance: WorkflowInstance,
    config: WorkflowConfig,
) -> bool:
    failures = _review_failure_count(instance)
    if failures == 0:
        return False
    if not config.workflow.enable_followup_review_loops:
        return True
    return failures >= max(config.workflow.max_review_loops, 0)


def _should_force_review_pass_after_loop_limit(
    instance: WorkflowInstance,
    config: WorkflowConfig,
) -> bool:
    failures = _review_failure_count(instance)
    if not config.workflow.enable_followup_review_loops:
        return failures > 1
    return failures > max(config.workflow.max_review_loops, 0)


def _review_loop_limit_reason(instance: WorkflowInstance, config: WorkflowConfig) -> str:
    failures = _review_failure_count(instance)
    if not config.workflow.enable_followup_review_loops:
        return (
            "enable_followup_review_loops=false; only the first "
            "review->adjudicate->implement loop is allowed"
        )
    return f"review failure count {failures} exceeded max_review_loops={config.workflow.max_review_loops}"


def _review_failure_count(instance: WorkflowInstance) -> int:
    return sum(
        1
        for execution in instance.stage_executions
        if execution.stage_name == StageName.REVIEW and execution.status == StageStatus.FAILED
    )


def _update_worktree_path(instance: WorkflowInstance, output: StageOutput) -> None:
    if output.result_path and output.result_path.exists():
        try:
            data = json.loads(output.result_path.read_text(encoding="utf-8"))
            wt = data.get("worktree_path")
            if wt:
                instance.worktree_path = Path(wt)
                logger.info("Worktree path set: %s", wt)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("Could not read worktree path from bootstrap result: %s", exc)




def cmd_start(args: argparse.Namespace) -> int:
    spec_path = Path(args.spec).resolve()
    if not spec_path.exists():
        print(f"Error: spec file not found: {spec_path}", file=sys.stderr)
        return 1

    slug = args.slug
    if not slug:
        print("Error: --slug is required", file=sys.stderr)
        return 1

    project_path = _resolve_project_path(args.project)
    config_path = _resolve_config_path(project_path, args.config)
    config = load_config(config_path)

    spec_content = spec_path.read_text(encoding="utf-8")
    workflow_spec = WorkflowSpec(
        source_requirement=spec_content[:500],
        spec_path=spec_path,
        acceptance_criteria=[],
        tasks=[],
    )
    instance = WorkflowInstance(
        slug=slug,
        spec=workflow_spec,
        status=WorkflowStatus.PENDING,
        current_stage=StageName.BOOTSTRAP,
        project_path=project_path,
        worktree_path=None,
        max_retries=config.workflow.max_retries,
    )

    engine = WorkflowEngine(instance, config)
    engine.start()
    engine.persist()
    return _run_workflow(engine, config, spec_path)


def cmd_status(args: argparse.Namespace) -> int:
    project_path = _resolve_project_path(getattr(args, "project", None))
    run_dir = _get_run_root(project_path)
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
            status_icon = "OK" if ex.status == StageStatus.COMPLETED else ("XX" if ex.status == StageStatus.FAILED else "->")
            print(f"  {status_icon} {ex.stage_name.value} (attempt {ex.retry_attempt + 1})")

        progress_path = state_path.parent / "progress.json"
        if progress_path.exists():
            progress = ProgressArtifact.model_validate_json(progress_path.read_text(encoding="utf-8"))
            print("\nProgress:")
            print(f"  Completed tasks: {len(progress.completed_tasks)}")
            print(f"  Current task:    {progress.current_task or 'none'}")
            if progress.blocked_reason:
                print(f"  Blocked:         {progress.blocked_reason}")
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    from scripts.engine import restore_engine

    project_path = _resolve_project_path(getattr(args, "project", None))
    run_dir = _get_run_root(project_path)
    state_files = list(run_dir.glob("*/state.json"))
    if not state_files:
        print("No interrupted workflow found.", file=sys.stderr)
        return 1

    state_path = max(state_files, key=lambda p: p.stat().st_mtime)
    try:
        config = load_config(_resolve_config_path(project_path, getattr(args, "config", None)))
        engine = restore_engine(state_path, config)
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    instance = engine.instance
    spec_path = instance.spec.spec_path if instance.spec and instance.spec.spec_path else Path()
    if not spec_path.exists():
        candidates = list((project_path / ".dev-workflow").glob("*.md"))
        if candidates:
            spec_path = candidates[0]
        else:
            print("Error: Cannot find spec file for resume.", file=sys.stderr)
            return 1

    return _run_workflow(engine, config, spec_path)


def cmd_abort(args: argparse.Namespace) -> int:
    project_path = _resolve_project_path(getattr(args, "project", None))
    run_dir = _get_run_root(project_path)
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


def _setup_logging(verbose: bool, quiet: bool, log_file: str | None = None) -> None:
    level = logging.DEBUG if verbose else (logging.WARNING if quiet else logging.INFO)
    handlers: list[logging.Handler] = [logging.StreamHandler()]

    if log_file:
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S"))
        handlers.append(file_handler)

    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
        force=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(prog="orchestrator", description="Multi-agent development workflow orchestrator")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose logging")
    parser.add_argument("-q", "--quiet", action="store_true", help="Suppress non-error output")
    parser.add_argument("--log-file", default=None, help="Write debug log to file")

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    start_parser = subparsers.add_parser("start", help="Start a new workflow")
    start_parser.add_argument("--spec", required=True, help="Path to specification document")
    start_parser.add_argument("--slug", required=True, help="Human-readable slug for the workflow (kebab-case)")
    start_parser.add_argument("--project", default=None, help="Target project root path")
    start_parser.add_argument("--config", default=None, help="Configuration file path")

    status_parser = subparsers.add_parser("status", help="Show workflow status")
    status_parser.add_argument("--workflow-id", default=None, help="Specific workflow ID")
    status_parser.add_argument("--json", action="store_true", help="Output as JSON")
    status_parser.add_argument("--project", default=None, help="Target project root path")

    resume_parser = subparsers.add_parser("resume", help="Resume interrupted workflow")
    resume_parser.add_argument("--workflow-id", default=None, help="Specific workflow ID")
    resume_parser.add_argument("--project", default=None, help="Target project root path")
    resume_parser.add_argument("--config", default=None, help="Configuration file path")

    abort_parser = subparsers.add_parser("abort", help="Terminate running workflow")
    abort_parser.add_argument("--workflow-id", default=None, help="Specific workflow ID")
    abort_parser.add_argument("--force", action="store_true", help="Kill running agent process")
    abort_parser.add_argument("--project", default=None, help="Target project root path")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    _setup_logging(getattr(args, "verbose", False), getattr(args, "quiet", False), getattr(args, "log_file", None))

    commands = {
        "start": cmd_start,
        "status": cmd_status,
        "resume": cmd_resume,
        "abort": cmd_abort,
    }
    handler = commands.get(args.command)
    return handler(args) if handler else 1


if __name__ == "__main__":
    sys.exit(main())
