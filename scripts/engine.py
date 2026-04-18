"""Workflow state machine engine with transitions library."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from transitions import Machine

from scripts.models import (
    ProgressArtifact,
    StageExecution,
    StageName,
    Verdict,
    WorkflowInstance,
    WorkflowStatus,
    get_run_state_dir,
)

logger = logging.getLogger(__name__)

# State names for the transitions library
STATES = [s.value for s in StageName] + ["completed", "failed"]

# Transition definitions from data-model.md
TRANSITIONS = [
    {"trigger": "start_workflow", "source": "bootstrap", "dest": "implement",
     "conditions": "_bootstrap_success"},
    {"trigger": "bootstrap_failed", "source": "bootstrap", "dest": "failed"},

    # Implement loops until all tasks done, then goes to review
    {"trigger": "implement_complete", "source": "implement", "dest": "review",
     "conditions": "_all_tasks_done"},
    {"trigger": "implement_complete", "source": "implement", "dest": "implement",
     "conditions": "_tasks_remaining", "unless": "_all_tasks_done"},

    # Review: pass → whitebox_test, fail with code_quality → implement,
    # fail with test_quality → whitebox_test, max retries → failed
    {"trigger": "review_complete", "source": "review", "dest": "whitebox_test",
     "conditions": "_verdict_pass"},
    {"trigger": "review_complete", "source": "review", "dest": "implement",
     "conditions": "_review_fail_code_quality"},
    {"trigger": "review_complete", "source": "review", "dest": "whitebox_test",
     "conditions": "_review_fail_test_quality"},
    {"trigger": "review_max_retries", "source": "review", "dest": "failed"},

    # Whitebox-Test: pass → blackbox_test, fail → implement, max → failed
    {"trigger": "test_complete", "source": "whitebox_test", "dest": "blackbox_test",
     "conditions": "_verdict_pass"},
    {"trigger": "test_complete", "source": "whitebox_test", "dest": "implement",
     "conditions": "_verdict_fail", "unless": "_verdict_pass"},
    {"trigger": "test_max_retries", "source": "whitebox_test", "dest": "failed"},

    # Blackbox-Test: pass → finish, fail → implement, max → failed
    {"trigger": "test_complete", "source": "blackbox_test", "dest": "finish",
     "conditions": "_verdict_pass"},
    {"trigger": "test_complete", "source": "blackbox_test", "dest": "implement",
     "conditions": "_verdict_fail", "unless": "_verdict_pass"},
    {"trigger": "test_max_retries", "source": "blackbox_test", "dest": "failed"},

    # Finish → completed
    {"trigger": "finish_complete", "source": "finish", "dest": "completed"},

    # Timeout: retry same stage or fail
    {"trigger": "on_timeout", "source": "*", "dest": "="},  # Stay in same state (retry)
]


class WorkflowEngine:
    """Manages workflow state machine and orchestrates stage execution."""

    def __init__(self, instance: WorkflowInstance, config: Any = None) -> None:
        self.instance = instance
        self.config = config
        self._last_verdict: Verdict | None = None
        self._last_issue_category: str | None = None
        self._all_tasks_complete = False
        self._machine: Machine | None = None

    def start(self) -> None:
        """Initialize and start the state machine."""
        self._machine = Machine(
            model=self,
            states=STATES,
            initial=self.instance.current_stage.value,
            transitions=TRANSITIONS,
            after_state_change="_on_state_changed",
        )
        logger.info("Workflow engine started at state: %s", self.instance.current_stage.value)

    # --- Condition predicates for conditional transitions ---

    def _bootstrap_success(self) -> bool:
        return self._last_verdict == Verdict.PASS

    def _all_tasks_done(self) -> bool:
        return self._all_tasks_complete

    def _tasks_remaining(self) -> bool:
        return not self._all_tasks_complete

    def _verdict_pass(self) -> bool:
        return self._last_verdict == Verdict.PASS

    def _verdict_fail(self) -> bool:
        return self._last_verdict == Verdict.FAIL

    def _review_fail_code_quality(self) -> bool:
        return self._last_verdict == Verdict.FAIL and self._last_issue_category == "code_quality"

    def _review_fail_test_quality(self) -> bool:
        return self._last_verdict == Verdict.FAIL and self._last_issue_category == "test_quality"

    # --- Callback ---

    def _on_state_changed(self) -> None:
        """Called after every state transition. Persists state to disk."""
        if self._machine is None:
            return
        new_state = self._machine.get_state(self.state)
        try:
            self.instance.current_stage = StageName(new_state.value)
        except ValueError:
            # Terminal states (completed, failed)
            if new_state.value == "completed":
                self.instance.status = WorkflowStatus.COMPLETED
            elif new_state.value == "failed":
                self.instance.status = WorkflowStatus.FAILED

        self.instance.updated_at = self.instance.updated_at  # touch timestamp
        logger.info("State changed to: %s", new_state.value)
        self._persist_state()

    # --- Public API ---

    def set_verdict(self, verdict: Verdict, issue_category: str | None = None) -> None:
        """Set the verdict from the last stage execution."""
        self._last_verdict = verdict
        self._last_issue_category = issue_category
        logger.info(
            "Verdict set: verdict=%s, category=%s, stage=%s",
            verdict.value, issue_category, self.instance.current_stage.value,
        )

    def set_tasks_complete(self, complete: bool) -> None:
        """Mark whether all implementation tasks are done."""
        self._all_tasks_complete = complete
        logger.info("Tasks complete flag set to: %s", complete)

    def get_retry_count(self, stage_name: str) -> int:
        """Get current retry count for a stage."""
        return self.instance.retry_counts.get(stage_name, 0)

    def increment_retry(self, stage_name: str) -> int:
        """Increment retry counter for a stage and return new count."""
        current = self.instance.retry_counts.get(stage_name, 0)
        self.instance.retry_counts[stage_name] = current + 1
        logger.warning(
            "Retry incremented for %s: %d/%d",
            stage_name, current + 1, self.instance.max_retries,
        )
        return current + 1

    def retries_exhausted(self, stage_name: str) -> bool:
        """Check if max retries have been used for a stage."""
        return self.get_retry_count(stage_name) >= self.instance.max_retries

    def add_stage_execution(self, execution: StageExecution) -> None:
        """Record a stage execution in the workflow history."""
        self.instance.stage_executions.append(execution)
        logger.info(
            "Stage execution recorded: %s (status=%s, attempt=%d)",
            execution.stage_name.value, execution.status.value, execution.retry_attempt,
        )

    def _persist_state(self) -> None:
        """Persist current workflow state to project root .dev-workflow/run/."""
        if self.instance.project_path is None:
            return
        state_dir = get_run_state_dir(self.instance.project_path, self.instance.run_id)
        state_path = state_dir / "state.json"
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(
            self.instance.model_dump_json(indent=2),
            encoding="utf-8",
        )

    def persist(self) -> None:
        """Manually persist state to disk."""
        self._persist_state()

    def save_progress(self, progress: ProgressArtifact) -> None:
        """Save progress artifact to project root .dev-workflow/run/."""
        if self.instance.project_path is None:
            return
        state_dir = get_run_state_dir(self.instance.project_path, self.instance.run_id)
        progress_path = state_dir / "progress.json"
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        progress_path.write_text(
            progress.model_dump_json(indent=2),
            encoding="utf-8",
        )


def restore_engine(state_path: Path, config: Any = None) -> WorkflowEngine:
    """Restore a workflow engine from a persisted state.json."""
    if not state_path.exists():
        raise FileNotFoundError(f"No state file found at {state_path}")

    instance = WorkflowInstance.model_validate_json(state_path.read_text(encoding="utf-8"))
    engine = WorkflowEngine(instance, config)
    engine.start()
    return engine
