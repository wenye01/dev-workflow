"""Helpers for persisting workflow issues and issue-backed implementation tasks."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

from scripts.models import (
    Issue,
    IssueStatus,
    ReviewFeedback,
    StageName,
    TaskStatus,
    TrackedIssue,
    Verdict,
)


def _now() -> datetime:
    return datetime.now()


def issue_fingerprint(source_stage: StageName, issue: Issue) -> str:
    """Build a stable fingerprint so repeated findings reopen the same issue."""
    raw = "||".join([
        source_stage.value,
        issue.category or "",
        issue.location or "",
        issue.description.strip(),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def load_tracked_issues(path: Path) -> list[TrackedIssue]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [TrackedIssue.model_validate(item) for item in data]


def save_tracked_issues(path: Path, issues: list[TrackedIssue]) -> None:
    path.write_text(
        json.dumps([issue.model_dump(mode="json") for issue in issues], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def sync_feedback_issues(
    issues_path: Path,
    source_stage: StageName,
    feedback: ReviewFeedback,
) -> list[TrackedIssue]:
    """Upsert issues from a stage result into issues.json while preserving closed decisions."""
    tracked = load_tracked_issues(issues_path)
    by_fingerprint = {issue.fingerprint: issue for issue in tracked}
    updated: list[TrackedIssue] = []
    now = _now()

    for issue in feedback.issues:
        fingerprint = issue_fingerprint(source_stage, issue)
        existing = by_fingerprint.get(fingerprint)
        if existing is None:
            existing = TrackedIssue(
                fingerprint=fingerprint,
                source_stage=source_stage,
                severity=issue.severity,
                category=issue.category,
                description=issue.description,
                location=issue.location,
                suggested_fix=issue.suggested_fix,
                relation=issue.relation,
                continuation_reason=issue.continuation_reason,
                status=IssueStatus.OPEN,
                last_seen_at=now,
            )
            tracked.append(existing)
            by_fingerprint[fingerprint] = existing
        else:
            existing.severity = issue.severity
            existing.category = issue.category
            existing.description = issue.description
            existing.location = issue.location
            existing.suggested_fix = issue.suggested_fix
            existing.relation = issue.relation
            existing.continuation_reason = issue.continuation_reason
            existing.last_seen_at = now
            if existing.status not in (IssueStatus.CLOSED, IssueStatus.REJECTED):
                existing.closed_at = None
        updated.append(existing)

    save_tracked_issues(issues_path, tracked)
    return updated


def close_validated_issues(issues_path: Path, source_stage: StageName) -> list[TrackedIssue]:
    """Close previously implemented/accepted issues once the source stage passes."""
    tracked = load_tracked_issues(issues_path)
    now = _now()
    changed: list[TrackedIssue] = []
    for issue in tracked:
        if (
            issue.source_stage == source_stage
            and issue.status in (IssueStatus.ACCEPTED, IssueStatus.IMPLEMENTED, IssueStatus.OPEN)
        ):
            issue.status = IssueStatus.CLOSED
            issue.closed_at = now
            if not issue.resolution_notes:
                issue.resolution_notes = f"Validated by {source_stage.value}"
            changed.append(issue)
    if changed:
        save_tracked_issues(issues_path, tracked)
    return changed


def load_tasks(tasks_path: Path) -> list[dict]:
    if not tasks_path.exists():
        return []
    return json.loads(tasks_path.read_text(encoding="utf-8"))


def save_tasks(tasks_path: Path, tasks: list[dict]) -> None:
    tasks_path.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), encoding="utf-8")


def ensure_issue_task(
    tasks_path: Path,
    tracked_issue: TrackedIssue,
    title: str,
    description: str,
) -> str:
    """Create or reopen a task tied to a tracked issue and return its task id."""
    tasks = load_tasks(tasks_path)
    for task in tasks:
        linked = task.get("linked_issue_ids", [])
        if tracked_issue.id in linked:
            if task.get("status") in (TaskStatus.COMPLETED.value, TaskStatus.BLOCKED.value):
                task["status"] = TaskStatus.PENDING.value
            task["title"] = title
            task["description"] = description
            save_tasks(tasks_path, tasks)
            return task["id"]

    task_id = f"fix-{len(tasks) + 1}"
    tasks.append({
        "id": task_id,
        "title": title,
        "description": description,
        "status": TaskStatus.PENDING.value,
        "priority": len(tasks),
        "linked_issue_ids": [tracked_issue.id],
        "source_stage": tracked_issue.source_stage.value,
        "acceptance_criteria": [
            f"Close tracked issue {tracked_issue.id}",
            f"Address {tracked_issue.source_stage.value} finding at {tracked_issue.location or 'reported location'}",
        ],
    })
    save_tasks(tasks_path, tasks)
    return task_id


def mark_task_completed(tasks_path: Path, task_id: str) -> list[str]:
    """Mark the selected task completed and return its linked issue ids."""
    tasks = load_tasks(tasks_path)
    linked_issue_ids: list[str] = []
    for task in tasks:
        if task.get("id") == task_id:
            task["status"] = TaskStatus.COMPLETED.value
            linked_issue_ids = list(task.get("linked_issue_ids", []))
            break
    save_tasks(tasks_path, tasks)
    return linked_issue_ids


def pending_or_in_progress_tasks(tasks_path: Path) -> list[dict]:
    tasks = load_tasks(tasks_path)
    return [
        task for task in tasks
        if task.get("status") in (TaskStatus.PENDING.value, TaskStatus.IN_PROGRESS.value)
    ]


def mark_issues_status(
    issues_path: Path,
    issue_ids: list[str],
    status: IssueStatus,
    resolution_notes: str = "",
    task_id: str | None = None,
) -> None:
    tracked = load_tracked_issues(issues_path)
    now = _now()
    changed = False
    for issue in tracked:
        if issue.id in issue_ids:
            issue.status = status
            issue.last_seen_at = now
            if resolution_notes:
                issue.resolution_notes = resolution_notes
            if task_id is not None:
                issue.task_id = task_id
            if status in (IssueStatus.CLOSED, IssueStatus.REJECTED):
                issue.closed_at = now
            changed = True
    if changed:
        save_tracked_issues(issues_path, tracked)


def build_feedback_from_tracked_issues(tracked_issues: list[TrackedIssue]) -> ReviewFeedback:
    return ReviewFeedback(
        verdict=Verdict.FAIL,
        issues=[
            Issue(
                id=tracked.id,
                severity=tracked.severity,
                category=tracked.category,
                description=tracked.description,
                location=tracked.location,
                suggested_fix=tracked.suggested_fix,
                relation=tracked.relation,
                continuation_reason=tracked.continuation_reason,
            )
            for tracked in tracked_issues
        ],
        summary="Tracked issues to address",
    )


def get_tracked_issues_by_ids(issues_path: Path, issue_ids: list[str]) -> list[TrackedIssue]:
    tracked = load_tracked_issues(issues_path)
    wanted = set(issue_ids)
    return [issue for issue in tracked if issue.id in wanted]
