"""Data models for the multi-agent development workflow orchestrator."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, computed_field


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now()


def _today_str() -> str:
    return datetime.now().strftime("%Y%m%d")


# --- Enumerations ---


class StageName(str, Enum):
    BOOTSTRAP = "bootstrap"
    IMPLEMENT = "implement"
    REVIEW = "review"
    ADJUDICATE = "adjudicate"
    WHITEBOX_TEST = "whitebox_test"
    BLACKBOX_TEST = "blackbox_test"
    FINISH = "finish"


class WorkflowStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"


class StageStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"


class TaskStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"


class Verdict(str, Enum):
    PASS = "pass"
    FAIL = "fail"


class Severity(str, Enum):
    CRITICAL = "critical"
    MAJOR = "major"
    MINOR = "minor"
    SUGGESTION = "suggestion"


class IssueStatus(str, Enum):
    OPEN = "open"
    ACCEPTED = "accepted"
    IMPLEMENTED = "implemented"
    CLOSED = "closed"
    REJECTED = "rejected"


# --- Entities ---


class Task(BaseModel):
    """A single implementation task decomposed from the specification."""

    id: str = Field(default_factory=_uuid)
    spec_id: str = ""
    title: str
    description: str
    priority: int = 0
    status: TaskStatus = TaskStatus.PENDING
    dependencies: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    linked_issue_ids: list[str] = Field(default_factory=list)
    source_stage: StageName | None = None


class WorkflowSpec(BaseModel):
    """The structured specification document generated from user requirements."""

    id: str = Field(default_factory=_uuid)
    source_requirement: str
    created_at: datetime = Field(default_factory=_now)
    spec_path: Path = Path(".")
    tasks: list[Task] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)


class Issue(BaseModel):
    """A specific problem discovered during review or testing."""

    id: str = Field(default_factory=_uuid)
    feedback_id: str = ""
    severity: Severity
    category: str
    description: str
    location: str = ""
    suggested_fix: str = ""
    rollback_target: StageName | None = None


class ReviewFeedback(BaseModel):
    """Assessment result from Review or Test stages."""

    id: str = Field(default_factory=_uuid)
    stage_execution_id: str = ""
    verdict: Verdict
    issues: list[Issue] = Field(default_factory=list)
    summary: str = ""
    reviewed_at: datetime = Field(default_factory=_now)


class TrackedIssue(BaseModel):
    """Lifecycle record for a discovered issue across stages."""

    id: str = Field(default_factory=_uuid)
    fingerprint: str = ""
    source_stage: StageName
    severity: Severity
    category: str
    description: str
    location: str = ""
    suggested_fix: str = ""
    status: IssueStatus = IssueStatus.OPEN
    task_id: str | None = None
    resolution_notes: str = ""
    first_seen_at: datetime = Field(default_factory=_now)
    last_seen_at: datetime = Field(default_factory=_now)
    closed_at: datetime | None = None


class StageExecution(BaseModel):
    """A single execution record for one stage."""

    id: str = Field(default_factory=_uuid)
    workflow_id: str = ""
    stage_name: StageName
    status: StageStatus = StageStatus.PENDING
    started_at: datetime | None = None
    completed_at: datetime | None = None
    agent_result_path: Path | None = None
    feedback: ReviewFeedback | None = None
    retry_attempt: int = 0


class ProgressArtifact(BaseModel):
    """Structured progress tracking file in the worktree."""

    workflow_id: str = ""
    completed_tasks: list[str] = Field(default_factory=list)
    current_task: str | None = None
    blocked_reason: str | None = None
    git_commits: list[str] = Field(default_factory=list)
    last_updated: datetime = Field(default_factory=_now)
    last_attempt_summary: str | None = None


class WorkflowInstance(BaseModel):
    """A single complete workflow execution."""

    id: str = Field(default_factory=_uuid)
    slug: str = ""
    spec: WorkflowSpec | None = None
    status: WorkflowStatus = WorkflowStatus.PENDING
    current_stage: StageName = StageName.BOOTSTRAP
    project_path: Path | None = None
    worktree_path: Path | None = None
    branch_name: str = ""
    pr_url: str | None = None
    stage_executions: list[StageExecution] = Field(default_factory=list)
    retry_counts: dict[str, int] = Field(default_factory=dict)
    max_retries: int = 3
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

    @computed_field
    @property
    def run_id(self) -> str:
        """Human-readable identifier: {YYYYMMDD}-{slug}."""
        date_str = self.created_at.strftime("%Y%m%d") if self.created_at else _today_str()
        return f"{date_str}-{self.slug}" if self.slug else self.id[:8]


class AgentContext(BaseModel):
    """Curated information set assembled for a specific agent invocation."""

    stage_name: StageName
    spec_content: str = ""
    project_context: dict[str, str] = Field(default_factory=dict)
    git_history: str = ""
    progress_summary: str = ""
    stage_specific_context: dict[str, Any] = Field(default_factory=dict)
    # Must-inject context from .dev-workflow/
    commands_context: str = ""
    custom_context: str = ""
    reference_index: str = ""


# --- Stage types ---


class StageContext(BaseModel):
    """Input context for stage execution."""

    workflow_id: str
    run_id: str = ""
    spec_path: Path
    project_path: Path = Path(".")
    worktree_path: Path
    current_stage: StageName
    retry_count: int = 0
    stage_history: list[StageExecution] = Field(default_factory=list)
    agent_context: AgentContext | None = None


class StageConfig(BaseModel):
    """Per-stage configuration."""

    timeout_seconds: int = 600
    agent_backend: str = "claude"
    agent_model: str | None = None


class ValidationResult(BaseModel):
    """Result of stage input validation."""

    is_valid: bool
    errors: list[str] = Field(default_factory=list)


class StageOutput(BaseModel):
    """Result of stage execution."""

    stage_name: StageName
    verdict: Verdict | None = None
    result_path: Path | None = None
    artifacts: dict[str, Path] = Field(default_factory=dict)
    error_message: str | None = None
    output_data: dict[str, Any] = Field(default_factory=dict)


class AgentResult(BaseModel):
    """Result from agent backend invocation."""

    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    parsed_output: dict[str, Any] | None = None


# --- Path helpers ---


def get_run_state_dir(project_path: Path, run_id: str) -> Path:
    """Get the runtime state directory for a workflow under .dev-workflow/run/."""
    return project_path / ".dev-workflow" / "run" / run_id
