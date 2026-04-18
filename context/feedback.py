"""Feedback injection: issue filtering, structuring, retry context assembly."""

from __future__ import annotations

from scripts.models import (
    Issue,
    ReviewFeedback,
    Severity,
)


def filter_issues(
    feedback: ReviewFeedback,
    include_severities: set[Severity] | None = None,
) -> list[Issue]:
    """Filter issues by severity for feedback injection.

    Default: include critical + major only (per context-contract.md).
    Minor and suggestion are logged but not injected into retry context.
    """
    if include_severities is None:
        include_severities = {Severity.CRITICAL, Severity.MAJOR}

    return [i for i in feedback.issues if i.severity in include_severities]


def structure_issue(issue: Issue) -> str:
    """Format a single issue as XML per context-contract.md Feedback Injection Step 2."""
    sev = issue.severity.value
    cat = issue.category
    lines = [
        '<issue severity="' + sev + '" category="' + cat + '">',
        "  <location>" + issue.location + "</location>",
        "  <description>" + issue.description + "</description>",
        "  <suggested_fix>" + issue.suggested_fix + "</suggested_fix>",
        "</issue>",
    ]
    return "\n".join(lines)


def build_feedback_section(
    feedback: ReviewFeedback,
    previous_attempt_summary: str,
    git_diff: str = "",
) -> str:
    """Build the <feedback> XML section for retry prompt injection.

    Implements Steps 1-3 of the Feedback Injection Protocol from context-contract.md.
    """
    filtered = filter_issues(feedback)
    if not filtered:
        return ""

    critical_count = sum(1 for i in filtered if i.severity == Severity.CRITICAL)
    major_count = sum(1 for i in filtered if i.severity == Severity.MAJOR)

    issues_xml = "\n".join(structure_issue(i) for i in filtered)

    parts = [
        "<feedback>",
        "The previous attempt was reviewed and found "
        + str(critical_count)
        + " critical and "
        + str(major_count)
        + " major issues.",
        "",
        "<previous_attempt>",
        previous_attempt_summary,
        "</previous_attempt>",
    ]

    if git_diff:
        parts.extend([
            "",
            "<changes_tried>",
            git_diff,
            "</changes_tried>",
        ])

    parts.extend([
        "",
        "<issues_to_fix>",
        issues_xml,
        "</issues_to_fix>",
        "",
        "Focus on addressing the issues above. Do not rewrite unrelated code.",
        "</feedback>",
    ])

    return "\n".join(parts)


def get_feedback_category(feedback: ReviewFeedback) -> str:
    """Determine the primary issue category from feedback for routing decisions.

    Returns the category of the highest-severity issue, or "code_quality" as default.
    """
    if not feedback.issues:
        return "code_quality"

    severity_order = {
        Severity.CRITICAL: 0, Severity.MAJOR: 1,
        Severity.MINOR: 2, Severity.SUGGESTION: 3,
    }
    sorted_issues = sorted(feedback.issues, key=lambda i: severity_order.get(i.severity, 99))

    return sorted_issues[0].category or "code_quality"
