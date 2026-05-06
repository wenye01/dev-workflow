"""Template-based prompt rendering and project context loading for agent invocation."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from scripts.models import StageContext, StageName

# Templates directory: <project_root>/templates/
_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

# .dev-workflow/ context directory names
_DEV_WORKFLOW_DIR = ".dev-workflow"
_DOCS_DIR = "docs"
_CUSTOM_DIR = "custom"
_REFERENCES_DIR = "references"

# Map stage name to template filename
_STAGE_TEMPLATE_MAP: dict[StageName, str] = {
    StageName.IMPLEMENT: "implement-prompt.md",
    StageName.REVIEW: "review-prompt.md",
    StageName.ADJUDICATE: "adjudicate-prompt.md",
    StageName.WHITEBOX_TEST: "whitebox-test-prompt.md",
    StageName.BLACKBOX_TEST: "blackbox-test-prompt.md",
}


class _SafeDict(dict):
    """Dict subclass that returns the key placeholder itself when a key is missing.

    This prevents KeyError / ValueError during str.format_map() when a template
    contains a placeholder that the caller did not provide — it simply leaves the
    placeholder text as-is instead of crashing.
    """

    def __missing__(self, key: str) -> str:
        return ""


def render_template(stage_name: StageName, variables: dict[str, str]) -> str:
    """Load the template for *stage_name* and substitute {variables}.

    Args:
        stage_name: Which stage's template to render.
        variables: Mapping of placeholder name → replacement text.

    Returns:
        The rendered prompt string ready to pass to an agent backend.

    Raises:
        FileNotFoundError: If the template file does not exist.
    """
    filename = _STAGE_TEMPLATE_MAP.get(stage_name)
    if filename is None:
        raise ValueError(f"No template registered for stage: {stage_name}")

    template_path = _TEMPLATES_DIR / filename
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")

    template = template_path.read_text(encoding="utf-8")
    return template.format_map(_SafeDict(variables))


def get_template_path(stage_name: StageName) -> Path | None:
    """Return the template file path for a stage, or None if not registered."""
    filename = _STAGE_TEMPLATE_MAP.get(stage_name)
    if filename is None:
        return None
    return _TEMPLATES_DIR / filename


def load_project_context(worktree_path: Path) -> dict[str, str]:
    """Load .dev-workflow/ must-inject files and build index section.

    Reads the hybrid context structure:
    - Must-inject: project.md, commands.md, custom/*.md (content loaded)
    - Index-only: INDEX.md (content loaded as pointers), references/ (NOT loaded)

    Args:
        worktree_path: Path to the worktree root containing .dev-workflow/.

    Returns:
        dict with keys:
        - 'project_context': project.md content (must-inject)
        - 'commands_context': commands.md content (must-inject)
        - 'custom_context': concatenated custom/*.md content (must-inject)
        - 'reference_index': INDEX.md content (index-only pointers)
    """
    dw_dir = worktree_path / _DEV_WORKFLOW_DIR
    result: dict[str, str] = {
        "project_context": "",
        "commands_context": "",
        "custom_context": "",
        "reference_index": "",
    }

    if not dw_dir.exists():
        return result

    # Context files live under .dev-workflow/docs/
    docs_dir = dw_dir / _DOCS_DIR

    # Must-inject: project.md
    project_md = docs_dir / "project.md"
    if project_md.exists():
        result["project_context"] = project_md.read_text(encoding="utf-8").strip()

    # Must-inject: commands.md
    commands_md = docs_dir / "commands.md"
    if commands_md.exists():
        result["commands_context"] = commands_md.read_text(encoding="utf-8").strip()

    # Must-inject: custom/*.md (user-owned, all files concatenated)
    custom_dir = docs_dir / _CUSTOM_DIR
    if custom_dir.is_dir():
        custom_parts: list[str] = []
        for md_file in sorted(custom_dir.glob("*.md")):
            content = md_file.read_text(encoding="utf-8").strip()
            if content:
                custom_parts.append(content)
        if custom_parts:
            result["custom_context"] = "\n\n---\n\n".join(custom_parts)

    # Index-only: INDEX.md (pointers for agent to follow on demand)
    index_md = docs_dir / "INDEX.md"
    if index_md.exists():
        result["reference_index"] = index_md.read_text(encoding="utf-8").strip()

    return result


def build_common_context(context: StageContext, spec_content: str | None = None) -> str:
    """Build workflow context that must remain visible across feedback loops."""
    project_ctx = load_project_context(context.worktree_path)
    spec_text = spec_content
    if spec_text is None and context.spec_path.exists():
        spec_text = context.spec_path.read_text(encoding="utf-8")
    spec_text = (spec_text or "").strip()

    branch = _git_output(context.worktree_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    head = _git_output(context.worktree_path, ["rev-parse", "--short", "HEAD"])

    parts = [
        "## Common Workflow Goal",
        (
            "The goal of this loop is not to prove there are zero bugs. The goal is to make "
            "the requested business capability usable and to satisfy the spec acceptance "
            "criteria with a maintainable implementation."
        ),
        "",
        "## Spec Goal",
        _clip(spec_text, 6000) or "(No spec content available.)",
        "",
        "## Project Operating Context",
        f"- worktree_path: {context.worktree_path}",
        f"- current_branch: {branch or '(unknown)'}",
        f"- current_head: {head or '(unknown)'}",
    ]

    if project_ctx.get("project_context"):
        parts.extend(["", "### Project Context", project_ctx["project_context"]])
    if project_ctx.get("commands_context"):
        parts.extend(["", "### Commands", project_ctx["commands_context"]])
    if project_ctx.get("custom_context"):
        parts.extend(["", "### Custom Context", project_ctx["custom_context"]])
    if project_ctx.get("reference_index"):
        parts.extend(["", "### Reference Index", project_ctx["reference_index"]])

    parts.extend([
        "",
        "## Quality Bar",
        "- Must compile, load, or start according to the project commands.",
        "- Must satisfy the spec acceptance criteria.",
        "- Must not introduce critical correctness, security, or data-loss issues on the relevant business path.",
        "- Should avoid unnecessary churn outside the task scope.",
    ])
    return "\n".join(parts).strip()


def build_feedback_chain(context: StageContext) -> str:
    """Build a stable issue/task/progress summary for loop continuity."""
    state_dir = _state_dir(context)
    issues = _read_json(state_dir / "issues.json", [])
    tasks = _read_json(state_dir / "tasks.json", [])
    progress = _read_json(state_dir / "progress.json", {})
    history = _read_json(state_dir / "stage-history.json", [])

    task_by_id = {task.get("id"): task for task in tasks if isinstance(task, dict)}
    task_commits = progress.get("task_commits", []) if isinstance(progress, dict) else []
    commit_by_task = {
        item.get("task_id"): item
        for item in task_commits
        if isinstance(item, dict) and item.get("task_id")
    }

    sections = [
        "## Feedback Chain",
        "",
        "Current review obligation:",
        "- Check whether accepted or implemented issues were fixed.",
        "- Review the resulting implementation for correctness and regressions.",
        "- New issues are allowed only when they are necessary to prevent the business capability from being incorrect, unsafe, unusable, or materially incomplete.",
        "- Do not reopen closed or rejected issues unless there is new concrete evidence.",
    ]

    active = [
        issue for issue in issues
        if isinstance(issue, dict) and issue.get("status") in {"open", "accepted", "implemented"}
    ]
    inactive = [
        issue for issue in issues
        if isinstance(issue, dict) and issue.get("status") in {"closed", "rejected"}
    ]

    sections.extend(["", "### Accepted / Implemented / Open Issues"])
    if active:
        for issue in active[:20]:
            sections.append(_format_issue_chain_item(issue, task_by_id, commit_by_task))
    else:
        sections.append("- None recorded.")

    sections.extend(["", "### Rejected or Closed Issues"])
    if inactive:
        for issue in inactive[:20]:
            sections.append(_format_issue_chain_item(issue, task_by_id, commit_by_task))
    else:
        sections.append("- None recorded.")

    sections.extend(["", "### Implementation Response Since Last Review"])
    if task_commits:
        for item in task_commits[-10:]:
            if not isinstance(item, dict):
                continue
            linked = ", ".join(item.get("linked_issue_ids") or []) or "none"
            sections.append(
                "- task_id={task_id}; commit={commit}; linked_issues={linked}; summary={summary}".format(
                    task_id=item.get("task_id", "unknown"),
                    commit=item.get("commit", "unknown"),
                    linked=linked,
                    summary=_clip(str(item.get("summary", "")), 300),
                )
            )
    else:
        sections.append("- None recorded.")

    if isinstance(progress, dict) and progress.get("last_reviewed_commit"):
        sections.extend(["", f"### Last Reviewed Commit\n{progress['last_reviewed_commit']}"])

    recent_history = [
        item for item in history
        if isinstance(item, dict) and item.get("stage_name") in {"implement", "review", "adjudicate"}
    ][-8:]
    sections.extend(["", "### Recent Stage History"])
    if recent_history:
        for item in recent_history:
            sections.append(
                "- stage={stage}; status={status}; result={result}".format(
                    stage=item.get("stage_name", "unknown"),
                    status=item.get("status", "unknown"),
                    result=item.get("agent_result_path") or "none",
                )
            )
    else:
        sections.append("- None recorded.")

    return "\n".join(sections).strip()


def build_scenario_context(
    context: StageContext,
    stage_name: StageName,
    task: dict[str, Any] | None = None,
    source_stage: StageName | None = None,
) -> str:
    """Build stage-specific loop context without replacing common context."""
    kind = determine_scenario_kind(context, stage_name, task)
    lines = ["## Scenario Context", f"- kind: {kind}"]

    if stage_name == StageName.IMPLEMENT:
        linked_issue_ids = list((task or {}).get("linked_issue_ids") or [])
        if linked_issue_ids:
            lines.extend([
                "- This is a bugfix implement task from adjudicated feedback.",
                f"- linked_issue_ids: {', '.join(linked_issue_ids)}",
                "- First respond to the linked issues, then make the smallest required code change.",
                "- Explain any extra changes that are necessary for the linked issue fix.",
            ])
        else:
            lines.extend([
                "- This is an initial implement task from the spec.",
                "- Build the smallest usable implementation that satisfies the requested capability.",
                "- Do not pre-empt hypothetical review issues.",
            ])
        task_commits = _task_commits(context)
        if task_commits:
            lines.append("")
            lines.append("### Existing Task Commits")
            for item in task_commits[-8:]:
                linked = ", ".join(item.get("linked_issue_ids") or []) or "none"
                lines.append(
                    f"- {item.get('task_id', 'unknown')}: {item.get('commit', 'unknown')} "
                    f"(linked issues: {linked})"
                )

    elif stage_name == StageName.REVIEW:
        diff_base = _review_diff_base(context)
        lines.extend([
            "- This review must consume the feedback chain before reporting issues.",
            f"- diff_base: {diff_base or '(initial review fallback)'}",
            "- If accepted issues are fixed and no necessary new issue exists, return pass.",
        ])
        commits = _git_output(context.worktree_path, ["log", "--oneline", "--decorate", "-8"])
        if commits:
            lines.extend(["", "### Recent Commits", commits])

    elif stage_name == StageName.ADJUDICATE:
        lines.extend([
            f"- source_stage: {(source_stage or StageName.REVIEW).value}",
            "- Preserve feedback-chain stability while keeping real blockers actionable.",
            "- Close duplicate, non-blocking, or preference-only findings with a clear rationale.",
        ])

    return "\n".join(lines).strip()


def determine_scenario_kind(
    context: StageContext,
    stage_name: StageName,
    task: dict[str, Any] | None = None,
) -> str:
    if stage_name == StageName.IMPLEMENT:
        return "bugfix_implement" if (task or {}).get("linked_issue_ids") else "initial_implement"
    if stage_name == StageName.REVIEW:
        state_dir = _state_dir(context)
        issues = _read_json(state_dir / "issues.json", [])
        progress = _read_json(state_dir / "progress.json", {})
        has_feedback = bool(issues) or bool(progress.get("last_reviewed_commit")) or any(
            isinstance(item, dict) and item.get("linked_issue_ids")
            for item in progress.get("task_commits", [])
        )
        return "followup_review" if has_feedback else "initial_review"
    if stage_name == StageName.ADJUDICATE:
        return "adjudicate_feedback"
    return stage_name.value


def build_review_diff(context: StageContext, limit: int = 12000) -> str:
    """Get the review diff anchored at last reviewed commit when available."""
    base = _review_diff_base(context)
    commands: list[list[str]] = []
    if base:
        commands.append(["diff", f"{base}..HEAD"])
    commands.extend([
        ["diff", "HEAD~1"],
        ["diff", "--cached"],
        ["diff"],
    ])
    for cmd in commands:
        output = _git_output(context.worktree_path, cmd)
        if output.strip():
            return _clip(output, limit)
    return ""


def mark_reviewed_commit(context: StageContext) -> str:
    """Persist the commit that a passing/failing review just examined."""
    state_dir = _state_dir(context)
    progress_path = state_dir / "progress.json"
    progress = _read_json(progress_path, {})
    if not isinstance(progress, dict):
        progress = {}
    head = _git_output(context.worktree_path, ["rev-parse", "HEAD"])
    if head:
        progress["last_reviewed_commit"] = head.strip()
        progress["last_updated"] = _now_iso()
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        progress_path.write_text(json.dumps(progress, indent=2, ensure_ascii=False), encoding="utf-8")
    return head


def _format_issue_chain_item(
    issue: dict[str, Any],
    task_by_id: dict[str, dict[str, Any]],
    commit_by_task: dict[str, dict[str, Any]],
) -> str:
    task_id = issue.get("task_id") or "none"
    task = task_by_id.get(task_id, {})
    commit_info = commit_by_task.get(task_id, {})
    lines = [
        f"- id={issue.get('id', 'unknown')}",
        f"  status={issue.get('status', 'unknown')}",
        f"  severity={issue.get('severity', 'unknown')}",
        f"  category={issue.get('category', 'unknown')}",
        f"  relation={issue.get('relation', '')}",
        f"  location={issue.get('location', '')}",
        f"  description={_clip(str(issue.get('description', '')), 500)}",
        f"  continuation_reason={_clip(str(issue.get('continuation_reason', '')), 500)}",
        f"  adjudication_rationale={_clip(str(issue.get('resolution_notes', '')), 500)}",
        f"  linked_task_id={task_id}",
    ]
    if task:
        lines.append(f"  task_status={task.get('status', 'unknown')}")
    if commit_info:
        lines.append(f"  task_commit={commit_info.get('commit', 'unknown')}")
        lines.append(f"  implementation_summary={_clip(str(commit_info.get('summary', '')), 300)}")
    return "\n".join(lines)


def _review_diff_base(context: StageContext) -> str:
    progress = _read_json(_state_dir(context) / "progress.json", {})
    if isinstance(progress, dict):
        base = str(progress.get("last_reviewed_commit") or "").strip()
        if base and _git_commit_exists(context.worktree_path, base):
            return base
    return ""


def _task_commits(context: StageContext) -> list[dict[str, Any]]:
    progress = _read_json(_state_dir(context) / "progress.json", {})
    if not isinstance(progress, dict):
        return []
    return [item for item in progress.get("task_commits", []) if isinstance(item, dict)]


def _state_dir(context: StageContext) -> Path:
    from scripts.models import get_run_state_dir

    return get_run_state_dir(context.project_path, context.run_id)


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def _git_output(
    worktree_path: Path,
    args: list[str],
    include_stderr: bool = False,
) -> str:
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
    if result.returncode != 0:
        return result.stderr.strip() if include_stderr else ""
    return result.stdout.strip()


def _git_commit_exists(worktree_path: Path, commit: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "cat-file", "-e", f"{commit}^{{commit}}"],
            cwd=str(worktree_path),
            capture_output=True,
            text=True,
            check=False,
        )
    except (OSError, ValueError):
        return False
    return result.returncode == 0


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n...[truncated]"


def _now_iso() -> str:
    from datetime import datetime

    return datetime.now().isoformat()
