"""Implement stage: processes one task at a time with agent invocation."""

from __future__ import annotations

import json
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
    get_run_state_dir,
)
from scripts.output_schema import get_schema_path
from stages.base import BaseStage


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

        tasks_path = get_run_state_dir(context.project_path, context.run_id) / "tasks.json"
        if not tasks_path.exists():
            errors.append("tasks.json not found in worktree")
        else:
            tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
            pending = [t for t in tasks if t.get("status") == "pending"]
            if not pending:
                errors.append("No pending tasks found")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def build_agent_context(self, context: StageContext) -> AgentContext:
        ctx = AgentContext(
            stage_name=self.name,
            project_context={
                "spec_path": str(context.spec_path),
                "worktree_path": str(context.worktree_path),
            },
        )

        # Load current task info
        tasks_path = get_run_state_dir(context.project_path, context.run_id) / "tasks.json"
        if tasks_path.exists():
            tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
            pending = [t for t in tasks if t.get("status") == "pending"]
            if pending:
                task = pending[0]
                ctx.stage_specific_context["current_task"] = task

        # Load progress
        progress_path = get_run_state_dir(context.project_path, context.run_id) / "progress.json"
        if progress_path.exists():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            ctx.progress_summary = json.dumps(progress, indent=2)

        # Load spec content
        if context.spec_path.exists():
            ctx.spec_content = context.spec_path.read_text(encoding="utf-8")

        return ctx

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        tasks_path = get_run_state_dir(context.project_path, context.run_id) / "tasks.json"

        # Load tasks
        tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
        pending = [t for t in tasks if t.get("status") == "pending"]
        if not pending:
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.PASS,
                error_message="All tasks completed",
            )

        current_task = pending[0]
        task_id = current_task.get("id", "unknown")

        # Mark task as in-progress
        for t in tasks:
            if t.get("id") == task_id:
                t["status"] = "in_progress"
                break
        tasks_path.write_text(json.dumps(tasks, indent=2), encoding="utf-8")

        # Build prompt for agent
        task_prompt = self._build_task_prompt(current_task, context)

        # Invoke agent
        try:
            self._invoke_agent(task_prompt, context, config)
        except Exception as e:
            # Mark task as blocked
            for t in tasks:
                if t.get("id") == task_id:
                    t["status"] = "blocked"
                    break
            tasks_path.write_text(json.dumps(tasks, indent=2), encoding="utf-8")
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message=str(e),
            )

        # Check if tasks remain after this one
        remaining = [t for t in tasks if t.get("status") == "pending"]
        more_tasks = len(remaining) > 0

        # Update progress
        self._update_progress(context, task_id, current_task.get("title", ""))

        return StageOutput(
            stage_name=self.name,
            verdict=Verdict.PASS,
            output_data={"more_tasks": more_tasks},
        )

    def determine_next_stage(self, output: StageOutput) -> StageName | None:
        if output.verdict == Verdict.FAIL:
            return None
        return StageName.REVIEW

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        # validate_output only receives worktree_path; find state dir from output or skip
        if output.result_path and output.result_path.parent.exists():
            progress_path = output.result_path.parent / "progress.json"
        else:
            return ValidationResult(is_valid=False, errors=["State directory not found"])

        # Check progress.json exists and has updates
        if not progress_path.exists():
            errors.append("progress.json not found — agent did not update progress")
        else:
            try:
                progress = json.loads(progress_path.read_text(encoding="utf-8"))
                completed = progress.get("completed_tasks", [])
                if not completed:
                    errors.append("progress.json has no completed tasks — agent may not have finished")
            except (json.JSONDecodeError, ValueError) as e:
                errors.append(f"progress.json is not valid JSON: {e}")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def _build_task_prompt(self, task: dict, context: StageContext) -> str:
        """Build a prompt for the agent to implement a single task using template."""
        from context.builder import load_project_context, render_template

        # Build task definition section
        task_lines = [f"**{task.get('title', 'Unknown')}**\n"]
        task_lines.append(task.get("description", ""))
        if task.get("acceptance_criteria"):
            task_lines.append("\n验收标准：")
            for ac in task["acceptance_criteria"]:
                task_lines.append(f"- {ac}")

        # Load progress
        progress_text = ""
        progress_path = get_run_state_dir(context.project_path, context.run_id) / "progress.json"
        if progress_path.exists():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            progress_text = json.dumps(progress, indent=2, ensure_ascii=False)

        # Load spec content
        spec_text = ""
        if context.spec_path.exists():
            spec_text = context.spec_path.read_text(encoding="utf-8")

        retry_hint = ""
        if context.retry_count > 0:
            retry_hint = f"\n## 注意\n这是第 {context.retry_count + 1} 次尝试，请仔细处理上次的反馈。"

        # Load .dev-workflow/ project context (must-inject + index)
        project_ctx = load_project_context(context.worktree_path)

        return render_template(self.name, {
            **project_ctx,
            "spec_content": spec_text,
            "task_definition": "\n".join(task_lines),
            "progress_summary": progress_text,
            "worktree_path": str(context.worktree_path),
            "retry_hint": retry_hint,
            "feedback": "",
        })

    def _invoke_agent(self, prompt: str, context: StageContext, config: StageConfig) -> dict:
        """Invoke agent backend to implement the task."""
        from agents.claude import ClaudeBackend

        backend = ClaudeBackend()
        schema_path = get_schema_path("implement-output")
        result = backend.invoke(
            prompt=prompt,
            working_dir=context.worktree_path,
            timeout=config.timeout_seconds,
            output_schema=schema_path,
        )

        if result.timed_out:
            raise TimeoutError("Agent invocation timed out")
        if result.exit_code != 0:
            raise RuntimeError(f"Agent invocation failed: {result.stderr}")

        return result.parsed_output or {}

    def _update_progress(self, context: StageContext, task_id: str, task_title: str) -> None:
        """Update progress.json after task completion."""
        progress_path = get_run_state_dir(context.project_path, context.run_id) / "progress.json"
        if progress_path.exists():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
        else:
            progress = {}

        progress.setdefault("completed_tasks", [])
        progress.setdefault("git_commits", [])
        progress["completed_tasks"].append(task_id)
        progress["current_task"] = None
        progress["last_updated"] = datetime.now().isoformat()

        # Get latest commit hash
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(context.worktree_path),
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                progress["git_commits"].append(result.stdout.strip())
        except Exception:
            pass

        progress_path.write_text(json.dumps(progress, indent=2), encoding="utf-8")
