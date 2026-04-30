"""Tests for orchestrator CLI path resolution across project roots."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import pytest

from scripts.config import WorkflowConfig
from scripts.models import StageName, WorkflowInstance, WorkflowSpec, WorkflowStatus
from scripts.orchestrator import (
    _get_run_root,
    _resolve_config_path,
    cmd_abort,
    cmd_resume,
    cmd_start,
    cmd_status,
)


class TestOrchestratorCliPaths:
    def test_start_prefers_project_config_when_project_is_explicit(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, object] = {}

        def _fake_load_config(config_path: Path | None = None) -> WorkflowConfig:
            captured["config_path"] = config_path
            return WorkflowConfig()

        def _fake_run_workflow(engine, config, spec_path: Path) -> int:
            captured["project_path"] = engine.instance.project_path
            captured["spec_path"] = spec_path
            return 0

        monkeypatch.setattr("scripts.orchestrator.load_config", _fake_load_config)
        monkeypatch.setattr("scripts.orchestrator._run_workflow", _fake_run_workflow)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "project"
            project.mkdir()
            spec_path = root / "spec.md"
            spec_path.write_text("# Demo", encoding="utf-8")

            args = argparse.Namespace(
                spec=str(spec_path),
                slug="demo",
                project=str(project),
                config=None,
            )

            result = cmd_start(args)

        assert result == 0
        assert captured["project_path"] == project.resolve()
        assert captured["spec_path"] == spec_path.resolve()
        assert captured["config_path"] == project.resolve() / ".dev-workflow" / "config.yml"

    def test_status_reads_state_from_explicit_project(self, capsys: pytest.CaptureFixture[str]):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "project"
            run_dir = _get_run_root(project) / "20260430-demo"
            run_dir.mkdir(parents=True)

            instance = WorkflowInstance(
                slug="demo",
                project_path=project,
                current_stage=StageName.REVIEW,
                status=WorkflowStatus.RUNNING,
            )
            (run_dir / "state.json").write_text(instance.model_dump_json(indent=2), encoding="utf-8")

            result = cmd_status(
                argparse.Namespace(
                    workflow_id=None,
                    json=True,
                    project=str(project),
                )
            )

        out = capsys.readouterr().out
        assert result == 0
        assert '"project_path"' in out
        assert str(project) in out

    def test_resume_uses_explicit_project_for_state_and_fallback_spec(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ):
        captured: dict[str, object] = {}

        class _FakeEngine:
            def __init__(self, instance: WorkflowInstance) -> None:
                self.instance = instance

        def _fake_load_config(config_path: Path | None = None) -> WorkflowConfig:
            captured["config_path"] = config_path
            return WorkflowConfig()

        def _fake_restore_engine(state_path: Path, config: WorkflowConfig):
            captured["state_path"] = state_path
            instance = WorkflowInstance.model_validate_json(state_path.read_text(encoding="utf-8"))
            return _FakeEngine(instance)

        def _fake_run_workflow(engine, config, spec_path: Path) -> int:
            captured["spec_path"] = spec_path
            captured["project_path"] = engine.instance.project_path
            return 0

        monkeypatch.setattr("scripts.orchestrator.load_config", _fake_load_config)
        monkeypatch.setattr("scripts.orchestrator._run_workflow", _fake_run_workflow)
        monkeypatch.setattr("scripts.engine.restore_engine", _fake_restore_engine)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "project"
            project.mkdir()
            run_dir = _get_run_root(project) / "20260430-demo"
            run_dir.mkdir(parents=True)

            fallback_spec = project / ".dev-workflow" / "resume-spec.md"
            fallback_spec.parent.mkdir(parents=True, exist_ok=True)
            fallback_spec.write_text("# Resume", encoding="utf-8")

            missing_spec = project / "missing-spec.md"
            instance = WorkflowInstance(
                slug="demo",
                project_path=project,
                spec=WorkflowSpec(source_requirement="demo", spec_path=missing_spec),
            )
            (run_dir / "state.json").write_text(instance.model_dump_json(indent=2), encoding="utf-8")

            result = cmd_resume(
                argparse.Namespace(
                    workflow_id=None,
                    project=str(project),
                    config=None,
                )
            )

        assert result == 0
        assert captured["state_path"] == run_dir / "state.json"
        assert captured["config_path"] == project.resolve() / ".dev-workflow" / "config.yml"
        assert captured["project_path"] == project
        assert captured["spec_path"] == fallback_spec

    def test_abort_updates_state_under_explicit_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "project"
            run_dir = _get_run_root(project) / "20260430-demo"
            run_dir.mkdir(parents=True)

            instance = WorkflowInstance(
                slug="demo",
                project_path=project,
                status=WorkflowStatus.RUNNING,
            )
            state_path = run_dir / "state.json"
            state_path.write_text(instance.model_dump_json(indent=2), encoding="utf-8")

            result = cmd_abort(
                argparse.Namespace(
                    workflow_id=None,
                    force=False,
                    project=str(project),
                )
            )

            updated = json.loads(state_path.read_text(encoding="utf-8"))

        assert result == 0
        assert updated["status"] == "failed"


def test_resolve_config_path_uses_project_config_by_default():
    project = Path("/tmp/example-project")
    assert _resolve_config_path(project, None) == project / ".dev-workflow" / "config.yml"
