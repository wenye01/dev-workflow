"""Workflow state machine engine with transitions library."""

from __future__ import annotations

import logging
import json
from datetime import datetime
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

STATES = [s.value for s in StageName] + ["completed", "failed"]

TRANSITIONS = [
    {"trigger": "start_workflow", "source": "bootstrap", "dest": "implement", "conditions": "_bootstrap_success"},
    {"trigger": "bootstrap_failed", "source": "bootstrap", "dest": "failed"},

    {"trigger": "implement_complete", "source": "implement", "dest": "whitebox_test", "conditions": "_skip_review_after_implement"},
    {"trigger": "implement_complete", "source": "implement", "dest": "review", "conditions": "_all_tasks_done"},
    {"trigger": "implement_complete", "source": "implement", "dest": "implement", "conditions": "_tasks_remaining", "unless": "_all_tasks_done"},
    {"trigger": "implement_failed", "source": "implement", "dest": "failed"},

    {"trigger": "review_complete", "source": "review", "dest": "whitebox_test", "conditions": "_verdict_pass"},
    {"trigger": "review_complete", "source": "review", "dest": "adjudicate", "conditions": "_verdict_fail"},
    {"trigger": "review_max_retries", "source": "review", "dest": "failed"},

    {"trigger": "adjudicate_complete", "source": "adjudicate", "dest": "implement", "conditions": "_adjudicate_to_implement"},
    {"trigger": "adjudicate_complete", "source": "adjudicate", "dest": "whitebox_test", "conditions": "_adjudicate_to_whitebox"},
    {"trigger": "adjudicate_complete", "source": "adjudicate", "dest": "blackbox_test", "conditions": "_adjudicate_to_blackbox"},
    {"trigger": "adjudicate_complete", "source": "adjudicate", "dest": "finish", "conditions": "_adjudicate_to_finish"},
    {"trigger": "adjudicate_failed", "source": "adjudicate", "dest": "failed"},

    {"trigger": "test_complete", "source": "whitebox_test", "dest": "blackbox_test", "conditions": "_verdict_pass"},
    {"trigger": "test_complete", "source": "whitebox_test", "dest": "adjudicate", "conditions": "_verdict_fail", "unless": "_verdict_pass"},
    {"trigger": "test_max_retries", "source": "whitebox_test", "dest": "failed"},

    {"trigger": "test_complete", "source": "blackbox_test", "dest": "finish", "conditions": "_verdict_pass"},
    {"trigger": "test_complete", "source": "blackbox_test", "dest": "adjudicate", "conditions": "_verdict_fail", "unless": "_verdict_pass"},
    {"trigger": "test_max_retries", "source": "blackbox_test", "dest": "failed"},

    {"trigger": "finish_complete", "source": "finish", "dest": "completed"},
    {"trigger": "finish_failed", "source": "finish", "dest": "failed"},
    {"trigger": "on_timeout", "source": "*", "dest": "="},
]


class WorkflowEngine:
    """Manages workflow state machine and orchestrates stage execution."""

    def __init__(self, instance: WorkflowInstance, config: Any = None) -> None:
        self.instance = instance
        self.config = config
        self._last_verdict: Verdict | None = None
        self._last_issue_category: str | None = None
        self._all_tasks_complete = False
        self._adjudicate_target: StageName | None = None
        self._skip_review_after_implement_flag = False
        self._machine: Machine | None = None

    def start(self) -> None:
        self._machine = Machine(
            model=self,
            states=STATES,
            initial=self.instance.current_stage.value,
            transitions=TRANSITIONS,
            after_state_change="_on_state_changed",
        )
        logger.info("Workflow engine started at state: %s", self.instance.current_stage.value)

    def _bootstrap_success(self) -> bool:
        return self._last_verdict == Verdict.PASS

    def _all_tasks_done(self) -> bool:
        return self._all_tasks_complete

    def _tasks_remaining(self) -> bool:
        return not self._all_tasks_complete

    def _skip_review_after_implement(self) -> bool:
        return self._skip_review_after_implement_flag

    def _verdict_pass(self) -> bool:
        return self._last_verdict == Verdict.PASS

    def _verdict_fail(self) -> bool:
        return self._last_verdict == Verdict.FAIL

    def _adjudicate_to_implement(self) -> bool:
        return self._adjudicate_target == StageName.IMPLEMENT

    def _adjudicate_to_whitebox(self) -> bool:
        return self._adjudicate_target == StageName.WHITEBOX_TEST

    def _adjudicate_to_blackbox(self) -> bool:
        return self._adjudicate_target == StageName.BLACKBOX_TEST

    def _adjudicate_to_finish(self) -> bool:
        return self._adjudicate_target == StageName.FINISH

    def _on_state_changed(self) -> None:
        if self._machine is None:
            return
        new_state = self._machine.get_state(self.state)
        try:
            self.instance.current_stage = StageName(new_state.value)
        except ValueError:
            if new_state.value == "completed":
                self.instance.status = WorkflowStatus.COMPLETED
            elif new_state.value == "failed":
                self.instance.status = WorkflowStatus.FAILED

        logger.info("State changed to: %s", new_state.value)
        self._persist_state()

    def set_verdict(self, verdict: Verdict, issue_category: str | None = None) -> None:
        self._last_verdict = verdict
        self._last_issue_category = issue_category
        logger.info(
            "Verdict set: verdict=%s, category=%s, stage=%s",
            verdict.value, issue_category, self.instance.current_stage.value,
        )

    def set_tasks_complete(self, complete: bool) -> None:
        self._all_tasks_complete = complete
        logger.info("Tasks complete flag set to: %s", complete)

    def set_skip_review_after_implement(self, skip: bool) -> None:
        self._skip_review_after_implement_flag = skip
        logger.info("Skip review after implement flag set to: %s", skip)

    def set_adjudicate_target(self, target: StageName) -> None:
        self._adjudicate_target = target
        logger.info("Adjudicate target set to: %s", target.value)

    def get_retry_count(self, stage_name: str) -> int:
        return self.instance.retry_counts.get(stage_name, 0)

    def increment_retry(self, stage_name: str) -> int:
        current = self.instance.retry_counts.get(stage_name, 0)
        self.instance.retry_counts[stage_name] = current + 1
        logger.warning("Retry incremented for %s: %d/%d", stage_name, current + 1, self.instance.max_retries)
        return current + 1

    def retries_exhausted(self, stage_name: str) -> bool:
        return self.get_retry_count(stage_name) >= self.instance.max_retries

    def add_stage_execution(self, execution: StageExecution) -> None:
        self.instance.stage_executions.append(execution)
        self.instance.updated_at = datetime.now()
        logger.info(
            "Stage execution recorded: %s (status=%s, attempt=%d)",
            execution.stage_name.value,
            execution.status.value,
            execution.retry_attempt,
        )

    def _persist_state(self) -> None:
        if self.instance.project_path is None:
            return
        state_dir = get_run_state_dir(self.instance.project_path, self.instance.run_id)
        state_path = state_dir / "state.json"
        stage_history_path = state_dir / "stage-history.json"
        state_path.parent.mkdir(parents=True, exist_ok=True)
        self.instance.updated_at = datetime.now()
        state_path.write_text(self.instance.model_dump_json(indent=2), encoding="utf-8")
        stage_history_path.write_text(
            json.dumps(
                [execution.model_dump(mode="json") for execution in self.instance.stage_executions],
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def persist(self) -> None:
        self._persist_state()

    def save_progress(self, progress: ProgressArtifact) -> None:
        if self.instance.project_path is None:
            return
        state_dir = get_run_state_dir(self.instance.project_path, self.instance.run_id)
        progress_path = state_dir / "progress.json"
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        progress_path.write_text(progress.model_dump_json(indent=2), encoding="utf-8")


def restore_engine(state_path: Path, config: Any = None) -> WorkflowEngine:
    if not state_path.exists():
        raise FileNotFoundError(f"No state file found at {state_path}")

    instance = WorkflowInstance.model_validate_json(state_path.read_text(encoding="utf-8"))
    engine = WorkflowEngine(instance, config)
    engine.start()
    return engine
