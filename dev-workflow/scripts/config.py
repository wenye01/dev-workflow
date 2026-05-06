"""Configuration loading from .dev-workflow/config.yml with pydantic validation."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field

from scripts.models import StageName


class AgentConfig(BaseModel):
    """Agent backend configuration."""

    default: str = "claude"
    model: str | None = None


class StageConfigEntry(BaseModel):
    """Per-stage runtime configuration."""

    timeout: int | None = None
    agent: str | None = None
    model: str | None = None


class WorkflowParams(BaseModel):
    """General workflow parameters."""

    max_retries: int = 3
    enable_followup_review_loops: bool = True
    max_review_loops: int = 3
    worktrees_dir: str = "worktree"


class WorkflowConfig(BaseModel):
    """Root configuration loaded from .dev-workflow/config.yml."""

    agent: AgentConfig = Field(default_factory=AgentConfig)
    stages: dict[str, StageConfigEntry] = Field(default_factory=dict)
    workflow: WorkflowParams = Field(default_factory=WorkflowParams)

    def get_stage_config(self, stage_name: str) -> StageConfigEntry:
        """Get configuration for a specific stage, with defaults."""
        default_timeout = 18000 if stage_name in {stage.value for stage in StageName} else 18000
        stage = self.stages.get(stage_name)
        if stage is None:
            return StageConfigEntry(timeout=default_timeout)
        return StageConfigEntry(
            timeout=stage.timeout if stage.timeout is not None else default_timeout,
            agent=stage.agent,
            model=stage.model,
        )

    def get_agent_for_stage(self, stage_name: str) -> str:
        """Get the agent backend name for a specific stage."""
        stage = self.stages.get(stage_name)
        if stage is not None and stage.agent is not None:
            return stage.agent
        return self.agent.default

    def get_model_for_stage(self, stage_name: str) -> str | None:
        """Get the model override for a specific stage."""
        stage = self.stages.get(stage_name)
        if stage is not None and stage.model is not None:
            return stage.model
        return self.agent.model


def load_config(config_path: Path | None = None) -> WorkflowConfig:
    """Load configuration from .dev-workflow/config.yml file.

    Args:
        config_path: Path to config file. Defaults to .dev-workflow/config.yml in cwd.

    Returns:
        Validated WorkflowConfig instance.
    """
    if config_path is None:
        config_path = Path(".dev-workflow/config.yml")

    if not config_path.exists():
        return WorkflowConfig()

    with open(config_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    return WorkflowConfig(**raw)
