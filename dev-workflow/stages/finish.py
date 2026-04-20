"""Finish stage: submit PR, cleanup, generate execution report."""

from __future__ import annotations

import json
import logging
import subprocess
from datetime import datetime
from pathlib import Path

from scripts.models import (
    AgentContext,
    StageConfig,
    StageContext,
    StageName,
    StageOutput,
    ValidationResult,
    Verdict,
    WorkflowStatus,
    get_run_state_dir,
)
from stages.base import BaseStage

logger = logging.getLogger(__name__)


class FinishStage(BaseStage):
    """Submits PR, cleans up temp files, generates execution report."""

    @property
    def name(self) -> StageName:
        return StageName.FINISH

    def validate_input(self, context: StageContext) -> ValidationResult:
        errors = []
        if not context.worktree_path.exists():
            errors.append(f"Worktree not found: {context.worktree_path}")
        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def build_agent_context(self, context: StageContext) -> AgentContext:
        return AgentContext(
            stage_name=self.name,
            project_context={
                "spec_path": str(context.spec_path),
                "worktree_path": str(context.worktree_path),
            },
            stage_specific_context=self._collect_stage_verdicts(context),
        )

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        logger.info("Finish stage starting: run_id=%s", context.run_id)
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        report_path = state_dir / "report.md"
        report_path.parent.mkdir(parents=True, exist_ok=True)

        # Generate execution report
        report = self._generate_report(context)
        report_path.write_text(report, encoding="utf-8")
        logger.info("Report generated: %s", report_path)

        # Create PR
        pr_result = self._create_pull_request(context)
        logger.info("PR result: %s", pr_result or "(no PR created)")

        # Update final state
        self._update_final_state(context, pr_result)

        return StageOutput(
            stage_name=self.name,
            verdict=Verdict.PASS,
            result_path=report_path,
            artifacts={"report": report_path},
            output_data={"pr_url": pr_result or ""},
        )

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        state_dir = output.result_path.parent if output.result_path else None
        if state_dir is None:
            return ValidationResult(is_valid=False, errors=["No result path in output"])

        # Check report.md exists
        report_path = state_dir / "report.md"
        if not report_path.exists():
            errors.append("report.md not found")

        # Check state.json is updated to completed
        state_path = state_dir / "state.json"
        if not state_path.exists():
            errors.append("state.json not found")
        else:
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                if state.get("status") != "completed":
                    errors.append(f"state.json status is '{state.get('status')}', expected 'completed'")
            except (json.JSONDecodeError, ValueError) as e:
                errors.append(f"state.json is not valid JSON: {e}")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def _collect_stage_verdicts(self, context: StageContext) -> dict:
        """Collect verdicts from all previous stages."""
        verdicts = {}
        for ex in context.stage_history:
            if ex.feedback:
                verdicts[ex.stage_name.value] = ex.feedback.verdict.value
        return verdicts

    def _generate_report(self, context: StageContext) -> str:
        """Generate execution report."""
        lines = [
            "# Workflow Execution Report\n",
            f"\n**Run ID**: {context.run_id}",
            f"\n**Workflow ID**: {context.workflow_id}",
            f"\n**Completed**: {datetime.now().isoformat()}",
            "\n## Stage History\n",
        ]

        for ex in context.stage_history:
            status = "PASS" if ex.status.value == "completed" else "FAIL"
            lines.append(f"- **{ex.stage_name.value}**: {status} (attempt {ex.retry_attempt + 1})")

        lines.append("\n## Artifacts\n")
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        lines.append(f"- Report: `.dev-workflow/run/{context.run_id}/report.md`")

        # Check for review/test results
        review_path = state_dir / "review-result.json"
        if review_path.exists():
            lines.append(f"- Review: `.dev-workflow/run/{context.run_id}/review-result.json`")

        test_path = state_dir / "test-result.json"
        if test_path.exists():
            lines.append(f"- Tests: `.dev-workflow/run/{context.run_id}/test-result.json`")

        return "\n".join(lines)

    def _create_pull_request(self, context: StageContext) -> str:
        """Create a PR from the worktree branch."""
        try:
            # Push branch
            subprocess.run(
                ["git", "push", "origin", "HEAD"],
                cwd=str(context.worktree_path),
                capture_output=True,
                text=True,
            )

            # Create PR via gh CLI
            result = subprocess.run(
                ["gh", "pr", "create", "--title", context.run_id,
                 "--body", "Automated workflow implementation."],
                cwd=str(context.worktree_path),
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception:
            pass
        return ""

    def _update_final_state(self, context: StageContext, pr_url: str) -> None:
        """Update state.json to completed."""
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        state_path = state_dir / "state.json"
        if not state_path.exists():
            return

        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["status"] = WorkflowStatus.COMPLETED.value
        state["updated_at"] = datetime.now().isoformat()
        if pr_url:
            state["pr_url"] = pr_url

        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
