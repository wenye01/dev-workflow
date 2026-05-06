"""Implement stage: processes one task at a time with agent invocation."""

from __future__ import annotations

import json
import logging
import subprocess
from datetime import datetime
from pathlib import Path

from agents import get_agent_backend
from scripts.issue_tracker import (
    build_feedback_from_tracked_issues,
    get_tracked_issues_by_ids,
    mark_issues_status,
    mark_task_completed,
    pending_or_in_progress_tasks,
)
from scripts.models import (
    AgentContext,
    IssueStatus,
    StageConfig,
    StageContext,
    StageName,
    StageOutput,
    ValidationResult,
    Verdict,
    get_run_state_dir,
)
from scripts.output_schema import get_schema_path
from stages.base import BaseStage, format_agent_failure

logger = logging.getLogger(__name__)


class ImplementStage(BaseStage):
    """Processes one implementation task at a time via agent invocation."""

    @property
    def name(self) -> StageName:
        return StageName.IMPLEMENT

    def validate_input(self, context: StageContext) -> ValidationResult:
        errors = []
        if not context.spec_path.exists():
            errors.append(f"Spec file not found: {context.spec_path}")
        if not context.worktree_path.exists():
            errors.append(f"Worktree not found: {context.worktree_path}")
        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def build_agent_context(self, context: StageContext) -> AgentContext:
        ctx = AgentContext(
            stage_name=self.name,
            project_context={
                "spec_path": str(context.spec_path),
                "worktree_path": str(context.worktree_path),
            },
        )

        progress_path = get_run_state_dir(context.project_path, context.run_id) / "progress.json"
        if progress_path.exists():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            ctx.progress_summary = json.dumps(progress, indent=2, ensure_ascii=False)

        if context.spec_path.exists():
            ctx.spec_content = context.spec_path.read_text(encoding="utf-8")

        return ctx

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        progress_path = state_dir / "progress.json"
        tasks_path = state_dir / "tasks.json"
        candidates = pending_or_in_progress_tasks(tasks_path)
        logger.info("Issue-backed tasks loaded: %d actionable", len(candidates))

        if candidates:
            current_task = candidates[0]
            task_id = current_task.get("id", "unknown")
            synthetic_task = False
            self._mark_task_in_progress(tasks_path, task_id)
        else:
            logger.info("No actionable issue-backed tasks, implementing directly from spec")
            current_task = {
                "id": "spec-implementation",
                "title": "Implement specification",
                "description": context.spec_path.read_text(encoding="utf-8") if context.spec_path.exists() else "",
                "acceptance_criteria": [],
                "status": "in_progress",
            }
            task_id = current_task["id"]
            synthetic_task = True

        task_prompt = self._build_task_prompt(current_task, context)
        logger.info("Task prompt built: %d chars", len(task_prompt))
        before_head = self._git_output(context.worktree_path, ["rev-parse", "HEAD"]).strip()

        try:
            agent_result = self._invoke_agent(task_prompt, context, config)
        except Exception as exc:
            logger.error("Agent invocation failed for task %s: %s", task_id, exc)
            if not synthetic_task:
                self._mark_task_blocked(tasks_path, task_id)
            return StageOutput(stage_name=self.name, verdict=Verdict.FAIL, error_message=str(exc))

        summary = str(agent_result.get("summary") or current_task.get("title", ""))
        linked_issue_ids_for_commit = list(current_task.get("linked_issue_ids", []))
        try:
            commit_sha = self._commit_task_changes(
                context,
                task_id,
                summary,
                linked_issue_ids_for_commit,
                before_head,
            )
        except RuntimeError as exc:
            logger.error("Could not create task commit for %s: %s", task_id, exc)
            if not synthetic_task:
                self._mark_task_blocked(tasks_path, task_id)
            return StageOutput(stage_name=self.name, verdict=Verdict.FAIL, error_message=str(exc))

        linked_issue_ids = [] if synthetic_task else mark_task_completed(tasks_path, task_id)
        issues_path = get_run_state_dir(context.project_path, context.run_id) / "issues.json"
        if linked_issue_ids:
            mark_issues_status(
                issues_path,
                linked_issue_ids,
                IssueStatus.IMPLEMENTED,
                resolution_notes=f"Implemented by task {task_id} in commit {commit_sha or 'uncommitted'}",
                task_id=task_id,
            )

        remaining = [] if synthetic_task else pending_or_in_progress_tasks(tasks_path)
        self._update_progress(
            context,
            task_id,
            summary,
            commit_sha,
            linked_issue_ids_for_commit,
        )
        return StageOutput(
            stage_name=self.name,
            verdict=Verdict.PASS,
            result_path=progress_path,
            output_data={
                "more_tasks": len(remaining) > 0,
                "all_tasks_completed": len(remaining) == 0,
                "commit_sha": commit_sha,
                "source_stage": current_task.get("source_stage"),
                "linked_issue_ids": linked_issue_ids_for_commit,
            },
        )

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        if output.result_path and output.result_path.parent.exists():
            progress_path = output.result_path.parent / "progress.json"
        else:
            return ValidationResult(is_valid=False, errors=["State directory not found"])

        if not progress_path.exists():
            return ValidationResult(is_valid=False, errors=["progress.json not found"])

        try:
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            if (output.output_data or {}).get("all_tasks_completed"):
                return ValidationResult(is_valid=True, errors=[])
            completed = progress.get("completed_tasks", [])
            if not completed:
                return ValidationResult(
                    is_valid=False,
                    errors=["progress.json has no completed tasks"],
                )
        except (json.JSONDecodeError, ValueError) as exc:
            return ValidationResult(is_valid=False, errors=[f"progress.json invalid: {exc}"])

        return ValidationResult(is_valid=True, errors=[])

    def _build_task_prompt(self, task: dict, context: StageContext) -> str:
        from context.builder import (
            build_common_context,
            build_feedback_chain,
            build_scenario_context,
            load_project_context,
            render_template,
        )
        from context.feedback import build_feedback_section

        task_lines = [f"**{task.get('title', 'Unknown')}**\n", task.get("description", "")]
        if task.get("acceptance_criteria"):
            task_lines.append("\nAcceptance criteria:")
            task_lines.extend(f"- {item}" for item in task["acceptance_criteria"])

        agent_ctx = context.agent_context or self.build_agent_context(context)
        progress_path = get_run_state_dir(context.project_path, context.run_id) / "progress.json"
        progress_text = ""
        previous_attempt_summary = ""
        if progress_path.exists():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            progress_text = json.dumps(progress, indent=2, ensure_ascii=False)
            previous_attempt_summary = progress.get("last_attempt_summary", "")

        spec_text = agent_ctx.spec_content or (context.spec_path.read_text(encoding="utf-8") if context.spec_path.exists() else "")

        retry_hint = ""
        if context.retry_count > 0:
            retry_hint = f"\n## Retry Context\nThis is attempt #{context.retry_count + 1}. Fix the reported issues directly.\n"

        feedback = ""
        issue_ids = list(task.get("linked_issue_ids", []))
        if issue_ids:
            issues_path = get_run_state_dir(context.project_path, context.run_id) / "issues.json"
            tracked = get_tracked_issues_by_ids(issues_path, issue_ids)
            if tracked:
                feedback = build_feedback_section(
                    build_feedback_from_tracked_issues(tracked),
                    previous_attempt_summary,
                )

        project_ctx = load_project_context(context.worktree_path)
        if agent_ctx.progress_summary:
            progress_text = agent_ctx.progress_summary
        common_context = build_common_context(context, spec_text)
        scenario_context = build_scenario_context(context, self.name, task=task)
        feedback_chain = build_feedback_chain(context)
        return render_template(self.name, {
            **project_ctx,
            "common_context": common_context,
            "scenario_context": scenario_context,
            "feedback_chain": feedback_chain,
            "spec_content": spec_text,
            "task_definition": "\n".join(task_lines),
            "progress_summary": progress_text,
            "worktree_path": str(context.worktree_path),
            "retry_hint": retry_hint,
            "feedback": feedback,
        })

    def _invoke_agent(self, prompt: str, context: StageContext, config: StageConfig) -> dict:
        backend = get_agent_backend(config.agent_backend)
        schema_path = get_schema_path("implement-output")
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        debug_log_dir = state_dir / "agent-logs" / f"implement-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        result = backend.invoke(
            prompt=prompt,
            working_dir=context.worktree_path,
            timeout=config.timeout_seconds,
            model=config.agent_model,
            output_schema=schema_path,
            debug_log_dir=debug_log_dir,
        )

        summary = {
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "stdout_length": len(result.stdout),
            "stderr_length": len(result.stderr),
            "stderr_preview": result.stderr[:2000] if result.stderr else "",
            "parsed_output_keys": list(result.parsed_output.keys()) if result.parsed_output else None,
            "timestamp": datetime.now().isoformat(),
        }
        (debug_log_dir / "result-summary.json").write_text(
            json.dumps(summary, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

        if result.timed_out:
            raise TimeoutError(format_agent_failure(
                stage_label="Implement",
                agent_backend=config.agent_backend,
                agent_model=config.agent_model,
                timeout_seconds=config.timeout_seconds,
                debug_log_dir=debug_log_dir,
                reason="agent timed out",
            ))
        if result.exit_code != 0:
            raise RuntimeError(format_agent_failure(
                stage_label="Implement",
                agent_backend=config.agent_backend,
                agent_model=config.agent_model,
                timeout_seconds=config.timeout_seconds,
                debug_log_dir=debug_log_dir,
                exit_code=result.exit_code,
                reason=result.stderr or "agent returned non-zero exit status",
            ))

        return result.parsed_output or {}

    def _commit_task_changes(
        self,
        context: StageContext,
        task_id: str,
        summary: str,
        linked_issue_ids: list[str],
        before_head: str,
    ) -> str | None:
        if not self._is_git_worktree(context.worktree_path):
            logger.warning("Skipping task commit because worktree is not a git repository: %s", context.worktree_path)
            return None

        status = self._git_output(context.worktree_path, ["status", "--porcelain"])
        if not status.strip():
            current_head = self._git_output(context.worktree_path, ["rev-parse", "HEAD"]).strip()
            if current_head and current_head != before_head:
                return current_head
            raise RuntimeError(
                f"Implement task {task_id} did not produce file changes; refusing to mark it complete.",
            )

        self._run_git(context.worktree_path, ["add", "-A"])
        linked = ", ".join(linked_issue_ids) if linked_issue_ids else "none"
        commit_message = (
            f"workflow: implement {task_id}\n\n"
            f"Summary: {summary[:200]}\n"
            f"Linked issues: {linked}"
        )
        self._run_git(context.worktree_path, ["commit", "-m", commit_message])
        return self._git_output(context.worktree_path, ["rev-parse", "HEAD"]).strip() or None

    def _is_git_worktree(self, worktree_path: Path) -> bool:
        return self._git_output(worktree_path, ["rev-parse", "--is-inside-work-tree"]).strip() == "true"

    def _git_output(self, worktree_path: Path, args: list[str]) -> str:
        try:
            result = subprocess.run(
                ["git", *args],
                cwd=str(worktree_path),
                capture_output=True,
                text=True,
                check=False,
            )
        except (OSError, ValueError):
            return ""
        return result.stdout if result.returncode == 0 else ""

    def _run_git(self, worktree_path: Path, args: list[str]) -> None:
        result = subprocess.run(
            ["git", *args],
            cwd=str(worktree_path),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "git command failed").strip())

    def _update_progress(
        self,
        context: StageContext,
        task_id: str,
        task_title: str,
        commit_sha: str | None,
        linked_issue_ids: list[str],
    ) -> None:
        progress_path = get_run_state_dir(context.project_path, context.run_id) / "progress.json"
        if progress_path.exists():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
        else:
            progress = {}

        progress.setdefault("completed_tasks", [])
        progress.setdefault("git_commits", [])
        progress.setdefault("task_commits", [])
        progress["completed_tasks"].append(task_id)
        progress["current_task"] = None
        progress["last_attempt_summary"] = task_title
        progress["last_updated"] = datetime.now().isoformat()
        if commit_sha:
            progress["git_commits"].append(commit_sha)
        progress["task_commits"].append({
            "task_id": task_id,
            "commit": commit_sha,
            "linked_issue_ids": linked_issue_ids,
            "summary": task_title,
        })

        progress_path.write_text(json.dumps(progress, indent=2, ensure_ascii=False), encoding="utf-8")

    def _mark_task_in_progress(self, tasks_path: Path, task_id: str) -> None:
        if not tasks_path.exists():
            return
        tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
        for task in tasks:
            if task.get("id") == task_id:
                task["status"] = "in_progress"
                break
        tasks_path.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), encoding="utf-8")

    def _mark_task_blocked(self, tasks_path: Path, task_id: str) -> None:
        if not tasks_path.exists():
            return
        tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
        for task in tasks:
            if task.get("id") == task_id:
                task["status"] = "blocked"
                break
        tasks_path.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), encoding="utf-8")
