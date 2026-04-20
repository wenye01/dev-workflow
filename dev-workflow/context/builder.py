"""Template-based prompt rendering and project context loading for agent invocation."""

from __future__ import annotations

from pathlib import Path

from scripts.models import StageName

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
