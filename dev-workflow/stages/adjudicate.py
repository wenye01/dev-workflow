"""Adjudication stage: decide whether findings require implementation work."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from agents import get_agent_backend
from scripts.issue_tracker import (
    ensure_issue_task,
    load_tracked_issues,
    mark_issues_status,
    sync_feedback_issues,
)
from scripts.models import (
    AgentContext,
    IssueStatus,
    ReviewFeedback,
    StageConfig,
    StageContext,
    StageName,
    StageOutput,
    TrackedIssue,
    ValidationResult,
    Verdict,
    get_run_state_dir,
)
from scripts.output_schema import get_schema_path, validate_agent_output
from stages.base import BaseStage

logger = logging.getLogger(__name__)


class AdjudicateStage(BaseStage):
    """Resolve whether reported issues should become implementation tasks."""

    @property
    def name(self) -> StageName:
        return StageName.ADJUDICATE

    def validate_input(self, context: StageContext) -> ValidationResult:
        errors = []
        if not context.worktree_path.exists():
            errors.append(f"Worktree not found: {context.worktree_path}")
        if not context.spec_path.exists():
            errors.append(f"Spec file not found: {context.spec_path}")
        source = self._latest_failed_stage_execution(context)
        if source is None or source.agent_result_path is None or not source.agent_result_path.exists():
            errors.append("No failed stage artifact found for adjudication")
        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def build_agent_context(self, context: StageContext) -> AgentContext:
        ctx = AgentContext(
            stage_name=self.name,
            project_context={
                "spec_path": str(context.spec_path),
                "worktree_path": str(context.worktree_path),
            },
        )
        if context.spec_path.exists():
            ctx.spec_content = context.spec_path.read_text(encoding="utf-8")
        return ctx

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        source_execution = self._latest_failed_stage_execution(context)
        if source_execution is None or source_execution.agent_result_path is None:
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message="No failed source stage available for adjudication",
            )

        feedback = self._load_feedback(source_execution.agent_result_path)
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        issues_path = state_dir / "issues.json"
        tasks_path = state_dir / "tasks.json"

        tracked = sync_feedback_issues(issues_path, source_execution.stage_name, feedback)
        prompt = self._build_prompt(context, source_execution.stage_name, tracked)

        try:
            result = self._invoke_agent(prompt, context, config)
        except Exception as exc:
            logger.error("Adjudication agent FAILED: %s", exc)
            return StageOutput(stage_name=self.name, verdict=Verdict.FAIL, error_message=str(exc))

        parsed, errors = validate_agent_output(result, "adjudicate-output")
        if parsed is None:
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message="Adjudication output validation failed: " + "; ".join(errors),
            )

        tracked_by_id = {issue.id: issue for issue in load_tracked_issues(issues_path)}
        actionable_task_ids: list[str] = []
        closed_issue_ids: list[str] = []

        for decision in parsed.get("decisions", []):
            issue_id = decision["issue_id"]
            tracked_issue = tracked_by_id.get(issue_id)
            if tracked_issue is None:
                continue
            action = decision["action"]
            rationale = decision.get("rationale", "")
            if action == "implement":
                task_id = ensure_issue_task(
                    tasks_path,
                    tracked_issue,
                    f"Fix {tracked_issue.source_stage.value} issue",
                    tracked_issue.description,
                )
                actionable_task_ids.append(task_id)
                mark_issues_status(
                    issues_path,
                    [issue_id],
                    IssueStatus.ACCEPTED,
                    resolution_notes=rationale,
                    task_id=task_id,
                )
            else:
                closed_issue_ids.append(issue_id)
                mark_issues_status(
                    issues_path,
                    [issue_id],
                    IssueStatus.REJECTED,
                    resolution_notes=rationale or "Closed during adjudication",
                )

        next_stage = self._next_stage_for_source(
            source_execution.stage_name,
            bool(actionable_task_ids),
        )
        summary = parsed.get("summary", "")
        return StageOutput(
            stage_name=self.name,
            verdict=Verdict.PASS,
            output_data={
                "next_stage": next_stage.value,
                "source_stage": source_execution.stage_name.value,
                "actionable_task_ids": actionable_task_ids,
                "closed_issue_ids": closed_issue_ids,
                "summary": summary,
            },
        )

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        next_stage = (output.output_data or {}).get("next_stage")
        if not next_stage:
            return ValidationResult(is_valid=False, errors=["adjudication missing next_stage"])
        return ValidationResult(is_valid=True, errors=[])

    def _build_prompt(
        self,
        context: StageContext,
        source_stage: StageName,
        tracked_issues: list[TrackedIssue],
    ) -> str:
        from context.builder import load_project_context, render_template

        project_ctx = load_project_context(context.worktree_path)
        agent_ctx = context.agent_context or self.build_agent_context(context)
        spec_text = agent_ctx.spec_content
        issues_text = "\n".join([
            (
                f"- issue_id={issue.id}\n"
                f"  severity={issue.severity.value}\n"
                f"  category={issue.category}\n"
                f"  location={issue.location}\n"
                f"  description={issue.description}\n"
                f"  suggested_fix={issue.suggested_fix}"
            )
            for issue in tracked_issues
        ])

        return render_template(self.name, {
            **project_ctx,
            "spec_content": spec_text,
            "source_stage": source_stage.value,
            "issues_text": issues_text,
            "feedback": "",
        })

    def _invoke_agent(self, prompt: str, context: StageContext, config: StageConfig) -> dict:
        backend = get_agent_backend(config.agent_backend)
        schema_path = get_schema_path("adjudicate-output")
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        debug_log_dir = state_dir / "agent-logs" / f"adjudicate-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        result = backend.invoke(
            prompt=prompt,
            working_dir=context.worktree_path,
            timeout=config.timeout_seconds,
            output_schema=schema_path,
            debug_log_dir=debug_log_dir,
        )
        if result.timed_out:
            raise TimeoutError(f"Adjudication agent timed out after {config.timeout_seconds}s")
        if result.exit_code != 0:
            raise RuntimeError(f"Agent invocation failed (exit_code={result.exit_code}): {result.stderr}")
        return result.parsed_output or {}

    def _load_feedback(self, path: Path) -> ReviewFeedback:
        return ReviewFeedback.model_validate_json(path.read_text(encoding="utf-8"))

    def _latest_failed_stage_execution(self, context: StageContext):
        for execution in reversed(context.stage_history):
            if execution.stage_name == StageName.ADJUDICATE:
                continue
            if execution.status.value == "failed":
                return execution
        return None

    def _next_stage_for_source(self, source_stage: StageName, has_actionable_tasks: bool) -> StageName:
        if has_actionable_tasks:
            return StageName.IMPLEMENT
        if source_stage == StageName.REVIEW:
            return StageName.WHITEBOX_TEST
        if source_stage == StageName.WHITEBOX_TEST:
            return StageName.BLACKBOX_TEST
        if source_stage == StageName.BLACKBOX_TEST:
            return StageName.FINISH
        return StageName.IMPLEMENT
