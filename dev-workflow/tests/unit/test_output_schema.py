"""Tests for agent output schema validation (external JSON Schema)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from scripts.models import (
    ReviewFeedback,
    StageContext,
    StageOutput,
    StageName,
    Verdict,
    ValidationResult,
)
from scripts.output_schema import (
    list_schemas,
    validate_agent_output,
    clear_cache,
)
from stages.bootstrap import BootstrapStage
from stages.blackbox_test import BlackboxTestStage
from stages.finish import FinishStage
from stages.implement import ImplementStage
from stages.review import ReviewStage
from stages.whitebox_test import WhiteboxTestStage


# ============================================================
# output_schema.py tests
# ============================================================


class TestValidateAgentOutput:
    """Tests for the validate_agent_output helper."""

    def test_valid_review_output(self):
        raw = {
            "verdict": "pass",
            "summary": "All good",
            "issues": [],
        }
        parsed, errors = validate_agent_output(raw, "review-output")
        assert parsed is not None
        assert errors == []
        assert parsed["verdict"] == "pass"
        assert parsed["summary"] == "All good"

    def test_valid_review_output_with_issues(self):
        raw = {
            "verdict": "fail",
            "summary": "Found issues",
            "issues": [
                {
                    "severity": "critical",
                    "category": "correctness",
                    "description": "Null pointer on line 42",
                    "location": "main.py:42",
                    "suggested_fix": "Add null check",
                },
                {
                    "severity": "minor",
                    "category": "code_quality",
                    "description": "Bad naming",
                    "location": "utils.py:10",
                },
            ],
        }
        parsed, errors = validate_agent_output(raw, "review-output")
        assert parsed is not None
        assert errors == []
        assert parsed["verdict"] == "fail"
        assert len(parsed["issues"]) == 2
        assert parsed["issues"][0]["severity"] == "critical"
        assert parsed["issues"][1]["location"] == "utils.py:10"

    def test_none_input(self):
        parsed, errors = validate_agent_output(None, "review-output")
        assert parsed is None
        assert len(errors) == 1
        assert "no structured output" in errors[0].lower()

    def test_missing_verdict(self):
        raw = {"summary": "No verdict"}
        parsed, errors = validate_agent_output(raw, "review-output")
        assert parsed is None
        assert len(errors) > 0

    def test_invalid_verdict_value(self):
        raw = {"verdict": "maybe", "summary": ""}
        parsed, errors = validate_agent_output(raw, "review-output")
        assert parsed is None
        assert len(errors) > 0

    def test_invalid_severity_in_issue(self):
        raw = {
            "verdict": "fail",
            "issues": [
                {"severity": "blocker", "category": "bug", "description": "test"},
            ],
        }
        parsed, errors = validate_agent_output(raw, "review-output")
        assert parsed is None
        assert len(errors) > 0

    def test_empty_dict(self):
        parsed, errors = validate_agent_output({}, "review-output")
        assert parsed is None
        assert len(errors) > 0

    def test_valid_implement_output(self):
        raw = {
            "completed": True,
            "files_modified": ["src/main.py", "tests/test_main.py"],
            "summary": "Done",
        }
        parsed, errors = validate_agent_output(raw, "implement-output")
        assert parsed is not None
        assert errors == []
        assert len(parsed["files_modified"]) == 2

    def test_implement_output_minimal(self):
        raw = {}
        parsed, errors = validate_agent_output(raw, "implement-output")
        assert parsed is not None
        assert errors == []

    def test_unknown_schema_name(self):
        with pytest.raises(FileNotFoundError):
            validate_agent_output({}, "nonexistent-schema")


class TestSchemaDiscovery:
    """Tests for schema file listing and caching."""

    def test_list_schemas(self):
        schemas = list_schemas()
        assert "review-output" in schemas
        assert "implement-output" in schemas

    def test_clear_cache(self):
        # Load to populate cache
        validate_agent_output({"verdict": "pass"}, "review-output")
        clear_cache()
        # Should still work after cache clear
        parsed, errors = validate_agent_output({"verdict": "pass"}, "review-output")
        assert parsed is not None

    def test_schema_files_are_valid_json(self):
        """Verify all schema files in schemas/ are parseable JSON."""
        schemas_dir = Path(__file__).resolve().parent.parent.parent / "schemas"
        for schema_file in schemas_dir.glob("*.json"):
            data = json.loads(schema_file.read_text(encoding="utf-8"))
            assert "$schema" in data, f"{schema_file.name}: missing $schema"
            assert "properties" in data or "type" in data, f"{schema_file.name}: not a valid schema"


# ============================================================
# Stage _parse_xxx_result tests — schema validation
# ============================================================


class TestReviewStageParseResult:
    """Tests for ReviewStage._parse_review_result."""

    def setup_method(self):
        self.stage = ReviewStage()
        self.ctx = StageContext(
            workflow_id="test",
            spec_path=Path("/tmp/spec.md"),
            project_path=Path("/tmp/project"),
            worktree_path=Path("/tmp/worktree"),
            current_stage=StageName.REVIEW,
        )

    def test_valid_pass(self):
        raw = {"verdict": "pass", "summary": "Clean code", "issues": []}
        result = self.stage._parse_review_result(raw, self.ctx)
        assert result.verdict == Verdict.PASS
        assert result.summary == "Clean code"

    def test_valid_fail(self):
        raw = {
            "verdict": "fail",
            "summary": "Issues found",
            "issues": [
                {
                    "severity": "critical",
                    "category": "correctness",
                    "description": "Bad",
                    "location": "a.py:1",
                    "suggested_fix": "Fix it",
                }
            ],
        }
        result = self.stage._parse_review_result(raw, self.ctx)
        assert result.verdict == Verdict.FAIL
        assert len(result.issues) == 1
        assert result.issues[0].severity.value == "critical"

    def test_none_input_returns_fail(self):
        result = self.stage._parse_review_result(None, self.ctx)
        assert result.verdict == Verdict.FAIL
        assert "validation failed" in result.summary.lower()

    def test_invalid_verdict_returns_fail(self):
        raw = {"verdict": "maybe", "summary": ""}
        result = self.stage._parse_review_result(raw, self.ctx)
        assert result.verdict == Verdict.FAIL

    def test_empty_dict_returns_fail(self):
        result = self.stage._parse_review_result({}, self.ctx)
        assert result.verdict == Verdict.FAIL


class TestExtractReviewCategory:
    """Tests for orchestrator._extract_review_category mapping logic."""

    def _make_output(self, issues: list[dict] | None) -> StageOutput:
        """Helper: create a StageOutput with a review-result.json in a temp dir."""
        import tempfile
        tmp = tempfile.mkdtemp()
        path = Path(tmp) / "review-result.json"
        data = {"verdict": "fail", "issues": issues or []}
        path.write_text(json.dumps(data), encoding="utf-8")
        return StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.FAIL, result_path=path)

    def test_correctness_maps_to_code_quality(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "correctness", "severity": "critical", "description": "x"}])
        assert _extract_review_category(output) == "code_quality"

    def test_security_maps_to_code_quality(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "security", "severity": "critical", "description": "x"}])
        assert _extract_review_category(output) == "code_quality"

    def test_ux_maps_to_code_quality(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "ux", "severity": "major", "description": "x"}])
        assert _extract_review_category(output) == "code_quality"

    def test_performance_maps_to_code_quality(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "performance", "severity": "major", "description": "x"}])
        assert _extract_review_category(output) == "code_quality"

    def test_maintainability_maps_to_code_quality(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "maintainability", "severity": "minor", "description": "x"}])
        assert _extract_review_category(output) == "code_quality"

    def test_code_quality_stays(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "code_quality", "severity": "major", "description": "x"}])
        assert _extract_review_category(output) == "code_quality"

    def test_test_quality_stays(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "test_quality", "severity": "major", "description": "x"}])
        assert _extract_review_category(output) == "test_quality"

    def test_empty_issues_defaults_to_code_quality(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([])
        assert _extract_review_category(output) == "code_quality"

    def test_invalid_category_raises(self):
        from scripts.orchestrator import _extract_review_category
        output = self._make_output([{"category": "逻辑错误", "severity": "critical", "description": "x"}])
        with pytest.raises(ValueError, match="unrecognized review category"):
            _extract_review_category(output)

    def test_no_result_path_defaults_to_code_quality(self):
        from scripts.orchestrator import _extract_review_category
        output = StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.FAIL)
        assert _extract_review_category(output) == "code_quality"


class TestWhiteboxTestStageParseResult:
    """Tests for WhiteboxTestStage._parse_test_result."""

    def setup_method(self):
        self.stage = WhiteboxTestStage()

    def test_valid_pass(self):
        raw = {"verdict": "pass", "summary": "Tests passed", "issues": []}
        result = self.stage._parse_test_result(raw)
        assert result.verdict == Verdict.PASS

    def test_none_returns_fail(self):
        result = self.stage._parse_test_result(None)
        assert result.verdict == Verdict.FAIL

    def test_invalid_severity_returns_fail(self):
        raw = {
            "verdict": "fail",
            "issues": [{"severity": "blocker", "category": "bug", "description": "x"}],
        }
        result = self.stage._parse_test_result(raw)
        assert result.verdict == Verdict.FAIL


class TestBlackboxTestStageParseResult:
    """Tests for BlackboxTestStage._parse_test_result."""

    def setup_method(self):
        self.stage = BlackboxTestStage()

    def test_valid_pass(self):
        raw = {"verdict": "pass", "summary": "OK", "issues": []}
        result = self.stage._parse_test_result(raw)
        assert result.verdict == Verdict.PASS

    def test_none_returns_fail(self):
        result = self.stage._parse_test_result(None)
        assert result.verdict == Verdict.FAIL


# ============================================================
# validate_output tests — artifact file validation
# ============================================================


class TestReviewStageValidateOutput:
    """Tests for ReviewStage.validate_output."""

    def setup_method(self):
        self.stage = ReviewStage()

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.PASS)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False
            assert any("review-result.json" in e for e in result.errors)

    def test_valid_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            review_path = workflow_dir / "review-result.json"
            review_data = {"verdict": "pass", "summary": "OK", "issues": []}
            review_path.write_text(
                json.dumps(review_data), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.PASS, result_path=review_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True

    def test_invalid_json_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            review_path = workflow_dir / "review-result.json"
            review_path.write_text("not json", encoding="utf-8")
            output = StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.PASS, result_path=review_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False

    def test_invalid_schema_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            review_path = workflow_dir / "review-result.json"
            review_path.write_text(
                json.dumps({"bad": "data"}), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.PASS, result_path=review_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False


class TestWhiteboxTestValidateOutput:
    """Tests for WhiteboxTestStage.validate_output."""

    def setup_method(self):
        self.stage = WhiteboxTestStage()

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = StageOutput(stage_name=StageName.WHITEBOX_TEST, verdict=Verdict.PASS)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False

    def test_valid_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            test_path = workflow_dir / "test-result.json"
            test_path.write_text(
                json.dumps({"verdict": "pass", "summary": "OK", "issues": []}),
                encoding="utf-8",
            )
            output = StageOutput(stage_name=StageName.WHITEBOX_TEST, verdict=Verdict.PASS, result_path=test_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True


class TestBlackboxTestValidateOutput:
    """Tests for BlackboxTestStage.validate_output."""

    def setup_method(self):
        self.stage = BlackboxTestStage()

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = StageOutput(stage_name=StageName.BLACKBOX_TEST, verdict=Verdict.PASS)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False

    def test_valid_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            test_path = workflow_dir / "test-result.json"
            test_path.write_text(
                json.dumps({"verdict": "pass", "summary": "OK", "issues": []}),
                encoding="utf-8",
            )
            output = StageOutput(stage_name=StageName.BLACKBOX_TEST, verdict=Verdict.PASS, result_path=test_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True


class TestImplementValidateOutput:
    """Tests for ImplementStage.validate_output."""

    def setup_method(self):
        self.stage = ImplementStage()

    def test_missing_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = StageOutput(stage_name=StageName.IMPLEMENT, verdict=Verdict.PASS)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False

    def test_progress_no_completed_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            result_path = workflow_dir / "result.json"
            result_path.write_text("{}", encoding="utf-8")
            (workflow_dir / "progress.json").write_text(
                json.dumps({"completed_tasks": []}), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.IMPLEMENT, verdict=Verdict.PASS, result_path=result_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False

    def test_valid_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            result_path = workflow_dir / "result.json"
            result_path.write_text("{}", encoding="utf-8")
            (workflow_dir / "progress.json").write_text(
                json.dumps({"completed_tasks": ["task-1"]}), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.IMPLEMENT, verdict=Verdict.PASS, result_path=result_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True


class TestBootstrapValidateOutput:
    """Tests for BootstrapStage.validate_output."""

    def setup_method(self):
        self.stage = BootstrapStage()

    def test_missing_all_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = StageOutput(stage_name=StageName.BOOTSTRAP, verdict=Verdict.PASS)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False

    def test_valid_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            for name in ["tasks.json", "progress.json", "stage-history.json"]:
                (workflow_dir / name).write_text("{}", encoding="utf-8")
            state_path = workflow_dir / "state.json"
            state_path.write_text(
                json.dumps({"status": "running"}), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.BOOTSTRAP, verdict=Verdict.PASS, result_path=state_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True

    def test_state_missing_status_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            for name in ["tasks.json", "progress.json", "stage-history.json"]:
                (workflow_dir / name).write_text("{}", encoding="utf-8")
            state_path = workflow_dir / "state.json"
            state_path.write_text(
                json.dumps({"id": "123"}), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.BOOTSTRAP, verdict=Verdict.PASS, result_path=state_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False
            assert any("status" in e for e in result.errors)


class TestFinishValidateOutput:
    """Tests for FinishStage.validate_output."""

    def setup_method(self):
        self.stage = FinishStage()

    def test_missing_all_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = StageOutput(stage_name=StageName.FINISH, verdict=Verdict.PASS)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False

    def test_valid_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            report_path = workflow_dir / "report.md"
            report_path.write_text("# Report", encoding="utf-8")
            (workflow_dir / "state.json").write_text(
                json.dumps({"status": "completed"}), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.FINISH, verdict=Verdict.PASS, result_path=report_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True

    def test_state_not_completed(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            report_path = workflow_dir / "report.md"
            report_path.write_text("# Report", encoding="utf-8")
            (workflow_dir / "state.json").write_text(
                json.dumps({"status": "running"}), encoding="utf-8"
            )
            output = StageOutput(stage_name=StageName.FINISH, verdict=Verdict.PASS, result_path=report_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False
            assert any("completed" in e for e in result.errors)


# ============================================================
# Contract compliance tests
# ============================================================


class TestContractCompliance:
    """Verify all stages pass BaseStage.validate_contract()."""

    @pytest.mark.parametrize("stage_cls", [
        ReviewStage,
        WhiteboxTestStage,
        BlackboxTestStage,
        ImplementStage,
        BootstrapStage,
        FinishStage,
    ])
    def test_validate_contract(self, stage_cls):
        errors = stage_cls.validate_contract()
        assert errors == [], f"{stage_cls.__name__} contract violations: {errors}"
