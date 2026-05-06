"""Finish stage: submit PR, persist final status, and generate an execution report."""

from __future__ import annotations

import json
import logging
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

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
    """Submits PR, records publish status, and writes an honest final report."""

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

        summary = self._build_summary(context)
        publish_result = self._create_pull_request(context)
        summary["publish"] = publish_result
        summary["finish_status"] = (
            "completed" if publish_result["status"] == "created" else "completed_with_warnings"
        )

        report = self._generate_report(context, summary)
        report_path.write_text(report, encoding="utf-8")
        logger.info("Report generated: %s", report_path)
        logger.info("Publish status: %s", publish_result["status"])

        self._update_final_state(context, summary, report_path)

        return StageOutput(
            stage_name=self.name,
            verdict=Verdict.PASS,
            result_path=report_path,
            artifacts={"report": report_path},
            output_data={
                "finish_status": summary["finish_status"],
                "summary": summary["headline"],
                "report_path": str(report_path),
                "pr_url": publish_result.get("pr_url", ""),
                "publish_status": publish_result["status"],
                "publish_errors": publish_result["errors"],
                "stage_counts": summary["stage_counts"],
                "issue_counts": summary["issue_counts"],
                "task_counts": summary["task_counts"],
                "git": summary["git"],
            },
        )

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        state_dir = output.result_path.parent if output.result_path else None
        if state_dir is None:
            return ValidationResult(is_valid=False, errors=["No result path in output"])

        report_path = state_dir / "report.md"
        if not report_path.exists():
            errors.append("report.md not found")
        elif not report_path.read_text(encoding="utf-8").strip():
            errors.append("report.md is empty")

        state_path = state_dir / "state.json"
        if not state_path.exists():
            errors.append("state.json not found")
        else:
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                if state.get("status") != "completed":
                    errors.append(
                        f"state.json status is '{state.get('status')}', expected 'completed'",
                    )
                if not state.get("finish_status"):
                    errors.append("state.json missing finish_status")
                if not state.get("summary"):
                    errors.append("state.json missing summary")
                if not isinstance(state.get("publish"), dict):
                    errors.append("state.json missing publish status")
            except (json.JSONDecodeError, ValueError) as e:
                errors.append(f"state.json is not valid JSON: {e}")

        if output.output_data and not output.output_data.get("finish_status"):
            errors.append("finish output missing finish_status")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def _collect_stage_verdicts(self, context: StageContext) -> dict:
        """Collect verdicts from all previous stages."""
        verdicts = {}
        for ex in context.stage_history:
            if ex.feedback:
                verdicts[ex.stage_name.value] = ex.feedback.verdict.value
        return verdicts

    def _build_summary(self, context: StageContext) -> dict[str, Any]:
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        issues = self._read_json(state_dir / "issues.json", [])
        tasks = self._read_json(state_dir / "tasks.json", [])
        progress = self._read_json(state_dir / "progress.json", {})

        stage_counts = {
            "total": len(context.stage_history),
            "completed": sum(1 for ex in context.stage_history if ex.status.value == "completed"),
            "failed": sum(1 for ex in context.stage_history if ex.status.value == "failed"),
            "retried": sum(1 for ex in context.stage_history if ex.retry_attempt > 0),
        }
        issue_counts = self._count_issues(issues)
        task_counts = self._count_tasks(tasks, progress)
        result_summaries = self._collect_result_summaries(state_dir)
        git = self._collect_git_summary(context.worktree_path, progress)

        blocking = (
            issue_counts["open"]
            + issue_counts["accepted"]
            + issue_counts["implemented"]
            + task_counts["pending"]
            + task_counts["blocked"]
        )
        headline = (
            f"Workflow finished with {stage_counts['completed']} completed stage attempts, "
            f"{stage_counts['failed']} failed attempts, "
            f"{task_counts['completed']} completed tasks, "
            f"and {blocking} remaining tracked blockers."
        )

        return {
            "headline": headline,
            "stage_counts": stage_counts,
            "issue_counts": issue_counts,
            "task_counts": task_counts,
            "result_summaries": result_summaries,
            "git": git,
        }

    def _generate_report(self, context: StageContext, summary: dict[str, Any]) -> str:
        """Generate execution report."""
        publish = summary["publish"]
        git = summary["git"]
        lines = [
            "# Workflow Execution Report\n",
            f"\n**Run ID**: {context.run_id}",
            f"\n**Workflow ID**: {context.workflow_id}",
            f"\n**Finish Status**: {summary['finish_status']}",
            f"\n**Completed**: {datetime.now().isoformat()}",
            "\n\n## Summary\n",
            summary["headline"],
            "\n\n## Publish Status\n",
            f"- Status: {publish['status']}",
            f"- Push: {publish['push_status']}",
            f"- PR: {publish['pr_status']}",
        ]
        if publish.get("pr_url"):
            lines.append(f"- PR URL: {publish['pr_url']}")
        if publish["errors"]:
            lines.append("- Errors:")
            lines.extend(f"  - {error}" for error in publish["errors"])

        lines.extend([
            "\n## Stage Summary\n",
            f"- Completed: {summary['stage_counts']['completed']}",
            f"- Failed: {summary['stage_counts']['failed']}",
            f"- Total attempts: {summary['stage_counts']['total']}",
            f"- Retried stages: {summary['stage_counts']['retried']}",
            "\n## Stage History\n",
        ])
        for ex in context.stage_history:
            status = "PASS" if ex.status.value == "completed" else "FAIL"
            lines.append(f"- **{ex.stage_name.value}**: {status} (attempt {ex.retry_attempt + 1})")

        lines.extend([
            "\n## Issues\n",
            f"- Open: {summary['issue_counts']['open']}",
            f"- Accepted: {summary['issue_counts']['accepted']}",
            f"- Implemented: {summary['issue_counts']['implemented']}",
            f"- Closed: {summary['issue_counts']['closed']}",
            f"- Rejected: {summary['issue_counts']['rejected']}",
            f"- Critical: {summary['issue_counts']['critical']}",
            f"- Major: {summary['issue_counts']['major']}",
            "\n## Tasks\n",
            f"- Completed: {summary['task_counts']['completed']}",
            f"- Pending: {summary['task_counts']['pending']}",
            f"- Blocked: {summary['task_counts']['blocked']}",
            "\n## Review And Test Results\n",
        ])
        if summary["result_summaries"]:
            lines.extend(f"- {item}" for item in summary["result_summaries"])
        else:
            lines.append("- No review or test result files found.")

        lines.extend([
            "\n## Git Summary\n",
            f"- Branch: {git['branch'] or '(unknown)'}",
            f"- HEAD: {git['head'] or '(unknown)'}",
            f"- Working tree clean: {git['clean']}",
        ])
        if git["task_commits"]:
            lines.append("- Task commits:")
            for item in git["task_commits"]:
                lines.append(
                    f"  - {item.get('task_id', 'unknown')}: "
                    f"{item.get('commit', 'unknown')} - {item.get('summary', '')}"
                )
        if git["recent_log"]:
            lines.append("\n```text")
            lines.append(git["recent_log"])
            lines.append("```")

        lines.append("\n## Artifacts\n")
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        lines.append(f"- Report: `.dev-workflow/run/{context.run_id}/report.md`")

        review_path = state_dir / "review-result.json"
        if review_path.exists():
            lines.append(f"- Review: `.dev-workflow/run/{context.run_id}/review-result.json`")

        test_path = state_dir / "test-result.json"
        if test_path.exists():
            lines.append(f"- Tests: `.dev-workflow/run/{context.run_id}/test-result.json`")

        return "\n".join(lines)

    def _create_pull_request(self, context: StageContext) -> dict[str, Any]:
        """Push the branch and create a PR, returning structured publish status."""
        result: dict[str, Any] = {
            "status": "not_created",
            "push_status": "not_run",
            "pr_status": "not_run",
            "pr_url": "",
            "errors": [],
        }

        push = self._run_command(["git", "push", "origin", "HEAD"], context.worktree_path)
        if push["returncode"] != 0:
            result["push_status"] = "failed"
            result["pr_status"] = "skipped"
            result["errors"].append("git push failed: " + push["message"])
            return result
        result["push_status"] = "ok"

        pr = self._run_command(
            [
                "gh",
                "pr",
                "create",
                "--title",
                context.run_id,
                "--body",
                "Automated workflow implementation.",
            ],
            context.worktree_path,
        )
        if pr["returncode"] != 0:
            result["pr_status"] = "failed"
            result["errors"].append("gh pr create failed: " + pr["message"])
            return result

        result["status"] = "created"
        result["pr_status"] = "created"
        result["pr_url"] = pr["stdout"].strip()
        return result

    def _update_final_state(
        self,
        context: StageContext,
        summary: dict[str, Any],
        report_path: Path,
    ) -> None:
        """Update state.json to completed and persist final summary details."""
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        state_path = state_dir / "state.json"
        if not state_path.exists():
            return

        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["status"] = WorkflowStatus.COMPLETED.value
        state["finish_status"] = summary["finish_status"]
        state["updated_at"] = datetime.now().isoformat()
        state["report_path"] = str(report_path)
        state["publish"] = summary["publish"]
        state["summary"] = summary["headline"]
        pr_url = summary["publish"].get("pr_url")
        if pr_url:
            state["pr_url"] = pr_url

        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")

    def _collect_result_summaries(self, state_dir: Path) -> list[str]:
        summaries: list[str] = []
        for filename, label in [
            ("review-result.json", "Review"),
            ("test-result.json", "Latest test"),
        ]:
            data = self._read_json(state_dir / filename, None)
            if not isinstance(data, dict):
                continue
            verdict = data.get("verdict", "unknown")
            issues = data.get("issues", [])
            issue_count = len(issues) if isinstance(issues, list) else 0
            summary = str(data.get("summary", "")).strip()
            summaries.append(
                f"{label}: verdict={verdict}; issues={issue_count}; summary={summary}",
            )
        return summaries

    def _collect_git_summary(self, worktree_path: Path, progress: Any) -> dict[str, Any]:
        task_commits = []
        if isinstance(progress, dict):
            task_commits = [
                item for item in progress.get("task_commits", [])
                if isinstance(item, dict)
            ][-10:]
        status = self._run_command(["git", "status", "--porcelain"], worktree_path)
        return {
            "branch": self._git_output(worktree_path, ["rev-parse", "--abbrev-ref", "HEAD"]),
            "head": self._git_output(worktree_path, ["rev-parse", "--short", "HEAD"]),
            "clean": status["returncode"] == 0 and status["stdout"].strip() == "",
            "recent_log": self._git_output(
                worktree_path,
                ["log", "--oneline", "--decorate", "-10"],
            ),
            "task_commits": task_commits,
        }

    def _count_issues(self, issues: Any) -> dict[str, int]:
        counts = {
            "open": 0,
            "accepted": 0,
            "implemented": 0,
            "closed": 0,
            "rejected": 0,
            "critical": 0,
            "major": 0,
        }
        if not isinstance(issues, list):
            return counts
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            status = issue.get("status")
            severity = issue.get("severity")
            if status in counts:
                counts[status] += 1
            if severity in ("critical", "major"):
                counts[severity] += 1
        return counts

    def _count_tasks(self, tasks: Any, progress: Any) -> dict[str, int]:
        counts = {"completed": 0, "pending": 0, "blocked": 0}
        if isinstance(tasks, list) and tasks:
            for task in tasks:
                if not isinstance(task, dict):
                    continue
                status = task.get("status")
                if status == "completed":
                    counts["completed"] += 1
                elif status == "blocked":
                    counts["blocked"] += 1
                elif status in ("pending", "in_progress"):
                    counts["pending"] += 1
            return counts

        if isinstance(progress, dict):
            completed = progress.get("completed_tasks", [])
            if isinstance(completed, list):
                counts["completed"] = len(completed)
        return counts

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return default

    def _git_output(self, worktree_path: Path, args: list[str]) -> str:
        result = self._run_command(["git", *args], worktree_path)
        return result["stdout"].strip() if result["returncode"] == 0 else ""

    def _run_command(self, cmd: list[str], cwd: Path) -> dict[str, Any]:
        try:
            result = subprocess.run(
                cmd,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            return {"returncode": -1, "stdout": "", "stderr": str(exc), "message": str(exc)}

        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        return {
            "returncode": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "message": stderr or stdout or f"{cmd[0]} exited with {result.returncode}",
        }
