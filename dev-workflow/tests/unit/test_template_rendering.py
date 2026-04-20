"""Tests for template-based prompt rendering."""

from __future__ import annotations

from pathlib import Path

import pytest

from context.builder import _SafeDict, _TEMPLATES_DIR, get_template_path, render_template
from scripts.models import StageExecution, StageName, StageStatus


class TestSafeDict:
    def test_present_key(self):
        assert _SafeDict({"name": "Alice"})["name"] == "Alice"

    def test_missing_key_returns_empty(self):
        assert _SafeDict({"name": "Alice"})["missing"] == ""

    def test_format_map_no_error_on_missing(self):
        assert "Hello Alice, you live in ." == "Hello {name}, you live in {city}.".format_map(
            _SafeDict({"name": "Alice"}),
        )


class TestRenderTemplate:
    def test_implement_template_renders(self):
        result = render_template(StageName.IMPLEMENT, {
            "spec_content": "# My Spec",
            "task_definition": "**Fix bug**",
            "progress_summary": "{}",
            "worktree_path": "/tmp/worktree",
            "retry_hint": "",
            "feedback": "",
        })
        lower = result.lower()
        assert "当前任务" in result
        assert "编译" in result
        assert "启动" in result
        assert "测试" in result
        assert "subagent" in lower

    def test_review_template_renders(self):
        result = render_template(StageName.REVIEW, {
            "spec_content": "# Spec",
            "git_changes": "diff --git a/main.py",
            "feedback": "",
        })
        assert "diff --git" in result
        assert "verdict" in result

    def test_adjudicate_template_renders(self):
        result = render_template(StageName.ADJUDICATE, {
            "spec_content": "# Spec",
            "source_stage": "blackbox_test",
            "issues_text": "- issue_id=123",
            "feedback": "",
        })
        assert "blackbox_test" in result
        assert "issue_id=123" in result

    def test_whitebox_test_template_renders(self):
        result = render_template(StageName.WHITEBOX_TEST, {
            "spec_content": "# Spec",
            "file_refs": "- `src/main.py`",
            "test_patterns": "pytest",
            "feedback": "",
        })
        assert "src/main.py" in result
        assert "verdict" in result

    def test_blackbox_test_template_renders(self):
        result = render_template(StageName.BLACKBOX_TEST, {
            "spec_content": "# Spec",
            "app_access_info": "Open index.html",
            "feedback": "",
        })
        assert "Open index.html" in result
        assert "verdict" in result

    def test_template_files_exist(self):
        for stage, filename in [
            (StageName.IMPLEMENT, "implement-prompt.md"),
            (StageName.REVIEW, "review-prompt.md"),
            (StageName.ADJUDICATE, "adjudicate-prompt.md"),
            (StageName.WHITEBOX_TEST, "whitebox-test-prompt.md"),
            (StageName.BLACKBOX_TEST, "blackbox-test-prompt.md"),
        ]:
            assert (_TEMPLATES_DIR / filename).exists(), f"Template missing for {stage.value}"

    def test_invalid_stage_raises(self):
        with pytest.raises(ValueError, match="No template"):
            render_template(StageName.BOOTSTRAP, {})

    def test_get_template_path(self):
        assert get_template_path(StageName.REVIEW).name == "review-prompt.md"
        assert get_template_path(StageName.BOOTSTRAP) is None


class TestStagePromptIntegration:
    def test_implement_stage_prompt_contains_feedback(self):
        from stages.implement import ImplementStage
        from scripts.models import StageContext

        stage = ImplementStage()
        ctx = StageContext(
            workflow_id="test",
            run_id="testrun",
            spec_path=Path("/nonexistent/spec.md"),
            project_path=Path("/tmp/project"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.IMPLEMENT,
        )
        prompt = stage._build_task_prompt({
            "id": "T1",
            "title": "Fix issue",
            "description": "Do it",
            "acceptance_criteria": ["Works"],
        }, ctx)
        assert "Fix issue" in prompt

    def test_review_stage_prompt_contains_role(self):
        from stages.review import ReviewStage
        from scripts.models import StageContext

        prompt = ReviewStage()._build_review_prompt(StageContext(
            workflow_id="test",
            spec_path=Path("/nonexistent/spec.md"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.REVIEW,
        ))
        assert "verdict" in prompt

    def test_adjudicate_stage_prompt_contains_role(self):
        from stages.adjudicate import AdjudicateStage
        from scripts.models import StageContext

        prompt = AdjudicateStage()._build_prompt(
            StageContext(
                workflow_id="test",
                spec_path=Path("/nonexistent/spec.md"),
                worktree_path=Path("/nonexistent/worktree"),
                current_stage=StageName.ADJUDICATE,
                stage_history=[
                    StageExecution(
                        workflow_id="test",
                        stage_name=StageName.BLACKBOX_TEST,
                        status=StageStatus.FAILED,
                        agent_result_path=Path("/tmp/test-result.json"),
                    ),
                ],
            ),
            StageName.BLACKBOX_TEST,
            [],
        )
        assert "blackbox_test" in prompt

    def test_whitebox_stage_prompt_contains_role(self):
        from stages.whitebox_test import WhiteboxTestStage
        from scripts.models import StageContext

        prompt = WhiteboxTestStage()._build_test_prompt(StageContext(
            workflow_id="test",
            spec_path=Path("/nonexistent/spec.md"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.WHITEBOX_TEST,
        ))
        assert "verdict" in prompt

    def test_blackbox_stage_prompt_contains_role(self):
        from stages.blackbox_test import BlackboxTestStage
        from scripts.models import StageContext

        prompt = BlackboxTestStage()._build_test_prompt(StageContext(
            workflow_id="test",
            spec_path=Path("/nonexistent/spec.md"),
            worktree_path=Path("/nonexistent/worktree"),
            current_stage=StageName.BLACKBOX_TEST,
        ))
        assert "verdict" in prompt
