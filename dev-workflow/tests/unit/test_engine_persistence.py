"""Tests for workflow engine persistence artifacts."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from scripts.engine import WorkflowEngine
from scripts.models import StageExecution, StageName, StageStatus, WorkflowInstance


class TestEnginePersistence:
    def test_persist_writes_stage_history_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            instance = WorkflowInstance(
                slug="demo",
                project_path=project_path,
                current_stage=StageName.IMPLEMENT,
            )
            engine = WorkflowEngine(instance)
            engine.start()
            engine.add_stage_execution(
                StageExecution(
                    workflow_id=instance.id,
                    stage_name=StageName.IMPLEMENT,
                    status=StageStatus.COMPLETED,
                    retry_attempt=1,
                )
            )

            engine.persist()

            state_dir = project_path / ".dev-workflow" / "run" / instance.run_id
            history = json.loads((state_dir / "stage-history.json").read_text(encoding="utf-8"))
            assert len(history) == 1
            assert history[0]["stage_name"] == "implement"
            assert history[0]["retry_attempt"] == 1

    def test_stage_execution_retry_attempt_is_preserved_in_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            instance = WorkflowInstance(
                slug="demo",
                project_path=project_path,
                current_stage=StageName.REVIEW,
            )
            engine = WorkflowEngine(instance)
            engine.start()
            engine.add_stage_execution(
                StageExecution(
                    workflow_id=instance.id,
                    stage_name=StageName.REVIEW,
                    status=StageStatus.FAILED,
                    retry_attempt=2,
                )
            )

            engine.persist()

            state_dir = project_path / ".dev-workflow" / "run" / instance.run_id
            state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
            assert state["stage_executions"][0]["retry_attempt"] == 2
