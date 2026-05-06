"""Tests for configurable agent backend selection."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import pytest

from agents import get_agent_backend
from agents.claude import ClaudeBackend
from agents.codex import CodexBackend
from scripts.config import WorkflowConfig
from scripts.models import AgentResult, StageConfig, StageContext, StageName
from stages.implement import ImplementStage


class _FakeProcess:
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.pid = 12345
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    def communicate(self, timeout: int | None = None):  # pragma: no cover - simple test fake
        return self._stdout, self._stderr


class TestAgentBackendFactory:
    def test_get_claude_backend(self):
        backend = get_agent_backend("claude")
        assert isinstance(backend, ClaudeBackend)

    def test_get_codex_backend(self):
        backend = get_agent_backend("codex")
        assert isinstance(backend, CodexBackend)

    def test_unknown_backend_raises(self):
        with pytest.raises(ValueError):
            get_agent_backend("unknown")


class _FakeBackend:
    def __init__(self, captured: dict[str, str]) -> None:
        self._captured = captured

    def invoke(self, **kwargs) -> AgentResult:  # pragma: no cover - simple test fake
        self._captured["working_dir"] = str(kwargs["working_dir"])
        self._captured["model"] = kwargs.get("model")
        debug_log_dir = kwargs.get("debug_log_dir")
        if debug_log_dir is not None:
            debug_log_dir.mkdir(parents=True, exist_ok=True)
        return AgentResult(exit_code=0, stdout='{"ok": true}', parsed_output={"summary": "ok"})


class _FakeFailingBackend:
    def invoke(self, **kwargs) -> AgentResult:  # pragma: no cover - simple test fake
        debug_log_dir = kwargs.get("debug_log_dir")
        if debug_log_dir is not None:
            debug_log_dir.mkdir(parents=True, exist_ok=True)
        return AgentResult(exit_code=7, stderr="unknown model: bad-model")


class TestImplementStageBackendSelection:
    def test_implement_invoke_uses_configured_backend(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, str] = {}

        def _fake_get_backend(name: str):
            captured["backend_name"] = name
            return _FakeBackend(captured)

        monkeypatch.setattr("stages.implement.get_agent_backend", _fake_get_backend)
        monkeypatch.setattr(
            "stages.implement.get_schema_path",
            lambda _: Path(__file__).resolve().parents[2] / "schemas" / "implement-output.json",
        )

        stage = ImplementStage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir(parents=True)

            context = StageContext(
                workflow_id="w1",
                run_id="run-1",
                spec_path=root / "spec.md",
                project_path=root,
                worktree_path=worktree,
                current_stage=StageName.IMPLEMENT,
            )
            config = StageConfig(timeout_seconds=30, agent_backend="codex")

            parsed = stage._invoke_agent("test", context, config)

        assert captured["backend_name"] == "codex"
        assert captured["working_dir"] == str(worktree)
        assert captured["model"] is None
        assert parsed == {"summary": "ok"}

    def test_implement_invoke_passes_configured_model(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, str] = {}

        def _fake_get_backend(name: str):
            captured["backend_name"] = name
            return _FakeBackend(captured)

        monkeypatch.setattr("stages.implement.get_agent_backend", _fake_get_backend)
        monkeypatch.setattr(
            "stages.implement.get_schema_path",
            lambda _: Path(__file__).resolve().parents[2] / "schemas" / "implement-output.json",
        )

        stage = ImplementStage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir(parents=True)

            context = StageContext(
                workflow_id="w1",
                run_id="run-1",
                spec_path=root / "spec.md",
                project_path=root,
                worktree_path=worktree,
                current_stage=StageName.IMPLEMENT,
            )
            config = StageConfig(timeout_seconds=30, agent_backend="codex", agent_model="gpt-5.4")

            stage._invoke_agent("test", context, config)

        assert captured["backend_name"] == "codex"
        assert captured["model"] == "gpt-5.4"

    def test_execute_synthesizes_task_when_task_list_is_empty(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, str] = {}

        def _fake_invoke_agent(self, prompt: str, context: StageContext, config: StageConfig):
            captured["prompt"] = prompt
            return {}

        monkeypatch.setattr(ImplementStage, "_invoke_agent", _fake_invoke_agent)

        stage = ImplementStage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir(parents=True)
            state_dir = root / ".dev-workflow" / "run" / "run-1"
            state_dir.mkdir(parents=True)
            (state_dir / "progress.json").write_text("{}", encoding="utf-8")
            spec_path = root / "spec.md"
            spec_path.write_text("# Demo Spec", encoding="utf-8")

            context = StageContext(
                workflow_id="w1",
                run_id="run-1",
                spec_path=spec_path,
                project_path=root,
                worktree_path=worktree,
                current_stage=StageName.IMPLEMENT,
            )
            output = stage.execute(context, StageConfig(timeout_seconds=30, agent_backend="codex"))

        assert "Demo Spec" in captured["prompt"]
        assert output.output_data["all_tasks_completed"] is True

    def test_execute_prefers_issue_backed_tasks_when_present(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, str] = {}

        def _fake_invoke_agent(self, prompt: str, context: StageContext, config: StageConfig):
            captured["prompt"] = prompt
            return {}

        monkeypatch.setattr(ImplementStage, "_invoke_agent", _fake_invoke_agent)

        stage = ImplementStage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir(parents=True)
            state_dir = root / ".dev-workflow" / "run" / "run-1"
            state_dir.mkdir(parents=True)
            (state_dir / "tasks.json").write_text(json.dumps([
                {
                    "id": "fix-1",
                    "title": "Fix review issue",
                    "description": "Address a review finding",
                    "status": "pending",
                    "linked_issue_ids": [],
                }
            ]), encoding="utf-8")
            (state_dir / "progress.json").write_text("{}", encoding="utf-8")
            spec_path = root / "spec.md"
            spec_path.write_text("# Demo Spec", encoding="utf-8")

            context = StageContext(
                workflow_id="w1",
                run_id="run-1",
                spec_path=spec_path,
                project_path=root,
                worktree_path=worktree,
                current_stage=StageName.IMPLEMENT,
            )
            output = stage.execute(context, StageConfig(timeout_seconds=30, agent_backend="codex"))

            tasks = json.loads((state_dir / "tasks.json").read_text(encoding="utf-8"))

        assert "Fix review issue" in captured["prompt"]
        assert output.output_data["all_tasks_completed"] is True
        assert tasks[0]["status"] == "completed"

    def test_execute_commits_task_changes_and_records_progress(self, monkeypatch: pytest.MonkeyPatch):
        def _fake_invoke_agent(self, prompt: str, context: StageContext, config: StageConfig):
            (context.worktree_path / "feature.txt").write_text("done", encoding="utf-8")
            return {"summary": "Implemented feature"}

        monkeypatch.setattr(ImplementStage, "_invoke_agent", _fake_invoke_agent)

        stage = ImplementStage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir(parents=True)
            subprocess.run(["git", "init"], cwd=worktree, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=worktree, check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=worktree, check=True)
            (worktree / "README.md").write_text("base", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=worktree, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=worktree, check=True, capture_output=True)

            state_dir = root / ".dev-workflow" / "run" / "run-1"
            state_dir.mkdir(parents=True)
            (state_dir / "progress.json").write_text("{}", encoding="utf-8")
            spec_path = root / "spec.md"
            spec_path.write_text("# Demo Spec", encoding="utf-8")

            context = StageContext(
                workflow_id="w1",
                run_id="run-1",
                spec_path=spec_path,
                project_path=root,
                worktree_path=worktree,
                current_stage=StageName.IMPLEMENT,
            )
            output = stage.execute(context, StageConfig(timeout_seconds=30, agent_backend="codex"))

            progress = json.loads((state_dir / "progress.json").read_text(encoding="utf-8"))
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=worktree,
                check=True,
                capture_output=True,
                text=True,
            )

        assert output.output_data["commit_sha"]
        assert progress["task_commits"][0]["task_id"] == "spec-implementation"
        assert progress["task_commits"][0]["commit"] == output.output_data["commit_sha"]
        assert status.stdout == ""

    def test_implement_failure_reports_backend_model_and_debug_dir(self, monkeypatch: pytest.MonkeyPatch):
        def _fake_get_backend(name: str):
            return _FakeFailingBackend()

        monkeypatch.setattr("stages.implement.get_agent_backend", _fake_get_backend)
        monkeypatch.setattr(
            "stages.implement.get_schema_path",
            lambda _: Path(__file__).resolve().parents[2] / "schemas" / "implement-output.json",
        )

        stage = ImplementStage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir(parents=True)

            context = StageContext(
                workflow_id="w1",
                run_id="run-1",
                spec_path=root / "spec.md",
                project_path=root,
                worktree_path=worktree,
                current_stage=StageName.IMPLEMENT,
            )
            config = StageConfig(timeout_seconds=30, agent_backend="claude", agent_model="bad-model")

            with pytest.raises(RuntimeError) as exc_info:
                stage._invoke_agent("test", context, config)

        message = str(exc_info.value)
        assert "backend=claude" in message
        assert "model=bad-model" in message
        assert "debug_log_dir=" in message
        assert "unknown model: bad-model" in message


class TestVerboseAgentInvocation:
    def test_claude_backend_adds_model_flag(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, object] = {}

        def _fake_popen(cmd, **kwargs):
            captured["cmd"] = cmd
            return _FakeProcess(
                stdout=json.dumps({"result": json.dumps({"ok": True})}),
            )

        monkeypatch.setattr("agents.claude.subprocess.Popen", _fake_popen)

        backend = ClaudeBackend()
        result = backend.invoke(
            prompt="test prompt",
            working_dir=Path("."),
            timeout=1,
            model="claude-sonnet-4-20250514",
        )

        assert "--model" in captured["cmd"]
        assert "claude-sonnet-4-20250514" in captured["cmd"]
        assert result.parsed_output == {"ok": True}

    def test_claude_backend_enables_verbose_flag(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, object] = {}

        def _fake_popen(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return _FakeProcess(
                stdout=json.dumps({"result": json.dumps({"ok": True})}),
            )

        monkeypatch.setattr("agents.claude.subprocess.Popen", _fake_popen)

        backend = ClaudeBackend()
        result = backend.invoke(
            prompt="test prompt",
            working_dir=Path("."),
            timeout=1,
        )

        assert "--verbose" in captured["cmd"]
        assert result.parsed_output == {"ok": True}

    def test_codex_backend_sets_debug_logging(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, object] = {}

        def _fake_popen(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return _FakeProcess(
                stdout='{"structured_output": {"ok": true}}\n',
            )

        monkeypatch.setattr("agents.codex.subprocess.Popen", _fake_popen)

        backend = CodexBackend()
        result = backend.invoke(
            prompt="test prompt",
            working_dir=Path("."),
            timeout=1,
        )

        assert captured["kwargs"]["env"]["RUST_LOG"] == "debug"
        assert result.parsed_output == {"ok": True}

    def test_codex_backend_adds_model_flag(self, monkeypatch: pytest.MonkeyPatch):
        captured: dict[str, object] = {}

        def _fake_popen(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return _FakeProcess(
                stdout='{"structured_output": {"ok": true}}\n',
            )

        monkeypatch.setattr("agents.codex.subprocess.Popen", _fake_popen)

        backend = CodexBackend()
        result = backend.invoke(
            prompt="test prompt",
            working_dir=Path("."),
            timeout=1,
            model="gpt-5.4",
        )

        assert "--model" in captured["cmd"]
        assert "gpt-5.4" in captured["cmd"]
        assert result.parsed_output == {"ok": True}


class TestWorkflowConfigModelSelection:
    def test_get_model_for_stage_uses_stage_override_then_default(self):
        config = WorkflowConfig.model_validate({
            "agent": {
                "default": "codex",
                "model": "gpt-5.4",
            },
            "stages": {
                "whitebox_test": {
                    "agent": "claude",
                    "model": "claude-sonnet-4-20250514",
                },
            },
        })

        assert config.get_agent_for_stage("whitebox_test") == "claude"
        assert config.get_model_for_stage("whitebox_test") == "claude-sonnet-4-20250514"
        assert config.get_model_for_stage("review") == "gpt-5.4"

    def test_get_model_for_stage_returns_none_when_unset(self):
        config = WorkflowConfig.model_validate({
            "agent": {
                "default": "codex",
            },
        })

        assert config.get_model_for_stage("review") is None
