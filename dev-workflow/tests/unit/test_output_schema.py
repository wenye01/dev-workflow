"""Tests for agent output schema validation and stage output contracts."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from scripts.models import StageContext, StageOutput, StageName, Verdict
from scripts.output_schema import clear_cache, list_schemas, validate_agent_output
from stages.adjudicate import AdjudicateStage
from stages.blackbox_test import BlackboxTestStage
from stages.bootstrap import BootstrapStage
from stages.finish import FinishStage
from stages.implement import ImplementStage
from stages.review import ReviewStage
from stages.whitebox_test import WhiteboxTestStage


class TestValidateAgentOutput:
    def test_valid_review_output(self):
        raw = {"verdict": "pass", "summary": "All good", "issues": []}
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

    def test_valid_review_output_with_continuity_fields(self):
        raw = {
            "verdict": "fail",
            "summary": "Found issues",
            "issues": [
                {
                    "severity": "major",
                    "category": "correctness",
                    "description": "Accepted issue remains unfixed",
                    "location": "main.py:42",
                    "relation": "unresolved_previous",
                    "continuation_reason": "Blocks the acceptance criteria",
                },
            ],
        }
        parsed, errors = validate_agent_output(raw, "review-output")
        assert parsed is not None
        assert errors == []
        assert parsed["issues"][0]["relation"] == "unresolved_previous"

    def test_none_input(self):
        parsed, errors = validate_agent_output(None, "review-output")
        assert parsed is None
        assert len(errors) == 1
        assert "no structured output" in errors[0].lower()

    def test_missing_verdict(self):
        parsed, errors = validate_agent_output({"summary": "No verdict"}, "review-output")
        assert parsed is None
        assert errors

    def test_invalid_verdict_value(self):
        parsed, errors = validate_agent_output({"verdict": "maybe", "summary": ""}, "review-output")
        assert parsed is None
        assert errors

    def test_invalid_severity_in_issue(self):
        raw = {
            "verdict": "fail",
            "issues": [{"severity": "blocker", "category": "bug", "description": "test"}],
        }
        parsed, errors = validate_agent_output(raw, "review-output")
        assert parsed is None
        assert errors

    def test_empty_dict(self):
        parsed, errors = validate_agent_output({}, "review-output")
        assert parsed is None
        assert errors

    def test_valid_implement_output(self):
        raw = {"summary": "Done"}
        parsed, errors = validate_agent_output(raw, "implement-output")
        assert parsed is not None
        assert errors == []

    def test_implement_output_missing_summary(self):
        parsed, errors = validate_agent_output({}, "implement-output")
        assert parsed is None
        assert errors

    def test_unknown_schema_name(self):
        with pytest.raises(FileNotFoundError):
            validate_agent_output({}, "nonexistent-schema")


class TestSchemaDiscovery:
    def test_list_schemas(self):
        schemas = list_schemas()
        assert "review-output" in schemas
        assert "implement-output" in schemas
        assert "adjudicate-output" in schemas

    def test_clear_cache(self):
        validate_agent_output({"verdict": "pass"}, "review-output")
        clear_cache()
        parsed, errors = validate_agent_output({"verdict": "pass"}, "review-output")
        assert parsed is not None
        assert errors == []

    def test_schema_files_are_valid_json(self):
        schemas_dir = Path(__file__).resolve().parent.parent.parent / "schemas"
        for schema_file in schemas_dir.glob("*.json"):
            data = json.loads(schema_file.read_text(encoding="utf-8"))
            assert "$schema" in data, f"{schema_file.name}: missing $schema"
            assert "properties" in data or "type" in data, f"{schema_file.name}: not a valid schema"


class TestReviewStageParseResult:
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
        result = self.stage._parse_review_result(
            {"verdict": "pass", "summary": "Clean code", "issues": []},
            self.ctx,
        )
        assert result.verdict == Verdict.PASS
        assert result.summary == "Clean code"

    def test_valid_fail(self):
        result = self.stage._parse_review_result(
            {
                "verdict": "fail",
                "summary": "Issues found",
                "issues": [
                    {
                        "severity": "critical",
                        "category": "correctness",
                        "description": "Bad",
                        "location": "a.py:1",
                    }
                ],
            },
            self.ctx,
        )
        assert result.verdict == Verdict.FAIL
        assert len(result.issues) == 1
        assert result.issues[0].severity.value == "critical"

    def test_none_input_returns_fail(self):
        result = self.stage._parse_review_result(None, self.ctx)
        assert result.verdict == Verdict.FAIL
        assert "validation failed" in result.summary.lower()

    def test_invalid_verdict_returns_fail(self):
        result = self.stage._parse_review_result({"verdict": "maybe", "summary": ""}, self.ctx)
        assert result.verdict == Verdict.FAIL

    def test_empty_dict_returns_fail(self):
        result = self.stage._parse_review_result({}, self.ctx)
        assert result.verdict == Verdict.FAIL


class TestWhiteboxTestStageParseResult:
    def setup_method(self):
        self.stage = WhiteboxTestStage()

    def test_valid_pass(self):
        result = self.stage._parse_test_result({"verdict": "pass", "summary": "Tests passed", "issues": []})
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
    def setup_method(self):
        self.stage = BlackboxTestStage()

    def test_valid_pass(self):
        result = self.stage._parse_test_result({"verdict": "pass", "summary": "OK", "issues": []})
        assert result.verdict == Verdict.PASS

    def test_none_returns_fail(self):
        result = self.stage._parse_test_result(None)
        assert result.verdict == Verdict.FAIL


class TestAdjudicateStageValidateOutput:
    def setup_method(self):
        self.stage = AdjudicateStage()

    def test_missing_next_stage_fails(self):
        result = self.stage.validate_output(
            StageOutput(stage_name=StageName.ADJUDICATE, verdict=Verdict.PASS, output_data={}),
            Path("/tmp"),
        )
        assert result.is_valid is False

    def test_next_stage_passes(self):
        result = self.stage.validate_output(
            StageOutput(
                stage_name=StageName.ADJUDICATE,
                verdict=Verdict.PASS,
                output_data={"next_stage": "implement"},
            ),
            Path("/tmp"),
        )
        assert result.is_valid is True


class TestReviewStageValidateOutput:
    def setup_method(self):
        self.stage = ReviewStage()

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.PASS)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False
            assert any("review-result.json" in error for error in result.errors)

    def test_valid_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            review_path = workflow_dir / "review-result.json"
            review_path.write_text(
                json.dumps(
                    {
                        "verdict": "pass",
                        "summary": "OK",
                        "issues": [],
                        "id": "feedback-1",
                        "stage_execution_id": "",
                        "reviewed_at": "2026-04-19T00:00:00",
                    }
                ),
                encoding="utf-8",
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
            review_path.write_text(json.dumps({"bad": "data"}), encoding="utf-8")
            output = StageOutput(stage_name=StageName.REVIEW, verdict=Verdict.PASS, result_path=review_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False


class TestWhiteboxTestValidateOutput:
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
                json.dumps(
                    {
                        "verdict": "pass",
                        "summary": "OK",
                        "issues": [],
                        "id": "feedback-1",
                        "stage_execution_id": "",
                        "reviewed_at": "2026-04-19T00:00:00",
                    }
                ),
                encoding="utf-8",
            )
            output = StageOutput(stage_name=StageName.WHITEBOX_TEST, verdict=Verdict.PASS, result_path=test_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True


class TestBlackboxTestValidateOutput:
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
                json.dumps(
                    {
                        "verdict": "pass",
                        "summary": "OK",
                        "issues": [],
                        "id": "feedback-1",
                        "stage_execution_id": "",
                        "reviewed_at": "2026-04-19T00:00:00",
                    }
                ),
                encoding="utf-8",
            )
            output = StageOutput(stage_name=StageName.BLACKBOX_TEST, verdict=Verdict.PASS, result_path=test_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True


class TestImplementValidateOutput:
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
                json.dumps({"completed_tasks": []}),
                encoding="utf-8",
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
                json.dumps({"completed_tasks": ["task-1"]}),
                encoding="utf-8",
            )
            output = StageOutput(stage_name=StageName.IMPLEMENT, verdict=Verdict.PASS, result_path=result_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True

    def test_all_tasks_completed_flag_allows_empty_completed_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            progress_path = workflow_dir / "progress.json"
            progress_path.write_text(
                json.dumps({"completed_tasks": []}),
                encoding="utf-8",
            )
            output = StageOutput(
                stage_name=StageName.IMPLEMENT,
                verdict=Verdict.PASS,
                result_path=progress_path,
                output_data={"all_tasks_completed": True, "more_tasks": False},
            )
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True


class TestBootstrapValidateOutput:
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
            for name in ["progress.json", "stage-history.json"]:
                (workflow_dir / name).write_text("{}", encoding="utf-8")
            state_path = workflow_dir / "state.json"
            state_path.write_text(json.dumps({"status": "running"}), encoding="utf-8")
            output = StageOutput(stage_name=StageName.BOOTSTRAP, verdict=Verdict.PASS, result_path=state_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is True

    def test_state_missing_status_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            workflow_dir = Path(tmp) / ".dev-workflow" / "run"
            workflow_dir.mkdir(parents=True)
            for name in ["progress.json", "stage-history.json"]:
                (workflow_dir / name).write_text("{}", encoding="utf-8")
            state_path = workflow_dir / "state.json"
            state_path.write_text(json.dumps({"id": "123"}), encoding="utf-8")
            output = StageOutput(stage_name=StageName.BOOTSTRAP, verdict=Verdict.PASS, result_path=state_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False
            assert any("status" in error for error in result.errors)

    def test_sync_workflow_context_excludes_run_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            worktree_root = Path(tmp) / "worktree"
            source = project_root / ".dev-workflow"
            (source / "docs").mkdir(parents=True)
            (source / "run" / "old-run").mkdir(parents=True)
            (source / "docs" / "project.md").write_text("project context", encoding="utf-8")
            (source / "config.yml").write_text("agent:\n  default: codex\n", encoding="utf-8")
            (source / "run" / "old-run" / "state.json").write_text("{}", encoding="utf-8")
            worktree_root.mkdir(parents=True)

            self.stage._sync_workflow_context(project_root, worktree_root)

            assert (worktree_root / ".dev-workflow" / "docs" / "project.md").exists()
            assert (worktree_root / ".dev-workflow" / "config.yml").exists()
            assert not (worktree_root / ".dev-workflow" / "run").exists()


class TestFinishValidateOutput:
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
                json.dumps({"status": "completed"}),
                encoding="utf-8",
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
                json.dumps({"status": "running"}),
                encoding="utf-8",
            )
            output = StageOutput(stage_name=StageName.FINISH, verdict=Verdict.PASS, result_path=report_path)
            result = self.stage.validate_output(output, Path(tmp))
            assert result.is_valid is False
            assert any("completed" in error for error in result.errors)


class TestContractCompliance:
    @pytest.mark.parametrize(
        "stage_cls",
        [
            ReviewStage,
            AdjudicateStage,
            WhiteboxTestStage,
            BlackboxTestStage,
            ImplementStage,
            BootstrapStage,
            FinishStage,
        ],
    )
    def test_validate_contract(self, stage_cls):
        errors = stage_cls.validate_contract()
        assert errors == [], f"{stage_cls.__name__} contract violations: {errors}"
