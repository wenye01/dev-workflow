"""Tests for template-based prompt rendering."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from context.builder import _SafeDict, render_template, get_template_path, _TEMPLATES_DIR
from scripts.models import StageName


# ============================================================
# _SafeDict tests
# ============================================================


class TestSafeDict:
    """Tests for the _SafeDict that tolerates missing keys."""

    def test_present_key(self):
        d = _SafeDict({"name": "Alice"})
        assert d["name"] == "Alice"

    def test_missing_key_returns_empty(self):
        d = _SafeDict({"name": "Alice"})
        assert d["missing"] == ""

    def test_format_map_no_error_on_missing(self):
        template = "Hello {name}, you live in {city}."
        result = template.format_map(_SafeDict({"name": "Alice"}))
        assert result == "Hello Alice, you live in ."

    def test_format_map_all_present(self):
        template = "{a} + {b} = {c}"
        result = template.format_map(_SafeDict({"a": "1", "b": "2", "c": "3"}))
        assert result == "1 + 2 = 3"


# ============================================================
# render_template tests
# ============================================================


class TestRenderTemplate:
    """Tests for the render_template function."""

    def test_implement_template_renders(self):
        result = render_template(StageName.IMPLEMENT, {
            "spec_content": "# My Spec\nSome details",
            "task_definition": "**Fix bug**\nFix the null pointer",
            "progress_summary": '{"completed_tasks": []}',
            "worktree_path": "/tmp/worktree",
            "retry_hint": "",
            "feedback": "",
        })
        assert "实现Agent" in result
        assert "My Spec" in result
        assert "Fix bug" in result
        assert "/tmp/worktree" in result

    def test_implement_template_with_retry(self):
        result = render_template(StageName.IMPLEMENT, {
            "spec_content": "",
            "task_definition": "Task",
            "progress_summary": "",
            "worktree_path": "/tmp",
            "retry_hint": "\n## 注意\n这是第 3 次尝试。",
            "feedback": "",
        })
        assert "3 次尝试" in result

    def test_implement_template_with_feedback(self):
        feedback_xml = "<feedback>\nIssues found.\n</feedback>"
        result = render_template(StageName.IMPLEMENT, {
            "spec_content": "",
            "task_definition": "Task",
            "progress_summary": "",
            "worktree_path": "/tmp",
            "retry_hint": "",
            "feedback": feedback_xml,
        })
        assert "Issues found" in result

    def test_review_template_renders(self):
        result = render_template(StageName.REVIEW, {
            "spec_content": "# Spec\nAcceptance criteria here",
            "git_changes": "diff --git a/main.py\n+new line",
            "feedback": "",
        })
        assert "审查Agent" in result
        assert "Acceptance criteria" in result
        assert "diff --git" in result
        assert "verdict" in result
        assert "summary" in result
        assert "issues" in result

    def test_whitebox_test_template_renders(self):
        result = render_template(StageName.WHITEBOX_TEST, {
            "spec_content": "# Spec",
            "file_refs": "- `src/main.py`\n- `src/utils.py`",
            "test_patterns": "检测到测试框架: pytest",
            "feedback": "",
        })
        assert "白盒测试Agent" in result
        assert "src/main.py" in result
        assert "pytest" in result
        assert "verdict" in result

    def test_blackbox_test_template_renders(self):
        result = render_template(StageName.BLACKBOX_TEST, {
            "spec_content": "# Spec",
            "app_access_info": "Python 项目，检查 pyproject.toml",
            "feedback": "",
        })
        assert "黑盒测试Agent" in result
        assert "pyproject.toml" in result
        assert "verdict" in result

    def test_missing_variable_leaves_empty(self):
        result = render_template(StageName.REVIEW, {})
        assert "审查Agent" in result
        # No crash, empty sections

    def test_template_files_exist(self):
        """Verify all mapped template files are present on disk."""
        for stage, filename in [
            (StageName.IMPLEMENT, "implement-prompt.md"),
            (StageName.REVIEW, "review-prompt.md"),
            (StageName.WHITEBOX_TEST, "whitebox-test-prompt.md"),
            (StageName.BLACKBOX_TEST, "blackbox-test-prompt.md"),
        ]:
            path = _TEMPLATES_DIR / filename
            assert path.exists(), f"Template missing: {path}"

    def test_invalid_stage_raises(self):
        with pytest.raises(ValueError, match="No template"):
            render_template(StageName.BOOTSTRAP, {})

    def test_get_template_path(self):
        path = get_template_path(StageName.REVIEW)
        assert path is not None
        assert path.name == "review-prompt.md"

    def test_get_template_path_unknown(self):
        path = get_template_path(StageName.BOOTSTRAP)
        assert path is None


# ============================================================
# Template JSON escaping tests
# ============================================================


class TestTemplateJsonEscaping:
    """Verify that output format fields survive format_map."""

    def test_review_output_format_intact(self):
        result = render_template(StageName.REVIEW, {
            "spec_content": "",
            "git_changes": "",
            "feedback": "",
        })
        assert "verdict" in result
        assert "issues" in result
        assert "summary" in result
        assert "schema" in result

    def test_whitebox_output_format_intact(self):
        result = render_template(StageName.WHITEBOX_TEST, {
            "spec_content": "",
            "file_refs": "",
            "test_patterns": "",
            "feedback": "",
        })
        assert "verdict" in result

    def test_blackbox_output_format_intact(self):
        result = render_template(StageName.BLACKBOX_TEST, {
            "spec_content": "",
            "app_access_info": "",
            "feedback": "",
        })
        assert "verdict" in result


# ============================================================
# Integration: stage _build_xxx_prompt uses template
# ============================================================


class TestStagePromptIntegration:
    """Verify stages produce prompts from templates."""

    def test_implement_stage_prompt_contains_role(self):
        from stages.implement import ImplementStage
        from scripts.models import StageContext

        stage = ImplementStage()
        ctx = StageContext(
            workflow_id="test",
            spec_path=Path("/nonexistent/spec.md"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.IMPLEMENT,
        )
        task = {
            "id": "T001",
            "title": "Add feature X",
            "description": "Implement X",
            "acceptance_criteria": ["X works", "X is tested"],
        }
        prompt = stage._build_task_prompt(task, ctx)
        assert "实现Agent" in prompt
        assert "Add feature X" in prompt
        assert "X works" in prompt

    def test_review_stage_prompt_contains_role(self):
        from stages.review import ReviewStage
        from scripts.models import StageContext

        stage = ReviewStage()
        ctx = StageContext(
            workflow_id="test",
            spec_path=Path("/nonexistent/spec.md"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.REVIEW,
        )
        prompt = stage._build_review_prompt(ctx)
        assert "审查Agent" in prompt
        assert "verdict" in prompt

    def test_whitebox_stage_prompt_contains_role(self):
        from stages.whitebox_test import WhiteboxTestStage
        from scripts.models import StageContext

        stage = WhiteboxTestStage()
        ctx = StageContext(
            workflow_id="test",
            spec_path=Path("/nonexistent/spec.md"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.WHITEBOX_TEST,
        )
        prompt = stage._build_test_prompt(ctx)
        assert "白盒测试Agent" in prompt
        assert "verdict" in prompt

    def test_blackbox_stage_prompt_contains_role(self):
        from stages.blackbox_test import BlackboxTestStage
        from scripts.models import StageContext

        stage = BlackboxTestStage()
        ctx = StageContext(
            workflow_id="test",
            spec_path=Path("/nonexistent/spec.md"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.BLACKBOX_TEST,
        )
        prompt = stage._build_test_prompt(ctx)
        assert "黑盒测试Agent" in prompt
        assert "verdict" in prompt
