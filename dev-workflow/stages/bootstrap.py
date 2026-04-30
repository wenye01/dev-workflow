"""Bootstrap stage: worktree initialization, branch creation, initial state files."""

from __future__ import annotations

import json
import logging
import subprocess
import shutil
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

logger = logging.getLogger(__name__)


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
            logger.info("Bootstrap starting: project_path=%s, run_id=%s", context.project_path, context.run_id)
            worktree_path = self._create_worktree(context)
            logger.info("Worktree created: %s", worktree_path)
            self._sync_workflow_context(context.project_path, worktree_path)
            logger.info("Workflow context synced to worktree: %s", worktree_path / ".dev-workflow")
            state_dir = self._init_state_dir(context)
            logger.info("State dir initialized: %s", state_dir)
            self._write_initial_state(state_dir, worktree_path, context)
            self._create_initial_commit(worktree_path, context)
            logger.info("Bootstrap completed successfully")

            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.PASS,
                result_path=state_dir / "state.json",
            )
        except Exception as e:
            logger.error("Bootstrap FAILED: %s", e, exc_info=True)
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message=str(e),
            )

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        # Derive state dir from result_path (set in execute)
        state_dir = output.result_path.parent if output.result_path else None
        if state_dir is None:
            return ValidationResult(is_valid=False, errors=["No result path in output"])

        expected_files = ["state.json", "progress.json", "stage-history.json"]

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

        if worktree_path.exists():
            if self._is_registered_worktree(project_path, worktree_path):
                self._remove_worktree(project_path, worktree_path)
            elif worktree_path.is_dir() and not any(worktree_path.iterdir()):
                worktree_path.rmdir()
            else:
                raise RuntimeError(f"Worktree path already exists: {worktree_path}")

        result = subprocess.run(
            ["git", "worktree", "add", "-B", run_id, str(worktree_path)],
            cwd=str(project_path),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            stdout = result.stdout.strip()
            message_parts = [f"git worktree add failed for {worktree_path}"]
            if stderr:
                message_parts.append(stderr)
            elif stdout:
                message_parts.append(stdout)
            raise RuntimeError(": ".join(message_parts))

        return worktree_path

    def _is_registered_worktree(self, project_path: Path, worktree_path: Path) -> bool:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=str(project_path),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return False

        target = worktree_path.resolve()
        for line in result.stdout.splitlines():
            if line.startswith("worktree "):
                if Path(line.removeprefix("worktree ").strip()).resolve() == target:
                    return True
        return False

    def _remove_worktree(self, project_path: Path, worktree_path: Path) -> None:
        result = subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree_path)],
            cwd=str(project_path),
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return

        git_dir = worktree_path / ".git"
        if git_dir.exists() and git_dir.is_dir():
            shutil.rmtree(worktree_path)
            subprocess.run(
                ["git", "worktree", "prune"],
                cwd=str(project_path),
                capture_output=True,
                text=True,
                check=False,
            )
            return

        stderr = result.stderr.strip()
        stdout = result.stdout.strip()
        message_parts = [f"git worktree remove failed for {worktree_path}"]
        if stderr:
            message_parts.append(stderr)
        elif stdout:
            message_parts.append(stdout)
        raise RuntimeError(": ".join(message_parts))

    def _init_state_dir(self, context: StageContext) -> Path:
        """Create .dev-workflow/run/{run_id}/ state directory in project root."""
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        state_dir.mkdir(parents=True, exist_ok=True)

        # Create empty artifact files
        (state_dir / "progress.json").write_text("{}", encoding="utf-8")
        (state_dir / "stage-history.json").write_text("[]", encoding="utf-8")

        return state_dir

    def _sync_workflow_context(self, project_path: Path, worktree_path: Path) -> None:
        """Sync .dev-workflow context files to the worktree, excluding runtime state."""
        source_root = project_path / ".dev-workflow"
        if not source_root.exists():
            return

        dest_root = worktree_path / ".dev-workflow"
        dest_root.mkdir(parents=True, exist_ok=True)

        for child in source_root.iterdir():
            if child.name == "run":
                continue

            dest = dest_root / child.name
            if child.is_dir():
                shutil.copytree(child, dest, dirs_exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(child, dest)

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
        result = subprocess.run(
            ["git", "commit", "--allow-empty", "-m",
             f"workflow: initialize {context.run_id}"],
            cwd=str(worktree_path),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            stdout = result.stdout.strip()
            message_parts = [f"git commit failed in {worktree_path}"]
            if stderr:
                message_parts.append(stderr)
            elif stdout:
                message_parts.append(stdout)
            raise RuntimeError(": ".join(message_parts))
