"""Bootstrap stage: worktree initialization, branch creation, initial state files."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from scripts.models import (
    AgentContext,
    StageConfig,
    StageContext,
    StageName,
    StageOutput,
    ValidationResult,
    Verdict,
    WorkflowStatus,
    get_run_state_dir,
)
from stages.base import BaseStage


class BootstrapStage(BaseStage):
    """Creates git worktree in ../worktree/{id}/, initializes state in .dev-workflow/run/{id}/."""

    @property
    def name(self) -> StageName:
        return StageName.BOOTSTRAP

    def validate_input(self, context: StageContext) -> ValidationResult:
        errors = []
        if not context.spec_path.exists():
            errors.append(f"Spec file not found: {context.spec_path}")
        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def build_agent_context(self, context: StageContext) -> AgentContext:
        return AgentContext(
            stage_name=self.name,
            project_context={"spec_path": str(context.spec_path)},
        )

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        try:
            worktree_path = self._create_worktree(context)
            state_dir = self._init_state_dir(context)
            self._write_initial_state(state_dir, worktree_path, context)
            self._create_initial_commit(worktree_path, context)

            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.PASS,
                result_path=state_dir / "state.json",
            )
        except Exception as e:
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message=str(e),
            )

    def determine_next_stage(self, output: StageOutput) -> StageName | None:
        if output.verdict == Verdict.PASS:
            return StageName.IMPLEMENT
        return None

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        # Derive state dir from result_path (set in execute)
        state_dir = output.result_path.parent if output.result_path else None
        if state_dir is None:
            return ValidationResult(is_valid=False, errors=["No result path in output"])

        expected_files = ["state.json", "tasks.json", "progress.json", "stage-history.json"]

        for filename in expected_files:
            filepath = state_dir / filename
            if not filepath.exists():
                errors.append(f"{filename} not found in {state_dir}")

        # Validate state.json is parseable JSON
        state_path = state_dir / "state.json"
        if state_path.exists():
            try:
                json_data = json.loads(state_path.read_text(encoding="utf-8"))
                if "status" not in json_data:
                    errors.append("state.json missing 'status' field")
            except (json.JSONDecodeError, ValueError) as e:
                errors.append(f"state.json is not valid JSON: {e}")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def _create_worktree(self, context: StageContext) -> Path:
        """Create a git worktree in ../worktree/{run_id}/."""
        project_path = context.project_path
        run_id = context.run_id

        # Place worktree in ../worktree/{run_id}/ (one level up from project root)
        worktrees_base = project_path.parent / "worktree"
        worktrees_base.mkdir(parents=True, exist_ok=True)
        worktree_path = worktrees_base / run_id

        # Create worktree via git
        try:
            subprocess.run(
                ["git", "worktree", "add", str(worktree_path), "-b", run_id],
                cwd=str(project_path),
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError:
            # Fallback: create directory and init git
            worktree_path.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["git", "init"], cwd=str(worktree_path), capture_output=True, check=True,
            )
            subprocess.run(
                ["git", "checkout", "-b", run_id],
                cwd=str(worktree_path), capture_output=True, check=True,
            )

        return worktree_path

    def _init_state_dir(self, context: StageContext) -> Path:
        """Create .dev-workflow/run/{run_id}/ state directory in project root."""
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        state_dir.mkdir(parents=True, exist_ok=True)

        # Create empty artifact files
        (state_dir / "tasks.json").write_text("[]", encoding="utf-8")
        (state_dir / "progress.json").write_text("{}", encoding="utf-8")
        (state_dir / "stage-history.json").write_text("[]", encoding="utf-8")

        return state_dir

    def _write_initial_state(
        self, state_dir: Path, worktree_path: Path, context: StageContext,
    ) -> None:
        """Write initial state.json to project root state dir."""
        from scripts.models import WorkflowInstance, WorkflowSpec

        spec = WorkflowSpec(
            source_requirement="",
            spec_path=context.spec_path,
        )

        instance = WorkflowInstance(
            spec=spec,
            status=WorkflowStatus.RUNNING,
            current_stage=StageName.BOOTSTRAP,
            project_path=context.project_path,
            worktree_path=worktree_path,
            branch_name=context.run_id,
        )

        state_path = state_dir / "state.json"
        state_path.write_text(instance.model_dump_json(indent=2), encoding="utf-8")

    def _create_initial_commit(self, worktree_path: Path, context: StageContext) -> None:
        """Create initial git commit in worktree."""
        subprocess.run(
            ["git", "commit", "--allow-empty", "-m",
             f"workflow: initialize {context.run_id}"],
            cwd=str(worktree_path),
            capture_output=True,
        )
