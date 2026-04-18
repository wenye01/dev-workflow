"""Configuration loading from .dev-workflow/config.yml with pydantic validation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from scripts.models import StageName


class AgentConfig(BaseModel):
    """Agent backend configuration."""

    default: str = "claude"
    stages: dict[str, str] = Field(default_factory=dict)


class StageTimeoutConfig(BaseModel):
    """Per-stage timeout and limits."""

    timeout: int = 600
    max_turns: int = 30
    max_budget_usd: float = 10.0


class WorkflowParams(BaseModel):
    """General workflow parameters."""

    max_retries: int = 3
    worktrees_dir: str = "worktree"


class WorkflowConfig(BaseModel):
    """Root configuration loaded from .dev-workflow/config.yml."""

    agent: AgentConfig = Field(default_factory=AgentConfig)
    stages: dict[str, StageTimeoutConfig] = Field(default_factory=dict)
    workflow: WorkflowParams = Field(default_factory=WorkflowParams)

    def get_stage_config(self, stage_name: str) -> StageTimeoutConfig:
        """Get configuration for a specific stage, with defaults."""
        default_timeouts: dict[str, dict[str, Any]] = {
            StageName.BOOTSTRAP.value: {"timeout": 300, "max_turns": 10},
            StageName.IMPLEMENT.value: {"timeout": 1800, "max_turns": 30},
            StageName.REVIEW.value: {"timeout": 600, "max_turns": 15},
            StageName.WHITEBOX_TEST.value: {"timeout": 900, "max_turns": 20},
            StageName.BLACKBOX_TEST.value: {"timeout": 1200, "max_turns": 25},
            StageName.FINISH.value: {"timeout": 300, "max_turns": 10},
        }

        if stage_name in self.stages:
            return self.stages[stage_name]

        return StageTimeoutConfig(**default_timeouts.get(stage_name, {}))

    def get_agent_for_stage(self, stage_name: str) -> str:
        """Get the agent backend name for a specific stage."""
        if stage_name in self.agent.stages:
            return self.agent.stages[stage_name]
        return self.agent.default


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
