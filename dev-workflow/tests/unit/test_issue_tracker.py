"""Tests for issue tracking and task closure."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from scripts.issue_tracker import (
    ensure_issue_task,
    load_tracked_issues,
    mark_issues_status,
    mark_task_completed,
    sync_feedback_issues,
)
from scripts.models import Issue, IssueStatus, ReviewFeedback, Severity, StageName, Verdict


class TestIssueTracker:
    def test_sync_feedback_reopens_same_issue(self):
        with tempfile.TemporaryDirectory() as tmp:
            issues_path = Path(tmp) / "issues.json"
            feedback = ReviewFeedback(
                verdict=Verdict.FAIL,
                issues=[
                    Issue(
                        severity=Severity.CRITICAL,
                        category="correctness",
                        description="Broken flow",
                        location="game.js:1",
                    ),
                ],
            )
            first = sync_feedback_issues(issues_path, StageName.BLACKBOX_TEST, feedback)
            second = sync_feedback_issues(issues_path, StageName.BLACKBOX_TEST, feedback)
            assert first[0].id == second[0].id
            assert len(load_tracked_issues(issues_path)) == 1

    def test_ensure_issue_task_and_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            issues_path = Path(tmp) / "issues.json"
            tasks_path = Path(tmp) / "tasks.json"
            tasks_path.write_text("[]", encoding="utf-8")
            tracked = sync_feedback_issues(
                issues_path,
                StageName.REVIEW,
                ReviewFeedback(
                    verdict=Verdict.FAIL,
                    issues=[
                        Issue(
                            severity=Severity.MAJOR,
                            category="correctness",
                            description="Need fix",
                            location="main.py:2",
                        ),
                    ],
                ),
            )[0]
            task_id = ensure_issue_task(tasks_path, tracked, "Fix it", "Implement the fix")
            tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
            assert tasks[0]["linked_issue_ids"] == [tracked.id]
            assert mark_task_completed(tasks_path, task_id) == [tracked.id]
            tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
            assert tasks[0]["status"] == "completed"

    def test_sync_feedback_preserves_rejected_issue_decision(self):
        with tempfile.TemporaryDirectory() as tmp:
            issues_path = Path(tmp) / "issues.json"
            feedback = ReviewFeedback(
                verdict=Verdict.FAIL,
                issues=[
                    Issue(
                        severity=Severity.MAJOR,
                        category="correctness",
                        description="Already adjudicated",
                        location="main.py:1",
                    ),
                ],
            )
            issue = sync_feedback_issues(issues_path, StageName.REVIEW, feedback)[0]
            mark_issues_status(
                issues_path,
                [issue.id],
                IssueStatus.REJECTED,
                resolution_notes="Non-blocking duplicate",
            )

            repeated = sync_feedback_issues(issues_path, StageName.REVIEW, feedback)[0]

            assert repeated.id == issue.id
            assert repeated.status == IssueStatus.REJECTED
            assert repeated.resolution_notes == "Non-blocking duplicate"
